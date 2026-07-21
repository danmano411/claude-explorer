export type MenuItem =
  | { separator: true }
  | { label: string; onClick: () => void; disabled?: boolean };

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  return (
    <div className="ctx-backdrop" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <ul className="ctx-menu" style={{ left: x, top: y }} onClick={(e) => e.stopPropagation()}>
        {items.map((it, i) =>
          'separator' in it ? (
            <li key={i} className="ctx-sep" aria-hidden />
          ) : (
            <li
              key={i}
              className={it.disabled ? 'ctx-item disabled' : 'ctx-item'}
              onClick={() => { if (!it.disabled) { it.onClick(); onClose(); } }}
            >
              {it.label}
            </li>
          )
        )}
      </ul>
    </div>
  );
}
