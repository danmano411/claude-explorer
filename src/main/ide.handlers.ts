import { ipcMain } from 'electron'
import { CH } from '../shared/ipc'
import { openInIde } from './ide'

export function registerIdeHandlers() {
  ipcMain.handle(CH.ideOpen, (_e, path: string) => openInIde(path))
}
