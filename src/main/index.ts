import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { registerFsHandlers } from './fs.handlers'
import { registerRecentsHandlers } from './recents.handlers'
import { registerSessionsHandlers } from './sessions.handlers'
import { registerExternalHandlers } from './external.handlers'
import { registerPtyHandlers } from './pty.handlers'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    show: false,
    backgroundColor: '#F5F1E8',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs node-pty bindings reachable via main
    },
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerFsHandlers()
  registerRecentsHandlers()
  registerSessionsHandlers()
  registerExternalHandlers()
  registerPtyHandlers(() => mainWindow)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
