import { winBasename, winDirname } from '../shared/pathutil'
import type { TabView } from '../shared/types'

export interface Tab {
  id: string
  view: TabView
  cwd: string // folder the tab acts on; for a viewer tab, the file's parent dir
  ptyId?: string
  title: string
  terminalKind?: 'claude' | 'shell' // set when view === 'terminal'
  filePath?: string // absolute file being viewed; set when view === 'viewer'
  viewerMode?: 'file' | 'diff' // 'file' -> fsRead, 'diff' -> gitDiff; set when view === 'viewer'
  renamed?: boolean // user set a custom title; suppress auto-title-on-navigate
}

export function newFilesTab(cwd: string): Tab {
  return { id: crypto.randomUUID(), view: 'files', cwd, title: winBasename(cwd) }
}

export function newTerminalTab(
  cwd: string, kind: 'claude' | 'shell', ptyId: string, title: string,
): Tab {
  return { id: crypto.randomUUID(), view: 'terminal', cwd, ptyId, terminalKind: kind, title }
}

/** Read-only viewer tab. cwd is the containing folder so the tab context menu
 *  (Open in Explorer / Terminal / IDE) keeps working exactly as on a files tab. */
export function newViewerTab(filePath: string, mode: 'file' | 'diff' = 'file'): Tab {
  return {
    id: crypto.randomUUID(),
    view: 'viewer',
    cwd: winDirname(filePath),
    filePath,
    viewerMode: mode,
    title: winBasename(filePath),
  }
}
