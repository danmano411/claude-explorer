import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { canReflow, type Side } from '../gridlayout';

/** The ceiling on the arrangement this can express. ponytail: 5x5 is the line
 *  between "a keyboard path to the niche MxN arrangements" and a layout
 *  manager, which KAN-56 explicitly refuses to grow. Raise it only if someone
 *  actually wants a sixth track. */
const MAX = 5;

/** Ctrl+Arrow moves the focused pane; plain Arrow sizes the block. */
const DIRS: Record<string, Side> = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'top', ArrowDown: 'bottom',
};

export interface GridPickerProps {
  /** How many panes are placed right now. Every pick that cannot tile exactly
   *  this many is refused — see `canReflow`, which the model uses too, so the
   *  greyed-out cells and the picks `reflow` returns null for are the same set
   *  by construction rather than by two predicates being kept in agreement. */
  count: number;
  /** `.content`'s box, so the popover centres over the panes. Measured by the
   *  caller because this component is deliberately rendered OUTSIDE `.content`:
   *  an in-flow child of a grid container is auto-placed into the first free
   *  cell, so a popover inside it would silently claim a pane's rectangle
   *  (splitgrid.ts's container contract). */
  anchor: DOMRect | null;
  onApply: (cols: number, rows: number) => void;
  /** Ctrl+Arrow. Committed immediately and NOT part of what Escape reverts —
   *  same as the divider arrows, which also commit per press. */
  onMovePane: (dir: Side) => void;
  onClose: () => void;
}

/**
 * The MxN arrangement picker (KAN-56, Ctrl+Shift+G): hover or arrow to size a
 * block like a spreadsheet's insert-table control, Enter to apply.
 *
 * The ONLY new surface this ticket adds, and it stays small on purpose. It has
 * no notion of which pane goes where — `reflow` re-tiles the placed tabs in
 * strip order — because the moment it grows a per-cell identity preview it has
 * become the layout manager the ticket forbids.
 *
 * Nothing is staged anywhere until apply, so Escape / blur is inert by
 * construction rather than by an undo path.
 */
export function GridPicker({ count, anchor, onApply, onMovePane, onClose }: GridPickerProps) {
  /** The first pick that can actually tile `count`, so Enter is usable the
   *  moment the picker opens. `null` only when nothing at all is valid. */
  const first = () => {
    for (let r = 1; r <= MAX; r++)
      for (let c = 1; c <= MAX; c++) if (canReflow(count, c, r)) return { c, r };
    return null;
  };
  const [sel, setSel] = useState<{ c: number; r: number } | null>(first);
  const rootRef = useRef<HTMLDivElement>(null);
  // Explicit, not `autoFocus`: React only wires that attribute up for form
  // controls, and the keys below are handled on this element.
  useEffect(() => { rootRef.current?.focus(); }, []);

  /** Refused picks leave the previous highlight standing — pointing at a cell
   *  the model would reject must not look like it did something. */
  const pick = (c: number, r: number) => { if (canReflow(count, c, r)) setSel({ c, r }); };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // Nothing here may reach the app underneath — Ctrl+1..9 in particular.
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (sel) onApply(sel.c, sel.r);
      return;
    }
    const dir = DIRS[e.key];
    if (!dir) return;
    e.preventDefault();
    if (e.ctrlKey) { onMovePane(dir); return; }
    const c = (sel?.c ?? 1) + (dir === 'right' ? 1 : dir === 'left' ? -1 : 0);
    const r = (sel?.r ?? 1) + (dir === 'bottom' ? 1 : dir === 'top' ? -1 : 0);
    if (c >= 1 && c <= MAX && r >= 1 && r <= MAX) pick(c, r);
  };

  const size = sel ? `${sel.c}x${sel.r}` : '';
  const style = anchor
    ? { left: anchor.left + anchor.width / 2, top: anchor.top + anchor.height / 2 }
    : { left: '50%', top: '50%' };

  return (
    <div
      className="gridpick"
      data-size={size}
      style={style}
      ref={rootRef}
      role="dialog"
      aria-label="Arrange panes"
      // Focused, not focus-TRAPPED: tabbing away simply closes it, which is the
      // same thing clicking outside does.
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onClose(); }}
    >
      <div className="gridpick-grid">
        {Array.from({ length: MAX * MAX }, (_, i) => {
          const c = (i % MAX) + 1;
          const r = Math.floor(i / MAX) + 1;
          const ok = canReflow(count, c, r);
          const on = sel !== null && c <= sel.c && r <= sel.r;
          return (
            <button
              key={i}
              type="button"
              className={`gridpick-cell${on ? ' on' : ''}${ok ? '' : ' invalid'}`}
              data-cell={`${c - 1},${r - 1}`}
              aria-disabled={!ok}
              aria-label={`${c} by ${r}`}
              // Keep focus on the popover so the arrow keys keep working after
              // a click, and so a click on a cell is not a blur-close race.
              onPointerDown={(e) => e.preventDefault()}
              onPointerEnter={() => pick(c, r)}
              onClick={() => { if (ok) onApply(c, r); }}
            />
          );
        })}
      </div>
      <div className="gridpick-size" data-size={size}>
        {sel ? `${sel.c} × ${sel.r}` : '—'}
      </div>
    </div>
  );
}
