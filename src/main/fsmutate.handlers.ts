import { ipcMain } from 'electron'
import { CH } from '../shared/ipc'
import { rename, mkdir, newFile, copy, move } from './fsmutate'

export function registerFsMutateHandlers() {
  ipcMain.handle(CH.fsRename, (_e, from: string, to: string) => rename(from, to))
  ipcMain.handle(CH.fsMkdir, (_e, path: string) => mkdir(path))
  ipcMain.handle(CH.fsNewFile, (_e, path: string) => newFile(path))
  ipcMain.handle(CH.fsCopy, (_e, src: string, destDir: string) => copy(src, destDir))
  ipcMain.handle(CH.fsMove, (_e, src: string, destDir: string) => move(src, destDir))
}
