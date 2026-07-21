import { rename, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app, shell } from 'electron'
import type { TrashRecord } from '../shared/types'
import { uniqueName, winBasename, winDirname } from '../shared/pathutil'

// Test-friendly core: stage into an explicit root (no Electron dependency).
export async function stageInto(trashRoot: string, paths: string[]): Promise<TrashRecord[]> {
  const records: TrashRecord[] = []
  for (const original of paths) {
    const bucket = join(trashRoot, randomUUID())
    await mkdir(bucket, { recursive: true })
    const name = winBasename(original)
    const staged = join(bucket, name)
    await rename(original, staged)
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
function driveRoot(p: string): string { return p.slice(0, 2) + '\\' } // "C:\"
function trashRootFor(p: string): string {
  try { return join(driveRoot(p), '.claude-explorer-trash') }
  catch { return join(app.getPath('userData'), 'trash') }
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
