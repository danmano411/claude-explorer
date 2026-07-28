import { ipcMain, shell } from 'electron'
import { rm } from 'node:fs/promises'
import { CH } from '../shared/ipc'
import type { OpResult, TrashRecord } from '../shared/types'
import { trashItems, restoreAndUntrack } from './trash'
import { classify, gate } from './policy'
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
  ipcMain.handle(
    CH.fsRestore,
    async (_e, records: TrashRecord[], confirm?: string): Promise<OpResult<void>> => {
      // Restore is a rename of caller-supplied paths, i.e. a move: gate it as one.
      // The destination (r.original) is what matters and is always gated. The
      // source is gated too, EXCEPT when it is a trash-staging path — reading out
      // of .claude-explorer-trash is the one legitimate case, and classify()
      // denies that path in both modes, so gating it would break Ctrl+Z entirely.
      const paths = records.flatMap((r) =>
        classify(r.staged) === 'trash' ? [r.original] : [r.original, r.staged],
      )
      const v = gate('move', paths, getSettings().mode, confirm)
      if (v) return blocked(v)
      try {
        await restoreAndUntrack(records)
        return { ok: true, value: undefined }
      } catch (err) {
        return { ok: false, code: 'ERROR', reason: humanizeFsError(err) }
      }
    },
  )
}
