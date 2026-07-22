import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { registerFsHandlers } from './fs.handlers'
import { registerRecentsHandlers } from './recents.handlers'
import { registerSessionsHandlers } from './sessions.handlers'
import { registerExternalHandlers } from './external.handlers'
import { registerPtyHandlers } from './pty.handlers'
import { registerFsMutateHandlers } from './fsmutate.handlers'
import { registerTrashHandlers } from './trash.handlers'
import { registerOpenHandlers } from './open.handlers'
import { registerSettingsHandlers } from './settings.handlers'
import { registerIdeHandlers } from './ide.handlers'
import { buildMenu } from './menu'
import { initUpdater } from './updater'
import { flushAll } from './trash'

let mainWindow: BrowserWindow | null = null
let flushed = false

const iconPath = app.isPackaged
  ? join(process.resourcesPath, 'icon.png')
  : join(__dirname, '../../img/icon.png')

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    show: false,
    backgroundColor: '#F5F1E8',
    icon: iconPath,
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
  registerFsMutateHandlers()
  registerTrashHandlers()
  registerOpenHandlers()
  registerSettingsHandlers()
  registerIdeHandlers()
  buildMenu()
  createWindow()
  initUpdater()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Flush any still-staged deleted items to the OS Recycle Bin before exit.
app.on('will-quit', (e) => {
  if (flushed) return
  e.preventDefault()
  flushed = true
  flushAll().finally(() => app.quit())
})
