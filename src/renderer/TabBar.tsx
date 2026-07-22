import { useRef, useState, type ReactNode } from 'react';
import type { Tab } from './tabs';
import type { PtyStatus } from '../shared/types';
import { useAppState, type DragPayload } from './appstate';
import { dropIndex } from './tabreorder';
import { ContextMenu } from './components/ContextMenu';

const TAB_MIME = 'application/x-ce-tab';
const SPRING_MS = 600;

interface Props {
  tabs: Tab[];
  activeId: string;
  status: Map<string, PtyStatus>;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onAdd: () => void;
  onReorder: (from: number, insert: number) => void; // insert index is post-splice (from tabreorder)
  onRename: (id: string, title: string) => void;
  onOpenExplorer: (id: string) => void;
  onOpenTerminal: (id: string) => void;
  onOpenIde: (id: string) => void;
  recentMenu: ReactNode;
}

export function TabBar({
  tabs, activeId, status, onSelect, onClose, onAdd, onReorder,
  onRename, onOpenExplorer, onOpenTerminal, onOpenIde, recentMenu,
}: Props) {
  // useAppState throws until the provider is mounted (V4); tolerate that pre-V4.
  let drag: DragPayload = null;
  try { drag = useAppState().drag; } catch { /* provider not mounted yet */ }

  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [over, setOver] = useState<{ index: number; side: 'left' | 'right' } | null>(null);
  const [springId, setSpringId] = useState<string | null>(null);
  const springTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const clearSpring = () => {
    if (springTimer.current) { clearTimeout(springTimer.current); springTimer.current = null; }
    setSpringId(null);
  };

  const startSpring = (id: string) => {
    if (springTimer.current) clearTimeout(springTimer.current);
    setSpringId(id);
    springTimer.current = setTimeout(() => { onSelect(id); clearSpring(); }, SPRING_MS);
  };

  const startRename = (id: string) => {
    const t = tabs.find((x) => x.id === id);
    if (!t) return;
    setDraft(t.title);
    setRenaming(id);
  };

  const commitRename = () => {
    if (renaming) onRename(renaming, draft);
    setRenaming(null);
  };

  return (
    <div className="tabbar">
      {recentMenu}
      {tabs.map((t, i) => {
        let cls = t.id === activeId ? 'tab active' : 'tab';
        if (over?.index === i) cls += over.side === 'right' ? ' drop-right' : ' drop-left';
        if (springId === t.id) cls += ' spring-target';
        const isTerminal = t.view === 'terminal';
        const isClaude = isTerminal && t.terminalKind === 'claude';
        const st = isClaude ? (status.get(t.ptyId!) ?? 'running') : null;
        return (
          <button
            key={t.id}
            className={cls}
            draggable={renaming !== t.id}
            onClick={() => onSelect(t.id)}
            onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, id: t.id }); }}
            onDragStart={(e) => {
              setDragFrom(i);
              e.dataTransfer.setData(TAB_MIME, t.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragEnter={(e) => {
              // File drag from a FileBrowser → spring-load this tab after a hover.
              if (drag && e.dataTransfer.types.includes('application/x-ce-files')) {
                if (springId !== t.id) startSpring(t.id);
              }
            }}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes(TAB_MIME)) {
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                const side: 'left' | 'right' = e.clientX > r.left + r.width / 2 ? 'right' : 'left';
                if (over?.index !== i || over?.side !== side) setOver({ index: i, side });
              } else if (drag) {
                e.preventDefault(); // allow the file-drag hover to keep firing
              }
            }}
            onDragLeave={() => {
              if (springId === t.id) clearSpring();
              if (over?.index === i) setOver(null);
            }}
            onDrop={(e) => {
              clearSpring();
              const dropped = over;
              setOver(null);
              const id = e.dataTransfer.getData(TAB_MIME);
              if (id && dragFrom !== null && dropped) {
                e.preventDefault();
                const insert = dropIndex(dragFrom, dropped.index, dropped.side);
                if (insert !== dragFrom) onReorder(dragFrom, insert);
              }
              setDragFrom(null);
            }}
            onDragEnd={() => { setDragFrom(null); setOver(null); clearSpring(); }}
          >
            {isClaude
              ? <span className={'tab-status ' + st} />
              : isTerminal ? '▶ ' : '📁 '}
            {renaming === t.id ? (
              <input
                className="tab-rename"
                autoFocus
                value={draft}
                onClick={(e) => e.stopPropagation()}
                onDragStart={(e) => e.stopPropagation()}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                  if (e.key === 'Escape') { e.preventDefault(); setRenaming(null); }
                }}
              />
            ) : (
              t.title
            )}
            <span className="close" onClick={(e) => { e.stopPropagation(); onClose(t.id); }}>×</span>
          </button>
        );
      })}
      <button className="tab add" onClick={onAdd}>+</button>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: 'Rename', onClick: () => startRename(menu.id) },
            { label: 'Open in File Explorer', onClick: () => onOpenExplorer(menu.id) },
            { label: 'Open Terminal', onClick: () => onOpenTerminal(menu.id) },
            { label: 'Open in IDE', onClick: () => onOpenIde(menu.id) },
            { separator: true },
            { label: 'Close', onClick: () => onClose(menu.id) },
          ]}
        />
      )}
    </div>
  );
}
