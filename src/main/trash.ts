import { rename, mkdir, readdir, cp, rm } from 'node:fs/promises'
import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app, shell } from 'electron'
import type { TrashRecord } from '../shared/types'
import { driveKey, uniqueName, winBasename, winDirname } from '../shared/pathutil'

// Test-friendly core: stage into an explicit root (no Electron dependency).
export async function stageInto(trashRoot: string, paths: string[]): Promise<TrashRecord[]> {
  const records: TrashRecord[] = []
  for (const original of paths) {
    const bucket = join(trashRoot, randomUUID())
    await mkdir(bucket, { recursive: true })
    const name = winBasename(original)
    const staged = join(bucket, name)
    try {
      await rename(original, staged)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
      await cp(original, staged, { recursive: true })
      await rm(original, { recursive: true, force: true })
    }
    records.push({ original, staged, name })
  }
  return records
}

export async function restore(records: TrashRecord[]): Promise<void> {
  for (const r of records) {
    const dir = winDirname(r.original)
    let names: string[] = []
    try { names = await readdir(dir) } catch { /* dir may be gone */ }
    const finalName = uniqueName(names, r.name)
    await rename(r.staged, join(dir, finalName))
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
    // which is why stageInto handles EXDEV above.
    return join(app.getPath('userData'), 'trash')
  }
}

// Module registry of still-staged records so main can flush on quit without an
// extra IPC round-trip. Appended on delete, removed on restore/flush.
const live: TrashRecord[] = []

export async function trashItems(paths: string[]): Promise<TrashRecord[]> {
  const out: TrashRecord[] = []
  for (const p of paths) out.push(...await stageInto(trashRootFor(p), [p]))
  live.push(...out)
  return out
}

export async function flush(records: TrashRecord[]): Promise<void> {
  for (const r of records) {
    try { await shell.trashItem(r.staged) } catch { /* best effort */ }
    const i = live.indexOf(r); if (i >= 0) live.splice(i, 1)
  }
}

export async function flushAll(): Promise<void> { await flush([...live]) }

// Thin wrapper the handler uses so restored items leave the registry.
export async function restoreAndUntrack(records: TrashRecord[]): Promise<void> {
  await restore(records)
  for (const r of records) {
    const i = live.indexOf(r); if (i >= 0) live.splice(i, 1)
  }
}
