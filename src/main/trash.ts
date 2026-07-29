import { rename, mkdir, readdir, readFile, writeFile, cp, rm } from 'node:fs/promises'
import { accessSync, constants, readFileSync, writeFileSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app, shell } from 'electron'
import type { TrashRecord, TrashWarn } from '../shared/types'
import { driveKey, uniqueName, winBasename, winDirname } from '../shared/pathutil'

/** rename, with a copy+delete fallback when src and dst sit on different volumes.
 *  Staging and restoring MUST use the same move, or we can create deletes we are
 *  structurally unable to undo.
 *  preserveTimestamps keeps a cross-volume delete+undo round trip from rewriting
 *  metadata that a same-volume rename leaves alone.
 *  ponytail: fs.cp still drops alternate data streams, ACLs and directory
 *  timestamps — inherent to a read+write copy. Upgrade path if that ever
 *  matters: `robocopy /COPYALL /DCOPY:DAT`, the only no-new-dependency way. */
async function move(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await cp(from, to, { recursive: true, preserveTimestamps: true })
    await rm(from, { recursive: true, force: true })
  }
}

// A bucket is <trashRoot>/<uuid>/ holding exactly the staged item; its manifest
// is the sibling file <trashRoot>/<uuid>.json. Beside the bucket rather than
// inside it so the bucket stays single-item and flush can hand THAT item — not
// an opaque uuid folder — to the Recycle Bin.
const manifestOf = (bucket: string) => bucket + '.json'
const bucketOf = (staged: string) => winDirname(staged)

async function readManifest(bucket: string): Promise<TrashRecord | null> {
  try {
    return JSON.parse(await readFile(manifestOf(bucket), 'utf8')) as TrashRecord
  } catch {
    return null // older build, or a manifest we failed to write
  }
}

/** Remove an emptied bucket and its manifest. Only ever called once the staged
 *  item has been restored or accepted by the Recycle Bin. */
async function discard(bucket: string): Promise<void> {
  await rm(bucket, { recursive: true, force: true })
  await rm(manifestOf(bucket), { force: true })
}

// Test-friendly core: stage into an explicit root (no Electron dependency).
export async function stageInto(trashRoot: string, paths: string[]): Promise<TrashRecord[]> {
  const records: TrashRecord[] = []
  for (const original of paths) {
    const bucket = join(trashRoot, randomUUID())
    await mkdir(bucket, { recursive: true })
    const name = winBasename(original)
    const staged = join(bucket, name)
    await move(original, staged)
    const record = { original, staged, name }
    // The in-memory registry dies with the process; this does not. Best effort:
    // a delete that worked must not fail because the manifest would not write.
    try { await writeFile(manifestOf(bucket), JSON.stringify(record), 'utf8') } catch { /* sweep still finds the bucket, just not where it came from */ }
    records.push(record)
  }
  return records
}

