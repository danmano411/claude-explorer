import { ipcMain } from 'electron'
import { CH } from '../shared/ipc'
import { openPath, revealPath } from './open'
export function registerOpenHandlers() {
  ipcMain.handle(CH.openPath, (_e, p: string) => openPath(p))
  ipcMain.handle(CH.revealPath, (_e, p: string) => { revealPath(p) })
}
