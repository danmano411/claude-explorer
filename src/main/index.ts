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
import { registerFileReadHandlers } from './fileread.handlers'
import { registerGitHandlers } from './git.handlers'
import { buildMenu } from './menu'
import { initUpdater } from './updater'
import { registerSearchHandlers } from './search.handlers'
import { registerWorkspaceHandlers } from './workspace.handlers'
import { flushAll, sweep, takePendingTrashWarn } from './trash'
import { CH } from '../shared/ipc'

let mainWindow: BrowserWindow | null = null
let flushed = false
let stopSearch: () => void = () => {}
// KAN-32: sweep() (below) runs before this window exists, so a warning from
// that startup retry has nobody to send to yet. Gate delivery on the window
// actually being loaded rather than just created; whichever of
// did-finish-load / sweep() finishes second is the one that finds something
// to send — no queue, just this flag plus trash.ts's own pending value.
let windowReady = false

function sendPendingTrashWarn(): void {
  if (!windowReady) return
  const warn = takePendingTrashWarn()
  if (warn) mainWindow?.webContents.send(CH.trashWarn, warn)
}

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
  mainWindow.webContents.once('did-finish-load', () => {
    windowReady = true
    sendPendingTrashWarn()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // Before anything can delete: flush staging buckets orphaned by an unclean
  // exit to the Recycle Bin. Running this later would trash items that are
  // still on THIS run's undo stack. D-1.
  void sweep().then(sendPendingTrashWarn)
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
  registerFileReadHandlers()
  // Was never called: git:status and git:diff had a CH entry, an Api method and
  // a preload binding, but no live handler — so the whole M2 diff surface did
  // nothing in a real build. Same class as fs:exists (KAN-30), and found by the
  // parity test below on its first run.
  registerGitHandlers()
  stopSearch = registerSearchHandlers(() => mainWindow)
  registerWorkspaceHandlers()
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
  stopSearch() // a ripgrep child must not outlive the window that asked for it
  if (flushed) return
  e.preventDefault()
  flushed = true
  flushAll().finally(() => app.quit())
})
