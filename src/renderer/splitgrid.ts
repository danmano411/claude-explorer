import type { CSSProperties } from 'react'
import type { GridCell, GridLayout } from '../shared/types'
import { cellKey, inBounds, occupies, type CellKey, type Side } from './gridlayout'

/** Re-exported so a caller doing drop handling imports one module, not two;
 *  `gridlayout` remains the single definition. */
export type { Side, CellKey }

/**
 * Pure geometry for the split-view render layer (KAN-46), the sibling of
 * `gridlayout.ts` the same way `fs.ts` is the sibling of `fs.handlers.ts`:
 * gridlayout owns *which cells are legal*, this module owns *how a legal
 * layout becomes CSS* and *how a divider drag becomes fractions*. No React
 * element, no DOM node, no pixel position of a pane — CSS Grid computes those
 * from the templates built here, which is the whole reason `GridCell` carries
 * spans instead of coordinates.
 *
 * THE SHAPE, and why it is inverted (review finding 1):
 * split view does NOT own the panes. `App.tsx` keeps every terminal tab mounted
 * as a flat `<div className="pane">` sibling forever, because unmounting an
 * xterm loses alt-screen mode and scrollback — that is KAN-23, a bug this
 * project has already shipped a fix for. A component that wrapped each terminal
 * in a pane of its own would re-parent (= unmount + remount) every xterm in the
 * window on every `layout: null <-> grid` transition.
 *
 * So `gridPlacement()` computes styles for the elements App already has: one
 * style object for the existing flat container, one `grid-area` for each cell's
 * ACTIVE tab, and one for each cell's `.paneslot` (which carries that pane's
 * strip, and is a flat sibling for the same reason). The panes are never
 * re-parented, never re-keyed, never touched — only their `style` changes, and
 * moving a tab between panes is therefore one `gridArea` write on a node that
 * stays put. `layout: null` needs no special case at all: it returns an empty
 * container style, which leaves the container exactly the block box it is today
 * with one visible `inset: 0` pane in it.
 */

/** Width of the visible seam between panes, painted by the grid's own `gap`
 *  showing the container background through. Once, on the container — not a
 *  ring per pane, which would double up on every interior edge. */
export const SEAM_PX = 1

/**
 * Height of a pane's own tab strip (KAN-56). A pane is a window and a window
 * has a title bar; the strip is that bar, and the pane BODY starts below it.
 *
 * ponytail: two sources for one number — this and `--panestrip-h` in
 * index.css. The pane's grid-area style is built here in JS, so the JS copy is
 * load-bearing; fold it into a CSS-var read if the two ever drift.
 */
export const STRIP_PX = 30

/**
 * Track sizes are kept normalised to `sum === count`, so an untouched grid is
 * exactly `[1, 1, ...]` and `extentPx / count` is the pixel value of 1fr.
 * That invariant is what makes `resizeFractions` px<->fr conversion a single
 * division instead of a running total.
 *
 * Anything that isn't a full set of finite positive numbers falls back to an
 * even split rather than being repaired entry-by-entry: a fractions array is
 * persisted state (`workspace.json`) and a partially-plausible one — three
 * numbers for a four-column grid — has no defensible interpretation. Scaling
 * a zero-filled gap would silently render a pane at zero width, which looks
 * like the app lost a tab.
 */
export function normalizeFractions(fractions: readonly number[] | undefined, count: number): number[] {
  const n = Math.max(1, Math.floor(count))
  if (!fractions || fractions.length !== n || fractions.some((f) => !Number.isFinite(f) || f <= 0))
    return Array(n).fill(1)
  const sum = fractions.reduce((a, b) => a + b, 0)
  return fractions.map((f) => (f * n) / sum)
}

/** Rounded to 4dp so a dragged template is a readable style string rather than
 *  `1.0000000000000002fr`; 1e-4 of a track is far below one device pixel. */
export function gridTemplate(fractions: readonly number[] | undefined, count: number): string {
  return normalizeFractions(fractions, count)
    .map((f) => `${Math.round(f * 1e4) / 1e4}fr`)
    .join(' ')
}

/** A cell's `grid-area`. CSS grid lines are 1-based, `GridCell` is 0-based. */
export function cellArea(cell: GridCell): CSSProperties {
  return {
    gridColumn: `${cell.col + 1} / span ${Math.max(1, cell.colSpan)}`,
    gridRow: `${cell.row + 1} / span ${Math.max(1, cell.rowSpan)}`,
  }
}

