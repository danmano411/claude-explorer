export interface Tab {
  id: string;
  view: 'files' | 'terminal';
  cwd: string;
  ptyId?: string;
  title: string;
}

export function newFilesTab(cwd: string): Tab {
  return { id: crypto.randomUUID(), view: 'files', cwd, title: cwd.split(/[\\/]/).pop() || cwd };
}
