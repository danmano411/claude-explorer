import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef,
  type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react';
import type { GridLayout } from '../../shared/types';
import { inBounds } from '../gridlayout';
import {
  MIN_PANE_PX, cellArea, dividerArea, dividers, gridTemplate, normalizeFractions, resizeFractions,
  type Divider,
} from '../splitgrid';
import './SplitGrid.css';

export interface PaneSize { width: number; height: number }

type PaneSubscribe = (cb: (size: PaneSize) => void) => () => void;
const PaneResizeContext = createContext<PaneSubscribe | null>(null);

/**
 * Called by pane CONTENT to learn when its own box changes size — a divider
 * drag, a sibling pane opening or closing, or the window resizing. Fires once
 * immediately with the current size, then on every change until unmount.
 *
 * A subscription, not a `paneSize` value, and deliberately not the third
 * argument of `renderPane`. Pane size arrives from a ResizeObserver at pointer-
 * move rate; routing it through React state (which a `renderPane(tabId,
 * isFocused, paneSize)` signature forces, since the value has to come from
 * somewhere) would re-render every pane in the grid on every frame of a drag —
 * and it is content, not the grid, that actually cares. Here the observer calls
 * the callback directly: zero React renders during a drag, and a pane that
 * doesn't care pays nothing.
 *
 * The callback is read through a ref, so an inline closure is fine — the
 * subscription is not torn down and rebuilt on every render.
 *
 * Outside a SplitGrid this is an inert no-op (there is no pane), which is what
 * lets the same component render in a single-pane tab and in a grid unchanged.
 */
export function usePaneResize(onResize: (size: PaneSize) => void): void {
  const subscribe = useContext(PaneResizeContext);
  const latest = useRef(onResize);
  latest.current = onResize;
  useEffect(() => subscribe?.((size) => latest.current(size)), [subscribe]);
}

