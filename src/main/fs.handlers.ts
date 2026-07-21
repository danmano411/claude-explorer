import { ipcMain, app } from 'electron'
import { CH } from '../shared/ipc'
import { listDir } from './fs'

export function registerFsHandlers(): void {
  ipcMain.handle(CH.fsList, (_e, path: string) => listDir(path))
  ipcMain.handle(CH.fsHome, () => app.getPath('home'))
}
