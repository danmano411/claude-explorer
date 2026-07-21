import { useEffect, useState } from 'react';
import type { DirEntry } from '../../shared/types';
import { Breadcrumb } from './Breadcrumb';
import { ContextMenu, type MenuItem } from './ContextMenu';

export function FileBrowser({ cwd, onNavigate, onOpenClaude, onOpenExternal }: {
  cwd: string; onNavigate: (p: string) => void; onOpenClaude: (p: string) => void; onOpenExternal: (p: string) => void;
}) {
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  useEffect(() => { window.api.fsList(cwd).then(setEntries).catch(() => setEntries([])); }, [cwd]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Enter') onOpenClaude(sel ?? cwd); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [sel, cwd, onOpenClaude]);

  const folderMenu = (p: string): MenuItem[] => [
    { label: 'Open in Claude', onClick: () => onOpenClaude(p) },
    { label: 'Open in external terminal', onClick: () => onOpenExternal(p) },
    { label: 'Open folder', onClick: () => onNavigate(p) },
  ];

  return (
    <div className="filebrowser">
      <div className="toolbar">
        <Breadcrumb cwd={cwd} onNavigate={onNavigate} />
        <button onClick={() => onOpenClaude(cwd)}>Open this folder in Claude</button>
      </div>
      <ul className="entries">
        {entries.map((e) => (
          <li
            key={e.path}
            className={e.path === sel ? 'entry selected' : 'entry'}
            onClick={() => setSel(e.path)}
            onDoubleClick={() => e.isDirectory ? onNavigate(e.path) : undefined}
            onContextMenu={(ev) => { if (e.isDirectory) { ev.preventDefault(); setSel(e.path); setMenu({ x: ev.clientX, y: ev.clientY, items: folderMenu(e.path) }); } }}
          >
            {e.isDirectory ? '📁' : '📄'} {e.name}
          </li>
        ))}
      </ul>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
