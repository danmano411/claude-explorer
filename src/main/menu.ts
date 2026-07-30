import { Menu, BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { CH } from '../shared/ipc'
import { listRecents } from './recents'
import { listSessions } from './sessions'
import type { ClaudeSession } from '../shared/types'

// Menu items that need renderer state (tabs, settings modal) post a command to
// the focused window; the renderer subscribes via window.api.onMenuCommand.
function target(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

function send(cmd: string, path?: string) {
  target()?.webContents.send(CH.menuCommand, cmd, path)
}

/**
 * Open Recent's session rows ride their OWN channel, and that is a security
 * boundary, not tidiness. menu:command is reachable from argv — index.ts's
 * sendPendingCli() forwards a CLI-supplied path down it, and any local process
 * can say `"Claude Explorer.exe" --open <path>` with no authentication at all.
 * These rows SPAWN Claude Code in the named folder, which inherits the user's
 * own config (hooks, .mcp.json, CLAUDE.md) at the user's privilege. Keeping the
 * spawn on a channel that only this file ever sends keeps "no spawn from argv"
 * structural rather than a check someone can delete. See main/cli.ts:81-110.
 */
function sendSession(path: string, resumeId?: string) {
  target()?.webContents.send(CH.menuSession, path, resumeId)
}

/**
 * Compact relative time for a menu row: "just now", "9m ago", "2h ago",
 * "yesterday", "3d ago", then a plain date. (Was src/renderer/filemenu.ts,
 * moved here with the menu itself in KAN-55.)
 *
 * Hand-rolled rather than Intl.RelativeTimeFormat: that produces "2 hours ago"
 * / "3 days ago", which is twice the width in a label that has to share a row
 * with an ellipsized session title.
 */
export function relTime(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d === 1) return 'yesterday'
  if (d < 7) return `${d}d ago`
  return new Date(ms).toLocaleDateString()
}

/** Windows eats a single `&` in a menu label as a mnemonic marker, and both a
 *  path (`C:\a&b`) and a session title ("fix a && b") can contain one. */
const amp = (s: string) => s.replace(/&/g, '&&')

const TITLE_MAX = 48
const ellipsize = (s: string, max = TITLE_MAX) =>
  s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`

/** One recent folder plus the sessions to list under it. */
export interface FolderSessions {
  path: string
  sessions: ClaudeSession[]
}

/**
 * What a File-menu item does. Two arms because there are two CHANNELS, and the
 * split between them is the security boundary described on sendSession above —
 * injecting them keeps the template builder below pure (and unit-testable with
 * no Electron), without letting a folder row reach the spawning channel by
 * accident.
 */
export interface FileMenuActions {
  /** menu:command — navigation and window commands. CLI-reachable by design. */
  command: (cmd: string, path?: string) => void
  /** menu:session — spawns Claude Code. Sent ONLY from this file. */
  session: (path: string, resumeId?: string) => void
}

/**
 * The File submenu, built from data. Pure: no Electron, no disk, no clock
 * (`now` is injected), so the whole tree is unit-testable by calling the
 * `click` of a template node and asserting which action fired.
 *
 *   File
 *     New Tab            Ctrl+T
 *     Close Tab          Ctrl+W
 *     ---
 *     Open Recent >  <folder path> >  + New session
 *                                     ---
 *                                     <session title>   2h ago
 *     ---
 *     Quit
 *
 * Electron menu templates are STATIC — there is no per-submenu lazy-open hook
 * on Windows, so every session of every recent folder is read before the user
 * has clicked anything. That is exactly why listSessions() caps at 20 and
 * memoises by path+mtime.
 *
 * ponytail: on Windows a submenu parent cannot be activated by a user click —
 * clicking `<folder path>` opens its submenu and never fires the handler below,
 * so the folder-open action is reachable from the harness (by id) but not from
 * a mouse. Give the folder submenu its own "Open Folder" row if that turns out
 * to matter; it is not in the tree the ticket froze.
 */
export function fileSubmenu(
  folders: FolderSessions[],
  actions: FileMenuActions,
  now = Date.now(),
): MenuItemConstructorOptions[] {
  const recents: MenuItemConstructorOptions[] =
    folders.length === 0
      ? [{ label: 'No recent folders', enabled: false }]
      : folders.map((f, i): MenuItemConstructorOptions => {
          const sessions: MenuItemConstructorOptions[] =
            f.sessions.length === 0
              ? [{ label: 'No sessions', enabled: false }]
              : f.sessions.map((s, j): MenuItemConstructorOptions => ({
                  id: `recent:${i}:session:${j}`,
                  label: amp(`${ellipsize(s.title)}   ${relTime(s.updated, now)}`),
                  click: () => actions.session(f.path, s.id),
                }))
          return {
            id: `recent:${i}`,
            label: amp(f.path),
            click: () => actions.command('open-path', f.path),
            submenu: [
              { id: `recent:${i}:new`, label: '+ New session', click: () => actions.session(f.path) },
              { type: 'separator' },
              ...sessions,
            ],
          }
        })

  return [
    { id: 'file:new-tab', label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => actions.command('new-tab') },
    { id: 'file:close-tab', label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => actions.command('close-tab') },
    { type: 'separator' },
    { label: 'Open Recent', submenu: recents },
    { type: 'separator' },
    { role: 'quit' },
  ]
}

// A rebuild reads every recent folder's session directory, so two of them can be
// in flight at once (a recents:add landing while a focus rebuild is mid-read).
// Whoever started last wins: an older read finishing second would install a menu
// built from staler data.
let generation = 0
let lastBuilt = 0

export async function buildMenu(): Promise<void> {
  const mine = ++generation
  const folders: FolderSessions[] = await Promise.all(
    listRecents().map(async (r) => ({ path: r.path, sessions: await listSessions(r.path) })),
  )
  if (mine !== generation) return
  lastBuilt = Date.now()
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: fileSubmenu(folders, { command: send, session: sendSession }),
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
        { type: 'separator' },
        {
          label: 'Toggle Developer Mode',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => send('toggle-mode'),
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * Refresh on window focus, at most once every 5s. Focus is the only signal we
 * get that sessions changed under us (a Claude tab appends to its jsonl the
 * whole time it runs, and nothing tells the main process), but it also fires on
 * every alt-tab. Leading edge and SKIP rather than defer: a skipped rebuild is
 * one stale timestamp for a few seconds, and the next focus picks it up — a
 * trailing timer would rebuild the menu while the user is in another app.
 */
export function buildMenuThrottled(): void {
  if (Date.now() - lastBuilt < 5000) return
  void buildMenu()
}
