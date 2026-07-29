import { winBasename, winDirname } from '../shared/pathutil'
import type { PersistedTab, TabView } from '../shared/types'

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

export function toPersisted(t: Tab): PersistedTab {
  return {
    id: t.id,
    view: t.view,
    cwd: t.cwd,
    title: t.title,
    renamed: t.renamed,
    terminalKind: t.terminalKind,
    filePath: t.filePath,
    viewerMode: t.viewerMode,
  }
}

/**
 * null when the tab cannot be brought back.
 *
 * A terminal tab's ptyId is a handle to a process that died with the last run,
 * so restoring one would put a dead pane on screen. Claude tabs could instead
 * resume their session (sessions.ts already has the ids), but whether that
 * should happen automatically at launch — spawning N claude processes before
 * the user asks — is a product decision, not a technical one. Skipped until
 * that is answered rather than guessed at.
 */
export function fromPersisted(p: PersistedTab): Tab | null {
  if (p.view === 'terminal') return null
  return {
    id: p.id,
    view: p.view,
    cwd: p.cwd,
    title: p.title,
    renamed: p.renamed,
    filePath: p.filePath,
    viewerMode: p.viewerMode,
  }
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
