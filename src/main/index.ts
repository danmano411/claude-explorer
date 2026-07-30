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
import { buildMenu, buildMenuThrottled } from './menu'
import { initUpdater } from './updater'
import { registerSearchHandlers } from './search.handlers'
import { registerWorkspaceHandlers } from './workspace.handlers'
import { flushAll, sweep, takePendingTrashWarn } from './trash'
import { parseCliArgs, resolveCliIntent, type CliTarget } from './cli'
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

// A path handed to us on the command line (or by the Explorer context menu),
// waiting for a renderer to exist. webContents.send before the renderer
// subscribes is simply lost, and cold start is exactly that race.
//
// ponytail: one pending slot, not a queue. Two --open flags in one launch is
// one tab, and a second-instance arriving mid-load overwrites an unsent first.
// Make it an array when someone actually scripts a batch open.
let pendingCli: CliTarget | null = null

// Same one-shot trick as sendPendingTrashWarn: whichever of did-finish-load and
// the argv parse happens second is the one that finds something to send.
function sendPendingCli(): void {
  if (!windowReady || !pendingCli) return
  mainWindow?.webContents.send(CH.menuCommand, pendingCli.cmd, pendingCli.path)
  pendingCli = null
}

const iconPath = app.isPackaged
  ? join(process.resourcesPath, 'icon.png')
  : join(__dirname, '../../img/icon.png')

// A second launch is not a second app: it forwards its path into this one.
// This also closes a pre-existing hazard. sweep() (whenReady, below) flushes
// orphaned trash staging to the Recycle Bin, and its own comment says running
// it at the wrong time "would trash items that are still on THIS run's undo
// stack" (D-1). Two live instances did exactly that: instance 2's sweep()
// walked instance 1's staging dir. The lock is the fix.
//
// Acquired unconditionally, NOT gated on app.isPackaged: the lock is keyed on
// the userData dir, which differs between an unpackaged run (`name`) and an
// installed one (`productName`), so dev and installed never fight — and gating
// would make forwarding unreachable from the Playwright harness, which runs the
// unpackaged out/main/index.js.
//
// app.exit(0), NOT app.quit(): quit fires 'will-quit' (below), whose handler
// calls flushAll() — the loser must never touch the owner's staging dir.
//
// The payload is this process's VERBATIM argv, and it is load-bearing.
// second-instance's own `argv` argument is not the second instance's command
// line: Chromium regroups it into [program, ...switches, ...loose args] and
// injects switches of its own, so `--open C:\repo` arrives as a bare `--open`
// followed by an unrelated switch, with the path shuffled to the end. Observed
// on Windows, and documented by Electron itself — "the order might change and
// additional arguments might be appended... it's advised to use additionalData
// instead". additionalData is forwarded as JSON and left alone, so the flag and
// its value stay adjacent and one parser handles both launch paths.
if (!app.requestSingleInstanceLock({ argv: process.argv, cwd: process.cwd() })) app.exit(0)

app.on('second-instance', (_e, _argv, workingDirectory, data) => {
  // JSON from another local process, so exactly as untrusted as a command line:
  // shape-check it here and let resolveCliIntent do the real validation. There
  // is deliberately no fallback to the canonicalised `_argv` — its tokens no
  // longer line up with the flags, so guessing from it is worse than no-op.
  const d = (data ?? {}) as { argv?: unknown; cwd?: unknown }
  const argv = Array.isArray(d.argv) ? d.argv.filter((a): a is string => typeof a === 'string') : []
  const cwd = typeof d.cwd === 'string' ? d.cwd : workingDirectory
  pendingCli = resolveCliIntent(parseCliArgs(argv, cwd))
  sendPendingCli()
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

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
  // Without this, mainWindow stays a truthy-but-destroyed BrowserWindow after
  // the user closes it, for as long as will-quit's flushAll() keeps the
  // process alive. second-instance / sendPendingCli / registerPtyHandlers'
  // and registerSearchHandlers' getWindow() callbacks all read the same
  // global; every one of them already guards with `?.` or `if (mainWindow)`,
  // which only works when null actually means null.
  mainWindow.on('closed', () => { mainWindow = null })
  // ponytail: this closes the throw, not the underlying hang — while the
  // primary is alive-but-windowless (mid-flushAll, or a throw before
  // createWindow()), the lock is still held and a new launch's
  // requestSingleInstanceLock() fails, so it app.exit(0)s with nothing to
  // show. The app is unlaunchable until the zombie process is killed. Accepted
  // per review; recreate the window on second-instance-with-no-mainWindow if
  // this is ever reported for real.
  mainWindow.webContents.once('did-finish-load', () => {
    windowReady = true
    sendPendingTrashWarn()
    sendPendingCli()
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
  // Async since KAN-55 — File > Open Recent now lists each recent folder's
  // Claude sessions, and a native menu template is built ahead of the click.
  // Not awaited: the window must not wait on a session-directory scan, and
  // Electron shows no menu at all until this resolves (a few ms later).
  void buildMenu()
  // Sessions grow while the app runs and nothing tells us; a window taking
  // focus is the one signal that the user may have been elsewhere. Throttled
  // inside menu.ts because this fires on every alt-tab.
  app.on('browser-window-focus', () => buildMenuThrottled())
  // Parsed here, but sweep() above is fire-and-forget (`void sweep().then(...)`)
  // and did-finish-load routinely fires before it settles, so this can in fact
  // land before sweep() finishes. That is harmless: opening a tab pushes
  // nothing onto the undo stack, which is the only thing D-1 cares about.
  pendingCli = resolveCliIntent(parseCliArgs(process.argv, process.cwd()))
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
