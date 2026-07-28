import { ipcMain } from 'electron'
import { CH } from '../shared/ipc'
import { readTextFile } from './fileread'

export function registerFileReadHandlers(): void {
  ipcMain.handle(CH.fsRead, (_e, path: string) => readTextFile(path))
}