function Pane({ tabId, area, focused, onFocus, children }: {
  tabId: string;
  area: CSSProperties;
  focused: boolean;
  onFocus: () => void;
  children: ReactNode;
}) {
  const el = useRef<HTMLDivElement>(null);
  const subs = useRef(new Set<(size: PaneSize) => void>());

  // Stable across renders, so usePaneResize's effect never re-runs.
  const subscribe = useCallback<PaneSubscribe>((cb) => {
    subs.current.add(cb);
    if (el.current) cb({ width: el.current.clientWidth, height: el.current.clientHeight });
    return () => { subs.current.delete(cb); };
  }, []);

  useEffect(() => {
    const node = el.current;
    if (!node) return;
    // clientWidth/Height, not entry.contentRect: the ring is a box-shadow so
    // the two agree, and this stays right if padding is ever added.
    const ro = new ResizeObserver(() => {
      const size = { width: node.clientWidth, height: node.clientHeight };
      subs.current.forEach((cb) => cb(size));
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  return (
    // Capture phase: xterm and other content stop propagation on pointerdown,
    // so a bubbling listener here would never see a click inside a terminal —
    // the pane would be unfocusable exactly where focus matters most.
    <div
      ref={el}
      className={`split-pane${focused ? ' focused' : ''}`}
      style={area}
      data-pane={tabId}
      onPointerDownCapture={onFocus}
    >
      <PaneResizeContext.Provider value={subscribe}>{children}</PaneResizeContext.Provider>
    </div>
  );
}

export interface SplitGridProps {
  /**
   * Non-null on purpose. `Space.layout === null` is the classic single-pane
   * path and must stay untouched by split view, so the caller renders one or
   * the other — this component never has to mean "no split".
   */
  layout: GridLayout;
  focusedTabId?: string;
  onFocusPane: (tabId: string) => void;
  /** One tab per pane. The grid knows nothing about what a tab is. */
  renderPane: (tabId: string, isFocused: boolean) => ReactNode;
  /**
   * Track sizes, `layout.cols` / `layout.rows` positive numbers, normalised
   * internally. Omit for an even split. Not on `GridLayout`: KAN-43 owns
   * `src/shared/types.ts` this milestone, so these ride as props and the caller
   * persists them alongside the layout.
   */
  colFractions?: readonly number[];
  rowFractions?: readonly number[];
  /**
   * Fired ONCE per drag, on pointerup, with both axes' fractions. The caller
   * must store these and feed them back down: mid-drag the template is written
   * straight to the DOM (see onDividerMove), and this is the only moment React
   * is told about it.
   */
  onResize?: (cols: number[], rows: number[]) => void;
  minPanePx?: number;
}

/**
 * Renders a `GridLayout` as a CSS Grid, one tab per pane.
 *
 * There is no layout arithmetic here and there must never be: `cols`/`rows`
 * become `grid-template-*`, each cell's `col`/`row`/`colSpan`/`rowSpan` become
 * its `grid-area`, and the browser computes the boxes. That is what the spans in
 * `GridCell` are for.
 */
export function SplitGrid({
  layout, focusedTabId, onFocusPane, renderPane,
  colFractions, rowFractions, onResize, minPanePx = MIN_PANE_PX,
}: SplitGridProps) {
  const gridRef = useRef<HTMLDivElement>(null);

  /**
   * Panes are keyed on tabId AND emitted in a stable, position-independent DOM
   * order (sorted by tabId), because `layout.cells` order is not stable —
   * gridlayout's `place()` moves the touched tab to the end of the array. A
   * keyed reorder is not a re-mount, but it is a real `insertBefore` of a live
   * <canvas>, and moving an xterm's DOM subtree is not something to do on every
   * split-view edit. Sorting by tabId means opening or closing a pane never
   * touches a sibling's DOM position at all; only its grid-area style changes.
   *
   * Out-of-bounds cells are dropped rather than trusted: `gridlayout` rejects
   * them, but `workspace.json` is a file on disk, and a cell at col 9 of a 2x2
   * would make CSS grid invent implicit tracks and silently wreck the layout.
   */
  const cells = useMemo(
    () => layout.cells.filter((c) => inBounds(layout, c))
      .sort((a, b) => (a.tabId < b.tabId ? -1 : a.tabId > b.tabId ? 1 : 0)),
    [layout],
  );

  const drag = useRef<{ d: Divider; start: number; extent: number; next: number[] } | null>(null);

  const onDividerDown = (d: Divider) => (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = gridRef.current?.getBoundingClientRect();
    if (!box) return;
    e.preventDefault(); // no text selection / native drag while resizing
    // Pointer capture keeps the events coming from a 9px handle even when the
    // pointer outruns it — no window-level listeners to add and forget to remove.
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.classList.add('dragging');
    const horiz = d.axis === 'col';
    drag.current = {
      d,
      start: horiz ? e.clientX : e.clientY,
      extent: horiz ? box.width : box.height,
      next: normalizeFractions(horiz ? colFractions : rowFractions, horiz ? layout.cols : layout.rows),
    };
  };

  const onDividerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    const node = gridRef.current;
    if (!g || !node) return;
    const horiz = g.d.axis === 'col';
    // Delta from the drag ORIGIN against the pointerdown snapshot, so a drag
    // that pushes into the clamp and comes back is exactly reversible.
    const delta = (horiz ? e.clientX : e.clientY) - g.start;
    const base = normalizeFractions(horiz ? colFractions : rowFractions, horiz ? layout.cols : layout.rows);
    g.next = resizeFractions(base, base.length, g.d.index, delta, g.extent, minPanePx);
    // Written to the DOM, not to state: a setState per pointermove would
    // re-render every pane's subtree ~60x/second for the whole drag. The boxes
    // really do change, so each pane's ResizeObserver still fires and content
    // still re-fits — continuous resize with zero React work.
    node.style[horiz ? 'gridTemplateColumns' : 'gridTemplateRows'] = gridTemplate(g.next, g.next.length);
  };

  const onDividerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    drag.current = null;
    e.currentTarget.classList.remove('dragging');
    if (!g) return;
    const horiz = g.d.axis === 'col';
    onResize?.(
      horiz ? g.next : normalizeFractions(colFractions, layout.cols),
      horiz ? normalizeFractions(rowFractions, layout.rows) : g.next,
    );
  };

  return (
    <div
      className="split-grid"
      ref={gridRef}
      style={{
        gridTemplateColumns: gridTemplate(colFractions, layout.cols),
        gridTemplateRows: gridTemplate(rowFractions, layout.rows),
      }}
    >
      {cells.map((c) => (
        <Pane
          key={c.tabId}
          tabId={c.tabId}
          area={cellArea(c)}
          focused={c.tabId === focusedTabId}
          onFocus={() => onFocusPane(c.tabId)}
        >
          {renderPane(c.tabId, c.tabId === focusedTabId)}
        </Pane>
      ))}
      {dividers(layout).map((d) => (
        <div
          key={`${d.axis}${d.index}`}
          className={`split-divider ${d.axis}`}
          style={dividerArea(d)}
          data-divider={`${d.axis}${d.index}`}
          onPointerDown={onDividerDown(d)}
          onPointerMove={onDividerMove}
          onPointerUp={onDividerUp}
          onPointerCancel={onDividerUp}
        />
      ))}
    </div>
  );
}
