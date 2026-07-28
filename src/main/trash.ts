import { rename, mkdir, readdir, cp, rm } from 'node:fs/promises'
import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app, shell } from 'electron'
import type { TrashRecord } from '../shared/types'
import { driveKey, uniqueName, winBasename, winDirname } from '../shared/pathutil'

/** rename, with a copy+delete fallback when src and dst sit on different volumes.
 *  Staging and restoring MUST use the same move, or we can create deletes we are
 *  structurally unable to undo. */
async function move(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await cp(from, to, { recursive: true })
    await rm(from, { recursive: true, force: true })
  }
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
    records.push({ original, staged, name })
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
  }
}

// Electron-facing wrappers (not unit-tested; verified at e2e).
/** Exported for tests. "C:\" for local, "\\\\server\\share" for UNC. */
export function driveRootOf(p: string): string {
  const key = driveKey(p)
  return key.startsWith('\\\\') ? key : key.toUpperCase() + '\\'
}

function trashRootFor(p: string): string {
  try {
    const root = driveRootOf(p)
    accessSync(root, constants.W_OK)
    return join(root, '.claude-explorer-trash')
  } catch {
    // ponytail: falls back to userData when the volume root is unwritable
    // (read-only share, locked-down drive). This can be a different volume,
    // which is why move() handles EXDEV above.
    return join(app.getPath('userData'), 'trash')
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

export async function flush(records: TrashRecord[]): Promise<void> {
  for (const r of records) {
    try { await shell.trashItem(r.staged) } catch { /* best effort */ }
  }
  untrack(records)
}

export async function flushAll(): Promise<void> { await flush([...live]) }

// Thin wrapper the handler uses so restored items leave the registry.
export async function restoreAndUntrack(records: TrashRecord[]): Promise<void> {
  await restore(records)
  untrack(records)
}
