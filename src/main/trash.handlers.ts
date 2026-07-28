import { ipcMain, shell } from 'electron'
import { rm } from 'node:fs/promises'
import { CH } from '../shared/ipc'
import type { OpResult, TrashRecord } from '../shared/types'
import { trashItems, restoreAndUntrack } from './trash'
import { gate } from './policy'
import { blocked } from './fsmutate.handlers'
import { getSettings } from './settings'
import { humanizeFsError } from './fs'

export function registerTrashHandlers() {
  ipcMain.handle(
    CH.fsDelete,
    async (
      _e,
      paths: string[],
      opts?: { permanent?: boolean; confirm?: string },
    ): Promise<OpResult<TrashRecord[]>> => {
      const op = opts?.permanent ? 'permanentDelete' : 'delete'
      const v = gate(op, paths, getSettings().mode, opts?.confirm)
      if (v) return blocked(v)
      try {
        if (opts?.permanent) {
          // Bypasses staging entirely: no TrashRecord, so no undo entry. Try the
          // Recycle Bin first so the OS still has a copy; fall back to a hard rm.
          for (const p of paths) {
            try {
              await shell.trashItem(p)
            } catch {
              await rm(p, { recursive: true, force: true })
            }
          }
          return { ok: true, value: [] }
        }
        return { ok: true, value: await trashItems(paths) }
      } catch (err) {
        return { ok: false, code: 'ERROR', reason: humanizeFsError(err) }
      }
    },
  )
  ipcMain.handle(CH.fsRestore, (_e, records) => restoreAndUntrack(records))
}
