import { Menu, BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { CH } from '../shared/ipc'

// Menu items that need renderer state (tabs, settings modal) post a command to
// the focused window; the renderer subscribes via window.api.onMenuCommand.
function send(cmd: string) {
  const w = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  w?.webContents.send(CH.menuCommand, cmd)
}

export function buildMenu() {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => send('new-tab') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => send('close-tab') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }],
    },
    {
      label: 'Settings',
      submenu: [
        { label: 'Preferences…', accelerator: 'CmdOrCtrl+,', click: () => send('open-settings') },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