/**
 * `index` is the track to the LEFT of (or ABOVE) the seam, so a col divider
 * with index 0 sits on the boundary between column 0 and column 1.
 *
 * `start`/`end` are the CROSS-axis track range the handle covers, `[start, end)`
 * 0-based. A seam is not automatically the full height of the grid: in a 3x2
 * where one tab spans cols 0-1, the line between col 0 and col 1 runs *through*
 * that pane and is not a boundary of anything (review finding 2).
 */
export interface Divider {
  axis: 'col' | 'row'
  index: number
  start: number
  end: number
}

/** Stable per divider, including the run — one seam can legitimately break into
 *  two handles when a spanning cell straddles its middle. */
export function dividerId(d: Divider): string {
  return `${d.axis}${d.index}-${d.start}`
}

/**
 * Every interior seam that is a real boundary of some pane.
 *
 * Not simply "N-1 per N-track axis": that emitted a full-length handle for
 * every grid line, including lines buried *inside* a spanning cell. Such a
 * handle changed nothing visible when dragged, yet still persisted lopsided
 * fractions that snapped panes sideways once the span was removed, and it sat
 * above the pane eating pointer events over a live terminal.
 *
 * A cross-axis position is part of a seam when, at that position, no cell
 * straddles the line AND some cell has an edge on it. Contiguous positions
 * become one handle; a gap in the middle produces two, so a handle never lies
 * over a pane it cannot resize.
 */
export function dividers(layout: GridLayout): Divider[] {
  const out: Divider[] = []
  for (const axis of ['col', 'row'] as const) {
    const along = axis === 'col' ? layout.cols : layout.rows
    const across = axis === 'col' ? layout.rows : layout.cols
    for (let index = 0; index < along - 1; index++) {
      const line = index + 1
      let start = -1
      for (let k = 0; k <= across; k++) {
        const usable = k < across && isSeamAt(layout.cells, axis, line, k)
        if (usable && start < 0) start = k
        else if (!usable && start >= 0) {
          out.push({ axis, index, start, end: k })
          start = -1
        }
      }
    }
  }
  return out
}

/** Is grid line `line` (along `axis`) a pane boundary at cross-axis track `k`? */
function isSeamAt(cells: readonly GridCell[], axis: 'col' | 'row', line: number, k: number): boolean {
  let borders = false
  for (const c of cells) {
    const near = axis === 'col' ? c.col : c.row
    const nearSpan = axis === 'col' ? c.colSpan : c.rowSpan
    const far = axis === 'col' ? c.row : c.col
    const farSpan = axis === 'col' ? c.rowSpan : c.colSpan
    if (k < far || k >= far + farSpan) continue // this cell isn't at position k
    if (near < line && line < near + nearSpan) return false // straddles the line
    if (near === line || near + nearSpan === line) borders = true
  }
  return borders
}

/**
 * The divider's grab box, expressed as a `grid-area` on the SAME grid as the
 * panes rather than as a pixel offset. Placing the handle at the start edge of
 * track `index + 1` (grid line `index + 2`) means it tracks the template for
 * free: rewriting `grid-template-columns` mid-drag moves the handle with the
 * seam, with no second position to keep in sync. It also means hit-testing
 * "which divider is the pointer on" is the browser's own job — the handles are
 * real elements with real hit boxes stacked above the panes, so there is no
 * hand-rolled hit-test to get wrong. Testing this function IS testing the hit
 * boxes: a handle placed on the wrong grid line is exactly a hit-test bug.
 */
export function dividerArea(d: Divider): CSSProperties {
  const seam = `${d.index + 2} / span 1`
  const run = `${d.start + 1} / ${d.end + 1}`
  return d.axis === 'col'
    ? { gridColumn: seam, gridRow: run }
    : { gridRow: seam, gridColumn: run }
}

/** Floor on a pane's short side. A pane narrower than this cannot show a
 *  usable terminal, and a pane at zero is unrecoverable — there is no seam
 *  left to grab to bring it back. */
export const MIN_PANE_PX = 80

