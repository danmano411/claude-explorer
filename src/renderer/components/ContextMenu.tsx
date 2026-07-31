export type MenuItem =
  | { separator: true }
  /** A SUBMENU: a label that opens a nested list on hover and does nothing when
   *  clicked (KAN-66). Its own variant rather than an optional field on the leaf
   *  below, so `onClick` stays required where it is the whole point of the item
   *  and every pre-existing call site type-checks untouched. A parent with no
   *  children is the caller's problem — omit the item instead. */
  | { label: string; items: MenuItem[] }
  /** `swatch` is any CSS colour (in practice a GROUP_COLORS `var()` name) shown
   *  as a chip before the label — a colour menu with no colour in it is unusable. */
  | { label: string; onClick: () => void; disabled?: boolean; swatch?: string };

/**
 * The item rows, shared by the menu and by every nested one — recursion is the
 * whole of what submenu support costs, because a submenu IS a menu.
 *
 * Opening is CSS hover (`.ctx-sub:hover > .ctx-menu`), not state: the nested
 * `<ul>` is a CHILD of its parent `<li>`, so the pointer moving onto it keeps
 * the parent hovered and the list stays up with nothing to time out, nothing to
 * close and no second "which one is open" truth to keep in step.
 */
function Items({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  return (
    <>
      {items.map((it, i) =>
        'separator' in it ? (
          <li key={i} className="ctx-sep" aria-hidden />
        ) : 'items' in it ? (
          <li key={i} className="ctx-item ctx-sub">
            {it.label}
            <span className="ctx-caret" aria-hidden>▸</span>
            <ul className="ctx-menu">
              <Items items={it.items} onClose={onClose} />
            </ul>
          </li>
        ) : (
          <li
            key={i}
            className={it.disabled ? 'ctx-item disabled' : 'ctx-item'}
            onClick={() => { if (!it.disabled) { it.onClick(); onClose(); } }}
          >
            {it.swatch && <span className="ctx-swatch" style={{ background: it.swatch }} />}
            {it.label}
          </li>
        )
      )}
    </>
  );
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  return (
    <div className="ctx-backdrop" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <ul className="ctx-menu" style={{ left: x, top: y }} onClick={(e) => e.stopPropagation()}>
        <Items items={items} onClose={onClose} />
      </ul>
    </div>
  );
}
