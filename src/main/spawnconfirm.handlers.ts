import { ipcMain, BrowserWindow } from 'electron'
import { CH } from '../shared/ipc'
import type { SpawnConfirmRequest } from '../shared/types'

/**
 * KAN-41 electron glue for the spawn confirmation, the same two-file split as
 * control.handlers.ts: every rule about tokens, expiry and the cap lives in
 * ./spawnguard, and this file is only the two IPC edges.
 *
 * The answer function is passed IN rather than imported from ./mcp, so this
 * stays a leaf and there is no cycle between the guard's owner and its glue.
 */

let getWin: () => BrowserWindow | null = () => null

export function registerSpawnConfirmHandlers(
  getWindow: () => BrowserWindow | null,
  onAnswer: (token: string, allow: boolean) => void,
): void {
  getWin = getWindow
  ipcMain.on(CH.spawnConfirmAnswer, (_e, token: string, allow: boolean) => onAnswer(token, allow))
}

/** `false` when there is no window: the caller must refuse rather than mint a
 *  token nobody can ever answer. isDestroyed() as well as null, because a send
 *  on a dead webContents throws. */
export function promptSpawnConfirm(req: SpawnConfirmRequest): boolean {
  const win = getWin()
  if (!win || win.isDestroyed()) return false
  win.webContents.send(CH.spawnConfirm, req)
  return true
}