/**
 * The new fractions after dragging divider `index` by `deltaPx`.
 *
 * A drag is strictly local: only the two tracks either side of the seam
 * change, and their sum is preserved, so every other pane in the grid keeps
 * its exact size. `deltaPx` is measured from where the drag STARTED against
 * the fractions as they were at that moment (pass the pointerdown snapshot as
 * `fractions`), not accumulated per pointermove — accumulating drifts once the
 * clamp starts biting, because the clamped frames would be lost.
 *
 * `extentPx` is the space the TRACKS get, i.e. the container's box minus the
 * `(count - 1) * SEAM_PX` of gutter that belongs to no track.
 *
 * The clamp is two-sided and applied to the delta rather than to the results,
 * which is what makes dragging past the limit *stick* at the limit instead of
 * inverting. `minPx` is floored at 1px whatever the caller asks for: zero is
 * not a legal pane size — a zero-width pane has no seam left to grab, so the
 * user cannot undo the drag that created it.  When the pair is too small to
 * give both sides `minPx` (a genuinely tiny window) the drag is refused
 * outright rather than splitting the difference: silently redistributing tracks
 * the user did not grab is worse than nothing happening.
 */
export function resizeFractions(
  fractions: readonly number[] | undefined,
  count: number,
  index: number,
  deltaPx: number,
  extentPx: number,
  minPx: number = MIN_PANE_PX,
): number[] {
  const f = normalizeFractions(fractions, count)
  if (index < 0 || index >= f.length - 1) return f
  if (!Number.isFinite(deltaPx) || !(extentPx > 0)) return f

  // sum(f) === f.length by the normalise invariant, so this is exact.
  const pxPerFr = extentPx / f.length
  const minFr = Math.max(1, Number.isFinite(minPx) ? minPx : MIN_PANE_PX) / pxPerFr
  const pair = f[index] + f[index + 1]
  if (pair < 2 * minFr) return f

  const d = Math.max(minFr - f[index], Math.min(f[index + 1] - minFr, deltaPx / pxPerFr))
  const next = [...f]
  next[index] = f[index] + d
  next[index + 1] = f[index + 1] - d
  return next
}

/**
 * Everything the caller needs to render a split, as styles for elements it
 * already owns.
 *
 * `split: false` means "there is nothing to place" — no layout, or a layout
 * with no usable cells — and every other field is empty. That is the ONLY
 * signal a caller needs to branch on: `layout !== null` is not enough, because
 * `gridlayout.remove()` on the last pane legitimately yields `{ cells: [] }`
 * (review finding 4).
 */
export interface GridPlacement {
  split: boolean
  /** Spread onto the existing flat pane container. `{}` when `split` is false,
   *  so the container stays exactly the block box it is without split view. */
  container: CSSProperties
  /** A cell's ACTIVE `tabId` -> the style for that tab's existing pane element.
   *  A tab absent from this map is not the active tab of any cell and must not
   *  be shown. Carries `top: STRIP_PX` so the pane starts below its own strip. */
  panes: Record<string, CSSProperties>
  /** `cellKey` -> the style for that cell's `.paneslot`, which carries the
   *  pane's strip. Empty when `split` is false: with no layout there is one
   *  global strip and no slots at all. */
  strips: Record<CellKey, CSSProperties>
  dividers: Divider[]
  /** Normalised track sizes, for the drag handler. */
  cols: number[]
  rows: number[]
  /** The cells actually placed, after hostile input is dropped. */
  cells: GridCell[]
}

const EMPTY: GridPlacement = {
  split: false, container: {}, panes: {}, strips: {}, dividers: [], cols: [1], rows: [1], cells: [],
}

/**
 * A `GridLayout` (+ optional track sizes) as CSS for the caller's own elements.
 *
 * CONTAINER CONTRACT — the container must be a positioned element (App's
 * `.content` already is `position: relative`) and its pane children must be
 * `position: absolute; inset: 0` (App's `.pane` already is). An absolutely
 * positioned child of a grid container that has a definite grid position takes
 * that GRID AREA as its containing block, so `inset: 0` fills the cell exactly
 * — which is how the existing flat pane list gets tiled without a single node
 * being re-parented. Any OTHER in-flow child of the container becomes a real
 * grid item and will be auto-placed into the first free cell; when `split` is
 * true the container must contain only panes and dividers.
 *
 * `layout.cells` is sanitised here, not trusted: it comes from `workspace.json`,
 * a file on disk. `gridlayout` enforces the invariants a hand-edited file does
 * not — in bounds, no overlaps, a tab in exactly one cell, a non-empty strip
 * whose `activeTabId` is a member — and all of them matter at render time. Out
 * of bounds makes CSS grid invent implicit tracks and wrecks the layout; a tab
 * id claimed twice makes two panes claim one terminal; an overlap stacks panes
 * silently. First cell wins: a repeated tab id is dropped from the LATER cell
 * rather than taking the whole cell down with it, and a cell left with no tabs
 * is dropped.
 */
