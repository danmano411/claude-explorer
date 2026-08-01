import { ipcMain, app } from 'electron'
import { access } from 'node:fs/promises'
import { CH } from '../shared/ipc'
import { listDir } from './fs'
import { sameVolume } from './volume'

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
  // KAN-89. The renderer's move-vs-copy drop decision: on Windows this is a
  // string compare main could have shipped to the renderer, but on POSIX it is
  // an st_dev compare and only main has fs. Non-string arguments answer false
  // (= copy, which keeps the source) rather than reaching stat with them.
  ipcMain.handle(CH.sameVolume, async (_e, a: string, b: string) => {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false
    return sameVolume(a, b)
  })
}
