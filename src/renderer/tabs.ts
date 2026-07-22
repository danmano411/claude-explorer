export interface Tab {
  id: string
  view: 'files' | 'terminal'
  cwd: string
  ptyId?: string
  title: string
  terminalKind?: 'claude' | 'shell' // set when view === 'terminal'
  renamed?: boolean // user set a custom title; suppress auto-title-on-navigate
}

const base = (cwd: string) => cwd.split(/[\\/]/).pop() || cwd

export function newFilesTab(cwd: string): Tab {
  return { id: crypto.randomUUID(), view: 'files', cwd, title: base(cwd) }
}

export function newTerminalTab(
  cwd: string, kind: 'claude' | 'shell', ptyId: string, title: string,
): Tab {
  return { id: crypto.randomUUID(), view: 'terminal', cwd, ptyId, terminalKind: kind, title }
}