export function gridPlacement(
  layout: GridLayout | null | undefined,
  colFractions?: readonly number[],
  rowFractions?: readonly number[],
): GridPlacement {
  if (!layout) return EMPTY

  const seenTab = new Set<string>()
  const seenCell = new Set<CellKey>()
  const taken = new Set<string>()
  const cells: GridCell[] = []
  for (const c of layout.cells) {
    if (seenCell.has(cellKey(c)) || !Array.isArray(c.tabIds) || !inBounds(layout, c)) continue
    const tabIds = c.tabIds.filter((id) => id && !seenTab.has(id))
    if (!tabIds.length) continue
    const keys = occupies(c)
    if (keys.some((k) => taken.has(k))) continue
    for (const id of tabIds) seenTab.add(id)
    seenCell.add(cellKey(c))
    for (const k of keys) taken.add(k)
    cells.push({
      ...c,
      tabIds,
      activeTabId: tabIds.includes(c.activeTabId) ? c.activeTabId : tabIds[0],
    })
  }
  if (!cells.length) return EMPTY

  const clean: GridLayout = { cols: layout.cols, rows: layout.rows, cells }
  const panes: Record<string, CSSProperties> = {}
  const strips: Record<CellKey, CSSProperties> = {}
  for (const c of cells) {
    // The pane and its strip share a grid area; the pane is pushed down by the
    // strip's height. `top` beats the stylesheet's `inset: 0` from the style
    // attribute, so this is a RESIZE of a node that never moves — which is what
    // keeps an xterm alive across a pane change (KAN-23).
    panes[c.activeTabId] = { ...cellArea(c), top: STRIP_PX }
    strips[cellKey(c)] = cellArea(c)
  }

  return {
    split: true,
    container: {
      display: 'grid',
      gridTemplateColumns: gridTemplate(colFractions, layout.cols),
      gridTemplateRows: gridTemplate(rowFractions, layout.rows),
      // The seam, drawn once: the gutter shows the container's background.
      // A ring per pane would paint every interior edge twice.
      gap: `${SEAM_PX}px`,
      background: 'var(--line)',
    },
    panes,
    strips,
    dividers: dividers(clean),
    cols: normalizeFractions(colFractions, layout.cols),
    rows: normalizeFractions(rowFractions, layout.rows),
    cells,
  }
}

/**
 * DIRECT MANIPULATION (KAN-56) — hit-testing a pointer against the boxes the
 * browser measured.
 *
 * Still no DOM here: the caller reads `getBoundingClientRect()` off the
 * `[data-pane]` / `[data-divider]` elements it already renders and subtracts the
 * container's own rect. That inversion is the same one `gridPlacement` uses, and
 * it is why this cannot drift from what is on screen mid divider-drag, when the
 * template has been written straight to the DOM and React's state is one frame
 * behind.
 */

/** A measured box, in CONTAINER-RELATIVE px. */
export interface Box { left: number; top: number; width: number; height: number }
/** A pane's BODY box — the cell minus its strip. The strip is a real element
 *  with its own handlers, so a drop on it never reaches this hit-test at all;
 *  that is how "the strip wins over the edge quarter" is enforced structurally
 *  rather than by a fourth priority rule. */
export interface PaneBox extends Box { cell: CellKey }
export interface SeamBox extends Box { axis: 'col' | 'row'; index: number; start: number; end: number }

export type DropZone =
  | { kind: 'none' }
  | { kind: 'centre'; cell: CellKey; box: Box }
  | { kind: 'edge'; cell: CellKey; side: Side; box: Box }
  | { kind: 'seam'; axis: 'col' | 'row'; index: number; start: number; end: number; box: Box }

/** How much of a pane, per edge, is "split here" rather than "replace this". */
export const EDGE_FRACTION = 0.25

/**
 * Below this on the axis being cut, an edge zone degrades to `centre`: halving
 * would put a pane under `MIN_PANE_PX`, and a pane at that size has no seam left
 * to grab to bring it back (`resizeFractions`' own reasoning).
 *
 * ponytail: this measures the PANE, not the track the split will actually cut,
 * so a pane spanning several tracks can be refused slightly early. It also
 * ignores the strip's `STRIP_PX`, so a row split is refused ~30px earlier than
 * strictly necessary. Pass a per-axis minimum if anyone hits either.
 */
export const MIN_SPLIT_PX = 2 * MIN_PANE_PX + SEAM_PX

