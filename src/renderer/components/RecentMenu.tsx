import { useState } from 'react';
import type { RecentFolder, ClaudeSession } from '../../shared/types';

export function RecentMenu({ onOpen, onOpenFolder }: {
  onOpen: (path: string, resumeId?: string) => void;
  onOpenFolder: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [recents, setRecents] = useState<RecentFolder[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);

  const toggle = async () => {
    if (!open) setRecents(await window.api.recentsList());
    setOpen(!open);
  };

  const expand = async (path: string) => {
    setExpanded(path);
    setSessions(await window.api.sessionsList(path));
  };

  return (
    <div className="recentmenu">
      <button onClick={toggle}>Open Recent ▾</button>
      {open && (
        <ul className="recent-list">
          {recents.length === 0 && <li className="empty">No recent folders</li>}
          {recents.map((r) => (
            <li key={r.path}>
              <div className="recent-row">
                <span onClick={() => { onOpenFolder(r.path); setOpen(false); }}>{r.name}</span>
                <button onClick={() => onOpen(r.path)}>New</button>
                <button onClick={() => expand(r.path)}>Sessions</button>
              </div>
              {expanded === r.path && (
                <ul className="session-list">
                  {sessions.length === 0 && <li className="empty">No sessions</li>}
                  {sessions.map((s) => (
                    <li key={s.id} onClick={() => { onOpen(r.path, s.id); setOpen(false); }}>
                      {s.title} <span className="ts">{new Date(s.updated).toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
