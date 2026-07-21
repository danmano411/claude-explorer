export interface MenuItem { label: string; onClick: () => void }
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  return (
    <div className="ctx-backdrop" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <ul className="ctx-menu" style={{ left: x, top: y }} onClick={(e) => e.stopPropagation()}>
        {items.map((it, i) => (
          <li key={i} onClick={() => { it.onClick(); onClose(); }}>{it.label}</li>
        ))}
      </ul>
    </div>
  );
}
