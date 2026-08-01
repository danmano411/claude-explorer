import { ipcMain, type BrowserWindow } from 'electron'
import { CH } from '../shared/ipc'
import { applyAttention } from './badge'

/**
 * KAN-78 electron glue. The renderer's `attentionNeeded()` (src/renderer/
 * attention.ts) already decided; this is only the one-way wire from that
 * decision to the OS call. Same shape as spawnconfirm.handlers.ts's
 * `registerSpawnConfirmHandlers`: `getWindow` passed in rather than a module
 * global, so this stays a leaf with no import cycle back to main/index.ts.
 */
export function registerBadgeHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.on(CH.setAttention, (_e, needsAttention: boolean) => {
    const win = getWindow()
    if (win) applyAttention(win, needsAttention)
  })
}