export async function restore(records: TrashRecord[]): Promise<void> {
  for (const r of records) {
    const dir = winDirname(r.original)
    let names: string[] = []
    try {
      names = await readdir(dir)
    } catch (err) {
      // ENOENT is the only case where an empty listing is the truth. On
      // EACCES/EPERM/EMFILE the directory exists and we merely cannot see it —
      // guessing "empty" makes uniqueName a no-op and the move silently
      // clobbers whatever now holds that name.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    await move(r.staged, join(dir, uniqueName(names, r.name)))
    await discard(bucketOf(r.staged))
  }
}

// Electron-facing wrappers (not unit-tested; verified at e2e).
/** Exported for tests. "C:\" for local, "\\\\server\\share" for UNC. */
export function driveRootOf(p: string): string {
  const key = driveKey(p)
  return key.startsWith('\\\\') ? key : key.toUpperCase() + '\\'
}

// A bucket lives at the root of whichever volume the deleted file was on, so a
// fresh process has nothing to derive that from. Record the roots we use.
// (Not a drive-letter probe: stat'ing a disconnected mapped drive can stall the
// libuv threadpool for the whole SMB timeout.) Losing a write here only delays
// a sweep to the next delete on that volume, so it is best effort throughout.
const rootsIndex = () => join(app.getPath('userData'), 'trash-roots.json')

function knownRoots(): string[] {
  try {
    const v: unknown = JSON.parse(readFileSync(rootsIndex(), 'utf8'))
    return Array.isArray(v) ? (v as string[]) : []
  } catch {
    return []
  }
}

function rememberRoot(root: string): string {
  const roots = knownRoots()
  if (!roots.includes(root)) {
    try { writeFileSync(rootsIndex(), JSON.stringify([...roots, root])) } catch { /* best effort */ }
  }
  return root
}

function trashRootFor(p: string): string {
  try {
    const root = driveRootOf(p)
    accessSync(root, constants.W_OK)
    return rememberRoot(join(root, '.claude-explorer-trash'))
  } catch {
    // ponytail: falls back to userData when the volume root is unwritable
    // (read-only share, locked-down drive). This can be a different volume,
    // which is why move() handles EXDEV above.
    return rememberRoot(join(app.getPath('userData'), 'trash'))
  }
}

// Module registry of still-staged records so main can flush on quit without an
// extra IPC round-trip. Appended on delete, removed on restore/flush.
const live: TrashRecord[] = []

export async function trashItems(paths: string[]): Promise<TrashRecord[]> {
  const out: TrashRecord[] = []
  try {
    for (const p of paths) out.push(...await stageInto(trashRootFor(p), [p]))
  } catch (err) {
    // All-or-nothing: the caller reports "delete failed" and cannot carry a
    // partial record list back through OpResult, so put everything back and let
    // that message be the truth. Anything that refuses to go back stays
    // registered, so quit-flush can still hand it to the Recycle Bin.
    const stuck: TrashRecord[] = []
    for (const r of out) {
      try { await restore([r]) } catch { stuck.push(r) }
    }
    live.push(...stuck)
    throw err
  }
  live.push(...out)
  return out
}

// Records arriving over IPC are structured-clone copies, so indexOf's reference
// equality never matched them and nothing was ever untracked. Key on the staged
// path instead — it is a fresh uuid bucket per item, so it is unique.
function untrack(records: TrashRecord[]): void {
  const staged = new Set(records.map((r) => r.staged))
  for (let i = live.length - 1; i >= 0; i--) {
    if (staged.has(live[i].staged)) live.splice(i, 1)
  }
}

// KAN-32: the data side (keep the record so a later sweep retries it) was
// fixed by D-2 above; this is the user-facing side. Held here rather than
// passed back through flush()'s return value because sweep() runs at startup,
// before any window (or renderer listener) exists — main/index.ts reads and
// clears this once it is actually safe to send. One value, not a queue: a
// second failure before the first is read simply overwrites it (coalesced,
// not accumulated) — the user only needs "your stuff is still safe", not a
// running tally of every retry.
let pendingTrashWarn: TrashWarn | null = null

/** Pure: what to tell the user about a batch of staged items that would not
 *  go to the Recycle Bin. `volume` is the drive/share the items were
 *  originally deleted FROM (not the internal staging path) — that is what the
 *  user recognises. Omitted when the batch spans more than one volume. */
function describeStuck(stuck: TrashRecord[]): TrashWarn | null {
  if (!stuck.length) return null
  const volumes = new Set(stuck.map((r) => driveRootOf(r.original)))
  return { count: stuck.length, volume: volumes.size === 1 ? [...volumes][0] : null }
}

/** main/index.ts calls this once the renderer is confirmed listening
 *  (webContents 'did-finish-load'). Returns null, and clears, on every call
 *  after the first — so a slow renderer can poll it harmlessly. */
export function takePendingTrashWarn(): TrashWarn | null {
  const w = pendingTrashWarn
  pendingTrashWarn = null
  return w
}

/** Hand staged items to the Recycle Bin. Returns the ones that would not go —
 *  a volume with no Recycle Bin (network share, removable) rejects trashItem.
 *  Those keep BOTH their record and their manifest: dropping the record anyway
 *  is what leaked one staging bucket per delete, forever, unannounced. */
export async function flush(records: TrashRecord[]): Promise<TrashRecord[]> {
  const stuck: TrashRecord[] = []
  const done: TrashRecord[] = []
  for (const r of records) {
    try {
      await shell.trashItem(r.staged)
    } catch {
      stuck.push(r)
      continue
    }
    done.push(r)
    // Separate: the item IS in the Recycle Bin now, so a bucket we cannot
    // remove is a leftover for the next sweep, not a failed flush.
    await discard(bucketOf(r.staged)).catch(() => {})
  }
  untrack(done)
  pendingTrashWarn = describeStuck(stuck)
  if (stuck.length) {
    console.warn(
      `[trash] ${stuck.length} item(s) could not reach the Recycle Bin and are still staged; the next startup sweep retries them:`,
      stuck.map((r) => r.staged),
    )
  }
  return stuck
}

export async function flushAll(): Promise<TrashRecord[]> { return flush([...live]) }

async function listDir(dir: string): Promise<string[]> {
  try { return await readdir(dir) } catch { return [] }
}

async function listDirents(dir: string): Promise<Dirent[]> {
  try { return await readdir(dir, { withFileTypes: true }) } catch { return [] }
}

/** Startup sweep. Anything still staged when the process starts was orphaned by
 *  an unclean exit: its undo entry died with that process, so the Recycle Bin is
 *  the only place left to put it — leaving it is worse, because policy.classify
 *  refuses to let the user move it back out through the app. Returns the
 *  original paths recovered (the bucket path when there is no manifest).
 *  ponytail: startup ONLY. Calling this after the first delete of a run would
 *  trash items still sitting on the undo stack. */
export async function sweep(roots: string[] = knownRoots()): Promise<string[]> {
  const recovered: string[] = []
  // Startup is the one moment the failure actually needs surfacing (see
  // pendingTrashWarn above): this retry has nothing else to fall back on.
  const stuck: TrashRecord[] = []
  for (const root of roots) {
    for (const entry of await listDirents(root)) {
      if (!entry.isDirectory()) continue // manifests are files; discard() pairs them
      const bucket = join(root, entry.name)
      const items = await listDir(bucket)
      const rec = await readManifest(bucket)
      let ok = true
      for (const item of items) {
        try { await shell.trashItem(join(bucket, item)) } catch { ok = false }
      }
      if (!ok) {
        // No manifest (older build orphan) still gets a usable fallback: the
        // bucket path is on the same volume as the item it holds.
        if (items.length) stuck.push(rec ?? { original: bucket, staged: bucket, name: entry.name })
        continue // leave it staged; the manifest keeps it retriable
      }
      await discard(bucket).catch(() => {}) // one stuck bucket must not abort the sweep
      if (items.length) recovered.push(rec?.original ?? bucket)
    }
  }
  if (recovered.length) {
    console.log(`[trash] swept ${recovered.length} orphaned item(s) to the Recycle Bin:`, recovered)
  }
  pendingTrashWarn = describeStuck(stuck)
  return recovered
}

// Thin wrapper the handler uses so restored items leave the registry.
export async function restoreAndUntrack(records: TrashRecord[]): Promise<void> {
  await restore(records)
  untrack(records)
}
