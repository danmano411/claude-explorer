import { ipcMain } from 'electron'
import { CH } from '../shared/ipc'
import type { OpResult } from '../shared/types'
import { rename, mkdir, newFile, copy, move } from './fsmutate'
import { gate, type Op, type Verdict } from './policy'
import { getSettings } from './settings'
import { humanizeFsError } from './fs'
import { winDirname } from '../shared/pathutil'

/** Maps a blocking verdict to the wire type. `gate()` never yields 'allow' (it
 *  returns null instead), but `Verdict` includes it, so narrow explicitly. */
export function blocked(v: Verdict): OpResult<never> {
  if (v.kind === 'confirm')
    return { ok: false, code: 'NEEDS_CONFIRM', reason: v.reason, typed: v.typed }
  return { ok: false, code: 'DENIED', reason: v.kind === 'deny' ? v.reason : 'Operation blocked' }
}

/** Single wrapper so no handler can forget the gate. */
async function guarded<T>(
  op: Op,
  paths: string[],
  confirm: string | undefined,
  run: () => Promise<T>,
): Promise<OpResult<T>> {
  const v = await gate(op, paths, getSettings().mode, confirm)
  if (v) return blocked(v)
  try {
    return { ok: true, value: await run() }
  } catch (err) {
    return { ok: false, code: 'ERROR', reason: humanizeFsError(err) }
  }
}

export function registerFsMutateHandlers() {
  ipcMain.handle(CH.fsRename, (_e, from: string, to: string, confirm?: string) =>
    guarded('rename', [from, to], confirm, () => rename(from, to)),
  )
  // mkdir/newFile create INSIDE a directory, so the parent is what gets gated.
  ipcMain.handle(CH.fsMkdir, (_e, path: string, confirm?: string) =>
    guarded('mkdir', [winDirname(path)], confirm, () => mkdir(path)),
  )
  ipcMain.handle(CH.fsNewFile, (_e, path: string, confirm?: string) =>
    guarded('newFile', [winDirname(path)], confirm, () => newFile(path)),
  )
  ipcMain.handle(CH.fsCopy, (_e, src: string, destDir: string, confirm?: string) =>
    guarded('copy', [destDir], confirm, () => copy(src, destDir)),
  )
  // move both removes from src and writes to dest — gate both.
  ipcMain.handle(CH.fsMove, (_e, src: string, destDir: string, confirm?: string) =>
    guarded('move', [src, destDir], confirm, () => move(src, destDir)),
  )
}
