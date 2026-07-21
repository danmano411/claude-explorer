import { ipcMain } from 'electron'
import { CH } from '../shared/ipc'
import { trashItems, restoreAndUntrack } from './trash'

export function registerTrashHandlers() {
  ipcMain.handle(CH.fsDelete, (_e, paths: string[]) => trashItems(paths))
  ipcMain.handle(CH.fsRestore, (_e, records) => restoreAndUntrack(records))
}
