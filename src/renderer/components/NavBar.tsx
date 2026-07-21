import { useState } from 'react';
import { Breadcrumb } from './Breadcrumb';

export function NavBar({ cwd, canBack, canForward, onBack, onForward, onRefresh, onNavigate }: {
  cwd: string;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onRefresh: () => void;
  onNavigate: (p: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);

  const commit = async () => {
    const p = (editing ?? '').trim();
    setEditing(null);
    if (p && p !== cwd && (await window.api.fsExists(p))) onNavigate(p);
  };

  return (
    <div className="navbar">
      <button className="nav-btn" title="Back (Alt+Left)" disabled={!canBack} onClick={onBack}>◀</button>
      <button className="nav-btn" title="Forward (Alt+Right)" disabled={!canForward} onClick={onForward}>▶</button>
      <button className="nav-btn" title="Refresh (F5)" onClick={onRefresh}>⟳</button>
      {editing !== null ? (
        <input
          className="address-input"
          autoFocus
          value={editing}
          onChange={(e) => setEditing(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') { e.preventDefault(); setEditing(null); }
          }}
        />
      ) : (
        <div className="address" onClick={(e) => { if (e.target === e.currentTarget) setEditing(cwd); }}>
          <Breadcrumb cwd={cwd} onNavigate={onNavigate} />
        </div>
      )}
    </div>
  );
}