/** Grab band for a seam, inflated from the 1px gap (9px handle) so a seam is
 *  reachable at all — every seam sits wholly inside its neighbours' edge
 *  quarters, so unless it wins outright it can never be hit. */
export const SEAM_HIT_PX = 12

const contains = (b: Box, x: number, y: number) =>
  x >= b.left && x <= b.left + b.width && y >= b.top && y <= b.top + b.height

/** The seam's grab band: at least `SEAM_HIT_PX` on the thin axis, centred on
 *  the seam so the band never favours one neighbour. */
function grabBand(s: SeamBox): Box {
  if (s.axis === 'col') {
    const width = Math.max(s.width, SEAM_HIT_PX)
    return { left: s.left + s.width / 2 - width / 2, top: s.top, width, height: s.height }
  }
  const height = Math.max(s.height, SEAM_HIT_PX)
  return { left: s.left, top: s.top + s.height / 2 - height / 2, width: s.width, height }
}

/** The half of `b` on `side` — what the drop indicator paints for an edge zone.
 *  ponytail: a 1:1-track approximation of the post-split size; the true size
 *  depends on the fractions. */
function half(b: Box, side: Side): Box {
  const { left, top, width, height } = b
  if (side === 'left') return { left, top, width: width / 2, height }
  if (side === 'right') return { left: left + width / 2, top, width: width / 2, height }
  if (side === 'top') return { left, top, width, height: height / 2 }
  return { left, top: top + height / 2, width, height: height / 2 }
}

/**
 * Where a drop at `(x, y)` would go. Priority is seam > strip > edge > centre —
 * and the STRIP is not in this function at all, because it is a real element
 * whose own handler takes the drop before the container's ever sees it. The
 * boxes passed here are pane BODIES, so a strip cannot be hit by accident.
 *
 * THE GEOMETRY, and why it is distances-to-edges rather than four rectangles:
 * with `dl, dr, dt, db` the pointer's normalised distances to the four edges and
 * `m` their minimum, `m >= EDGE_FRACTION` is the centre and otherwise the
 * nearest edge wins. The zones therefore cannot overlap and cannot leave a gap
 * at ANY pane size — the centre is exactly the `[.25, .75]` rectangle, always
 * non-empty, and every other point has a unique nearest edge except on the
 * diagonals. Four hand-placed quarter rectangles collide in the corners of a
 * small pane; this rule is scale-free, and resolving the corners by the pane's
 * diagonals is the dock behaviour a VS / tmux user already expects.
 *
 * Exact ties (the diagonals) break in a FIXED order — left, right, top, bottom —
 * so a pointer parked on a corner picks one side and stays there instead of
 * flickering between two.
 */
export function dropZone(
  panes: readonly PaneBox[],
  seams: readonly SeamBox[],
  x: number,
  y: number,
): DropZone {
  for (const s of seams) {
    const box = grabBand(s)
    if (contains(box, x, y))
      return { kind: 'seam', axis: s.axis, index: s.index, start: s.start, end: s.end, box }
  }

  const p = panes.find((b) => contains(b, x, y))
  if (!p || !(p.width > 0) || !(p.height > 0)) return { kind: 'none' }
  const whole: Box = { left: p.left, top: p.top, width: p.width, height: p.height }

  const d: [Side, number][] = [
    ['left', (x - p.left) / p.width],
    ['right', 1 - (x - p.left) / p.width],
    ['top', (y - p.top) / p.height],
    ['bottom', 1 - (y - p.top) / p.height],
  ]
  // `reduce` keeps the incumbent on a tie, so the array order IS the tie order.
  const [side, m] = d.reduce((best, e) => (e[1] < best[1] ? e : best))
  const horiz = side === 'left' || side === 'right'
  if (m >= EDGE_FRACTION || (horiz ? p.width : p.height) < MIN_SPLIT_PX)
    return { kind: 'centre', cell: p.cell, box: whole }
  return { kind: 'edge', cell: p.cell, side, box: half(whole, side) }
}

/** Stable identity of a zone. The caller compares this against the last one to
 *  decide whether to touch the DOM at all, which is what keeps a pointermove
 *  free of work. Seams reuse `dividerId`, so a zone and its handle agree. */
export function zoneId(z: DropZone): string {
  if (z.kind === 'centre') return `centre:${z.cell}`
  if (z.kind === 'edge') return `edge:${z.cell}:${z.side}`
  if (z.kind === 'seam') return `seam:${dividerId(z)}`
  return 'none'
}
