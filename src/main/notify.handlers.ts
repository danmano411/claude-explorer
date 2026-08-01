import { ipcMain, BrowserWindow } from 'electron'
import { CH } from '../shared/ipc'

/**
 * KAN-79. The main-side half of a toast click: bring the one window forward.
 * Same restore()-then-show()-then-focus() shape as the second-instance
 * handler in index.ts, for the same reason — `focus()` alone does not
 * reliably un-minimize on Windows. The tab switch itself happens in the
 * renderer, which already has everything (space id, tab id) the click needs;
 * this is the one piece only main can do.
 */
export function registerNotifyHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.on(CH.notifyFocusWindow, () => {
    const win = getWindow()
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
}
