import { useRef, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import {
  SEAM_PX, dividerArea, dividerId, gridTemplate, resizeFractions,
  type Divider, type GridPlacement,
} from '../splitgrid';

/** One arrow-key press. Roughly a terminal line; big enough to feel, small
 *  enough to land on a target with a few presses. */
const KEY_STEP_PX = 16;

export interface SplitDividersProps {
  /** From `gridPlacement()`. Renders nothing when `placement.split` is false. */
  placement: GridPlacement;
  /**
   * The element `placement.container` was spread onto. The handles are grid
   * items ON that grid — they inherit the live template, so they follow the
   * seam during a drag with no second position to keep in sync — so they must
   * be rendered as its children, and the drag needs its box to convert pixels
   * to fractions.
   */
  containerRef: RefObject<HTMLElement | null>;
  /**
   * Fired ONCE per drag, on pointerup, and once per arrow-key press, with both
   * axes' fractions. The caller must store these and feed them back down:
   * mid-drag the template is written straight to the DOM (see onMove), and this
   * is the only moment React is told about it.
   *
   * Not fired when nothing moved, so a stray click on a handle does not
   * materialise `[1, 1, ...]` into caller state and cost a `workspace.json`
   * write (review finding 6).
   */
  onResize?: (cols: number[], rows: number[]) => void;
}

/**
 * The draggable seams of a split view, as an overlay on the caller's own grid.
 *
 * This component renders ONLY the handles. It does not own, wrap, or re-parent
 * a single pane — see the header of `splitgrid.ts` for why (KAN-23: an xterm
 * that changes parent loses alt-screen mode and its scrollback). The panes are
 * the caller's existing flat, always-mounted list; `gridPlacement()` gives them
 * a `grid-area` each and this places handles on the same grid.
 *
 * Wired into `App.tsx`'s `.content` since KAN-46 integration: that element gets
 * `ref` + `style={placement.container}`, each existing `.pane` gets
 * `style={placement.panes[t.id]}` and a capture-phase `selectTab` (xterm stops
 * propagation, so a bubbling handler never sees a click inside a terminal —
 * exactly the pane you most need to focus by clicking it), and this component
 * is the last child. `Terminal.tsx` coalesces its ResizeObserver into a
 * `requestAnimationFrame` so a drag costs one `ptyResize` per frame rather than
 * ~8 per pointermove; that is a flooding fix, not a correctness one.
 *
 * Styles live in `index.css` under "M5: split view", with the rest of the app's.
 */
export function SplitDividers({ placement, containerRef, onResize }: SplitDividersProps) {
  const drag = useRef<{
    d: Divider; start: number; extent: number;
    base: number[]; next: number[]; cols: number; rows: number;
  } | null>(null);

  /** The space the TRACKS get: the box minus the gutters, which belong to no
   *  track. Without this every px<->fr conversion is off by up to a seam. */
  const trackExtent = (axis: 'col' | 'row') => {
    const box = containerRef.current?.getBoundingClientRect();
    if (!box) return 0;
    const n = (axis === 'col' ? placement.cols : placement.rows).length;
    return (axis === 'col' ? box.width : box.height) - (n - 1) * SEAM_PX;
  };

  /**
   * A pane closing mid-drag is real and asynchronous (a pty exits), and it
   * re-shapes the grid under the pointer. Anything written after that would be
   * a template for a grid that no longer exists, so the drag is abandoned
   * rather than finished against stale geometry (review finding 5). Compared by
   * value, not by object identity: the caller is not required to memoise.
   */
  const stale = (g: NonNullable<typeof drag.current>) =>
    g.cols !== placement.cols.length || g.rows !== placement.rows.length
    || !placement.dividers.some((d) => d.axis === g.d.axis && d.index === g.d.index && d.start === g.d.start);

  /** Both axes, because the caller stores both — but only if something moved. */
  const commit = (axis: 'col' | 'row', next: number[], base: number[]) => {
    if (next.every((v, i) => Math.abs(v - base[i]) < 1e-9)) return;
    onResize?.(axis === 'col' ? next : placement.cols, axis === 'col' ? placement.rows : next);
  };

  const onDown = (d: Divider) => (e: ReactPointerEvent<HTMLDivElement>) => {
    const extent = trackExtent(d.axis);
    if (!extent) return;
    e.preventDefault(); // no text selection / native drag while resizing
    // Pointer capture keeps the events coming from a 9px handle even when the
    // pointer outruns it — no window-level listeners to add and forget to remove.
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.classList.add('dragging');
    const base = d.axis === 'col' ? placement.cols : placement.rows;
    drag.current = {
      d, extent, base, next: base,
      start: d.axis === 'col' ? e.clientX : e.clientY,
      cols: placement.cols.length, rows: placement.rows.length,
    };
  };

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    const node = containerRef.current;
    if (!g || !node) return;
    if (stale(g)) { drag.current = null; e.currentTarget.classList.remove('dragging'); return; }
    const horiz = g.d.axis === 'col';
    // Delta from the drag ORIGIN against the pointerdown snapshot, so a drag
    // that pushes into the clamp and comes back is exactly reversible.
    const delta = (horiz ? e.clientX : e.clientY) - g.start;
    g.next = resizeFractions(g.base, g.base.length, g.d.index, delta, g.extent);
    // Written to the DOM, not to state: a setState per pointermove would
    // re-render the whole app ~60x/second for the whole drag. The boxes really
    // do change, so each pane's own ResizeObserver still fires and content
    // still re-fits — continuous resize with zero React work.
    node.style[horiz ? 'gridTemplateColumns' : 'gridTemplateRows'] = gridTemplate(g.next, g.next.length);
  };

  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    drag.current = null;
    e.currentTarget.classList.remove('dragging');
    if (!g || stale(g)) return;
    commit(g.d.axis, g.next, g.base);
  };

  const onKeyDown = (d: Divider) => (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const horiz = d.axis === 'col';
    const back = e.key === (horiz ? 'ArrowLeft' : 'ArrowUp');
    const fwd = e.key === (horiz ? 'ArrowRight' : 'ArrowDown');
    if (!back && !fwd) return;
    e.preventDefault();
    const base = horiz ? placement.cols : placement.rows;
    commit(d.axis, resizeFractions(base, base.length, d.index, fwd ? KEY_STEP_PX : -KEY_STEP_PX, trackExtent(d.axis)), base);
  };

  if (!placement.split) return null;

  return (
    <>
      {placement.dividers.map((d) => {
        const track = d.axis === 'col' ? placement.cols : placement.rows;
        const pair = track[d.index] + track[d.index + 1];
        return (
          <div
            key={dividerId(d)}
            className={`split-divider ${d.axis}`}
            style={dividerArea(d)}
            data-divider={dividerId(d)}
            // A window splitter. Vertical/horizontal name the SEAM's own
            // orientation, not the axis it moves: a column seam is a vertical line.
            role="separator"
            aria-orientation={d.axis === 'col' ? 'vertical' : 'horizontal'}
            aria-label={d.axis === 'col' ? 'Resize columns' : 'Resize rows'}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((track[d.index] / pair) * 100)}
            tabIndex={0}
            onPointerDown={onDown(d)}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onKeyDown={onKeyDown(d)}
          />
        );
      })}
    </>
  );
}
