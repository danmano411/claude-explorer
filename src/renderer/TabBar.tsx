import { useRef, useState, type ReactNode } from 'react';
import type { Tab } from './tabs';
import { useAppState, type DragPayload } from './appstate';

const TAB_MIME = 'application/x-ce-tab';
const SPRING_MS = 600;

interface Props {
  tabs: Tab[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onAdd: () => void;
  onReorder: (from: number, to: number) => void;
  recentMenu: ReactNode;
}

export function TabBar({ tabs, activeId, onSelect, onClose, onAdd, onReorder, recentMenu }: Props) {
  // useAppState throws until the provider is mounted (V4); tolerate that pre-V4.
  // ponytail: try/catch a hook is safe because the throw is deterministic — order stays stable.
  let drag: DragPayload = null;
  try { drag = useAppState().drag; } catch { /* provider not mounted yet */ }

  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [springId, setSpringId] = useState<string | null>(null);
  const springTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSpring = () => {
    if (springTimer.current) { clearTimeout(springTimer.current); springTimer.current = null; }
    setSpringId(null);
  };

  const startSpring = (id: string) => {
    if (springTimer.current) clearTimeout(springTimer.current);
    setSpringId(id);
    springTimer.current = setTimeout(() => { onSelect(id); clearSpring(); }, SPRING_MS);
  };

  return (
    <div className="tabbar">
      {recentMenu}
      {tabs.map((t, i) => {
        let cls = t.id === activeId ? 'tab active' : 'tab';
        if (overIndex === i) cls += ' drag-over';
        if (springId === t.id) cls += ' spring-target';
        return (
          <button
            key={t.id}
            className={cls}
            draggable
            onClick={() => onSelect(t.id)}
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
                if (overIndex !== i) setOverIndex(i);
              } else if (drag) {
                e.preventDefault(); // allow the file-drag hover to keep firing
              }
            }}
            onDragLeave={() => {
              if (springId === t.id) clearSpring();
              if (overIndex === i) setOverIndex(null);
            }}
            onDrop={(e) => {
              clearSpring();
              setOverIndex(null);
              const id = e.dataTransfer.getData(TAB_MIME);
              if (id) {
                e.preventDefault();
                if (dragFrom !== null && dragFrom !== i) onReorder(dragFrom, i);
              }
              // File drop directly on a tab (not a folder row) is a no-op.
              setDragFrom(null);
            }}
            onDragEnd={() => { setDragFrom(null); setOverIndex(null); clearSpring(); }}
          >
            {t.view === 'terminal' ? '▶ ' : '📁 '}{t.title}
            <span className="close" onClick={(e) => { e.stopPropagation(); onClose(t.id); }}>×</span>
          </button>
        );
      })}
      <button className="tab add" onClick={onAdd}>+</button>
    </div>
  );
}
