import { ipcMain, app } from 'electron'
import { access } from 'node:fs/promises'
import { CH } from '../shared/ipc'
import { listDir } from './fs'

export function registerFsHandlers(): void {
  ipcMain.handle(CH.fsList, (_e, path: string) => listDir(path))
  ipcMain.handle(CH.fsHome, () => app.getPath('home'))
  // Read-only existence probe for the address bar. It had a CH constant, an Api
  // method and a preload binding but no handler, so every call rejected with
  // "No handler registered for 'fs:exists'" — which meant typing a path into
  // the address bar never navigated. Invisible until KAN-24 made that bar
  // reachable at all. Resolves false rather than throwing: "does not exist" and
  // "cannot be reached" are the same answer to the only caller.
  ipcMain.handle(CH.fsExists, async (_e, path: string) => {
    if (typeof path !== 'string' || !path) return false
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  })
}
