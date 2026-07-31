import type { GridCell, GridLayout } from '../shared/types'

/**
 * KAN-56: a cell is a WINDOW, not a tab. It owns an ordered `tabIds` (its own
 * strip) and an `activeTabId` (what it is showing). Every operation here is
 * therefore one of two kinds — it moves a TAB between strips, or it moves a
 * RECTANGLE around the grid — and the two never share a function, because the
 * old model's conflation of them is exactly what stopped working.
 *
 * THE INVARIANTS, enforced HERE rather than asked of callers:
 *  - a tab is in EXACTLY ONE cell (`place` refuses a cell whose tabs are
 *    already claimed; every insert in this module goes through `place`);
 *  - cells never overlap and never leave the grid (`place` again);
 *  - a cell is never empty and its `activeTabId` is always a member (`place`
 *    normalises both);
 *  - losing your last tab removes the cell, hands its rectangle to a
 *    neighbour and re-ranks the tracks.
 *
 * Convention, unchanged: a REFUSED operation returns the SAME REFERENCE, so a
 * caller can assign unconditionally and the debounced persist stays identity
 * stable.
 */

/** Which side of a cell a new one goes on. A renderer-level type: the grid
 *  model in `shared/types.ts` has no notion of a direction, only of extents. */
export type Side = 'left' | 'right' | 'top' | 'bottom'

/** `${col},${row}` — a cell's anchor, unique by the no-overlap invariant, which
 *  is why no cell carries an id. A key is only valid against the layout it was
 *  read from: `compact` re-ranks tracks, so anything that vacates a cell
 *  invalidates every key it did not itself return. */
export type CellKey = string

export function cellKey(c: { col: number; row: number }): CellKey {
  return `${c.col},${c.row}`
}

export function cellAt(layout: GridLayout, key: CellKey): GridCell | null {
  return layout.cells.find((c) => cellKey(c) === key) ?? null
}

/** The cell holding `tabId` — exactly one, by the invariant. */
export function cellOf(layout: GridLayout, tabId: string): GridCell | null {
  return layout.cells.find((c) => c.tabIds.includes(tabId)) ?? null
}

/** Cells by row then col. THE canonical order: `reflow` tiles in it,
 *  `closeCell` falls back to it, and `Space.tabIds` is its concatenation. */
export function readingOrder(layout: GridLayout): GridCell[] {
  return byReading(layout.cells)
}

function byReading(cells: readonly GridCell[]): GridCell[] {
  return [...cells].sort((a, b) => a.row - b.row || a.col - b.col)
}

/** `readingOrder` flattened to tab ids. `Space.tabIds` MUST equal this while a
 *  layout is present, which is what makes collapsing back to `layout: null`
 *  free — the single strip reads exactly like the panes did. */
export function layoutTabIds(layout: GridLayout): string[] {
  return readingOrder(layout).flatMap((c) => c.tabIds)
}

/** Every "col,row" key a cell covers. Overlap is an AREA question, not a
 *  corner one: a 2x2 at (0,0) and a 1x1 at (1,1) collide on exactly one key. */
export function occupies(cell: GridCell): string[] {
  const keys: string[] = []
  for (let r = cell.row; r < cell.row + cell.rowSpan; r++)
    for (let c = cell.col; c < cell.col + cell.colSpan; c++) keys.push(`${c},${r}`)
  return keys
}

/** `ignore` lets a cell be tested against a layout it already lives in, so a
 *  resize at the same anchor does not collide with its own old rectangle. */
export function overlaps(layout: GridLayout, cell: GridCell, ignore?: CellKey): boolean {
  const taken = new Set(layout.cells.filter((c) => cellKey(c) !== ignore).flatMap(occupies))
  return occupies(cell).some((k) => taken.has(k))
}

export function inBounds(layout: GridLayout, cell: GridCell): boolean {
  if (cell.colSpan < 1 || cell.rowSpan < 1) return false
  if (cell.col < 0 || cell.row < 0) return false
  return cell.col + cell.colSpan <= layout.cols && cell.row + cell.rowSpan <= layout.rows
}

/**
 * Add `cell`, replacing whatever sits at the SAME anchor. A rejected drop is a
 * normal outcome, not an error — the layout comes back unchanged so the caller
 * can just assign the result either way.
 *
 * THIS IS THE CHOKEPOINT for the model's invariants, and the reason none of
 * them is a caller's obligation: every insert in this module (`insertAt`,
 * `reflow`) lands here. It refuses a cell with no tabs, a cell that repeats a
 * tab, and a cell holding a tab some OTHER cell already has — the last being
 * the "a tab in two panes" bug, which would give one terminal two hosts. An
 * `activeTabId` that is not a member is repaired rather than refused: it is a
 * stale pointer, not a structural fault.
 */
export function place(layout: GridLayout, cell: GridCell): GridLayout {
  const key = cellKey(cell)
  if (!cell.tabIds.length || new Set(cell.tabIds).size !== cell.tabIds.length) return layout
  if (!inBounds(layout, cell) || overlaps(layout, cell, key)) return layout
  const claimed = new Set(
    layout.cells.filter((c) => cellKey(c) !== key).flatMap((c) => c.tabIds),
  )
  if (cell.tabIds.some((id) => claimed.has(id))) return layout
  const norm =
    cell.tabIds.includes(cell.activeTabId) ? cell : { ...cell, activeTabId: cell.tabIds[0] }
  return { ...layout, cells: [...layout.cells.filter((c) => cellKey(c) !== key), norm] }
}

export function findFree(
  layout: GridLayout,
  colSpan: number,
  rowSpan: number,
): { col: number; row: number } | null {
  for (let row = 0; row < layout.rows; row++)
    for (let col = 0; col < layout.cols; col++) {
      const probe: GridCell = { tabIds: [], activeTabId: '', col, row, colSpan, rowSpan }
      if (inBounds(layout, probe) && !overlaps(layout, probe)) return { col, row }
    }
  return null
}

/** Every track index the cells actually occupy on one axis, ascending. */
function occupiedTracks(cells: readonly GridCell[], axis: 'col' | 'row'): number[] {
  const used = new Set<number>()
  for (const c of cells) {
    const start = axis === 'col' ? c.col : c.row
    const span = axis === 'col' ? c.colSpan : c.rowSpan
    for (let i = 0; i < span; i++) used.add(start + i)
  }
  return [...used].sort((a, b) => a - b)
}

/**
 * Drops every track no cell occupies, minimum 1x1 — so closing two of three
 * panes collapses a 3x3 back to a single one.
 *
 * INTERIOR empty tracks go too, not just leading/trailing ones, and that is the
 * whole reason this is not `Math.min`/`Math.max` on the bounds. Closing the
 * MIDDLE pane of a 1x3 leaves cells at columns 0 and 2 of a 3-column grid: a
 * bounds-only compaction keeps `cols: 3` and renders a third of the window as
 * an empty gap between two panes.
 *
 * Spans are carried through untouched, deliberately: a track inside a cell's
 * own span is occupied BY that cell, so it can never be one of the ones that
 * goes. A surviving cell's tracks stay contiguous, so its new position is just
 * its old one re-ranked.
 *
 * ponytail: the rank lookup is O(cells x tracks). A grid is a handful of panes
 * on a screen; if that ever stops being true, precompute an index map.
 */
export function compact(layout: GridLayout): GridLayout {
  if (!layout.cells.length) return { cols: 1, rows: 1, cells: [] }
  const cols = occupiedTracks(layout.cells, 'col')
  const rows = occupiedTracks(layout.cells, 'row')
  const at = (keep: number[], v: number) => keep.filter((k) => k < v).length
  const cells = layout.cells.map((c) => ({ ...c, col: at(cols, c.col), row: at(rows, c.row) }))
  return { cols: Math.max(1, cols.length), rows: Math.max(1, rows.length), cells }
}

/**
 * Adds a track before index `at`, claimed over the cross-axis run `[start, end)`.
 *
 * One rule decides every cell: OUTSIDE the run the new track belongs to nobody,
 * so someone must absorb it or a hole opens; INSIDE the run it belongs to the
 * incoming pane, so everyone yields it. Absorbing is always "span + 1" — the
 * only question is from which side, and the cell that ENDS on the line is
 * preferred (it was the thing covering the track the line was cut out of).
 * A cell that STARTS on the line only absorbs when there is no such ender at its
 * cross positions, which in a tiled grid means exactly one thing: the line is
 * the grid's own leading edge, i.e. a left/top insert. Everything else shifts.
 *
 * This is the generalisation of "one keeper cell" to "a run", and it is the
 * SAME set of cells for a plain split: a tiled grid cannot contain a second
 * cell that touches the line inside the keeper's cross-extent, because such a
 * cell would have to cover the track just before the line at one of the
 * keeper's rows, which is the keeper's own area. So `splitCell`, the left/top
 * inserts and the seam insert all fall out of one rule, with no second geometry
 * primitive.
 *
 * Private: an inserted track with nothing in it is precisely the gap `compact`
 * exists to remove, so `insertAt` is the only sane way to reach this.
 */
function insertTrack(
  layout: GridLayout,
  axis: 'col' | 'row',
  at: number,
  start: number,
  end: number,
): GridLayout {
  const col = axis === 'col'
  const near = (c: GridCell) => (col ? c.col : c.row)
  const nearSpan = (c: GridCell) => (col ? c.colSpan : c.rowSpan)
  const far = (c: GridCell) => (col ? c.row : c.col)
  const farSpan = (c: GridCell) => (col ? c.rowSpan : c.colSpan)
  const grow = (c: GridCell) => (col ? { ...c, colSpan: c.colSpan + 1 } : { ...c, rowSpan: c.rowSpan + 1 })
  const shift = (c: GridCell) => (col ? { ...c, col: c.col + 1 } : { ...c, row: c.row + 1 })
  // Is some OTHER cell going to absorb the track from the left at c's cross
  // positions? Asked per cell rather than assumed from `at > 0`, because this
  // module's own ponytail note says a grid can carry a hole (see `vacateCell`),
  // and over a hole there is nothing on the left to absorb anything.
  const ender = (c: GridCell) =>
    layout.cells.some(
      (o) =>
        o !== c &&
        near(o) + nearSpan(o) === at &&
        far(o) < far(c) + farSpan(c) &&
        far(o) + farSpan(o) > far(c),
    )

  const cells = layout.cells.map((c) => {
    const inRun = far(c) >= start && far(c) + farSpan(c) <= end
    if (near(c) + nearSpan(c) < at) return c // entirely before the line
    if (near(c) + nearSpan(c) === at) return inRun ? c : grow(c) // ends on it
    if (near(c) < at) return grow(c) // straddles it, so it must widen either way
    if (near(c) === at && !inRun && !ender(c)) return grow(c) // absorbs leftwards
    return shift(c)
  })
  return col
    ? { ...layout, cols: layout.cols + 1, cells }
    : { ...layout, rows: layout.rows + 1, cells }
}

/**
 * Insert a track at grid line `at` on `axis`, spanning cross-axis `[start, end)`,
 * and put a NEW cell holding `tabIds` in it.
 *
 * Returns `layout` unchanged when the run is empty or out of bounds, when `at`
 * is out of range, or when `place` refuses the cell (no tabs, or a tab that is
 * still claimed elsewhere). `at === <track count>` is legal and appends at the
 * far edge.
 */
function insertAt(
  layout: GridLayout,
  axis: 'col' | 'row',
  at: number,
  tabIds: readonly string[],
  activeTabId: string,
  start: number,
  end: number,
): GridLayout {
  const along = axis === 'col' ? layout.cols : layout.rows
  const across = axis === 'col' ? layout.rows : layout.cols
  if (!tabIds.length || end <= start || start < 0 || end > across || at < 0 || at > along)
    return layout
  const ids = [...tabIds]
  const grown = insertTrack(layout, axis, at, start, end)
  const next = place(
    grown,
    axis === 'col'
      ? { tabIds: ids, activeTabId, col: at, row: start, colSpan: 1, rowSpan: end - start }
      : { tabIds: ids, activeTabId, col: start, row: at, colSpan: end - start, rowSpan: 1 },
  )
  return next === grown ? layout : next
}

/**
 * Grow the neighbours on ONE side of `hole` to cover it, and report which cells
 * grew — the closing pane's TABS have to go somewhere, and the cell that took
 * its floor space is the one the user will read them as having moved into.
 * `null` if no single side can cover the rectangle exactly.
 *
 * Per-slice rather than "find the one cell that fits": removing a pane whose
 * neighbour on every side is the wrong shape is normal (close the wide pane of
 * `a | b` over `c | d | e` and only the row below can take it, in three
 * pieces). The candidates on a side are the cells that meet its edge and lie
 * entirely within the hole's cross-extent; since a tiled grid gives them
 * disjoint cross-ranges, their spans summing to the hole's is exactly "they
 * cover it, with nothing hanging over".
 */
function absorb(
  cells: readonly GridCell[],
  hole: GridCell,
): { cells: GridCell[]; receiver: GridCell } | null {
  for (const side of ['left', 'right', 'up', 'down'] as const) {
    const horiz = side === 'left' || side === 'right'
    const near = horiz ? hole.col : hole.row
    const nearSpan = horiz ? hole.colSpan : hole.rowSpan
    const far = horiz ? hole.row : hole.col
    const farSpan = horiz ? hole.rowSpan : hole.colSpan
    const back = side === 'left' || side === 'up'
    const edge = back ? near : near + nearSpan

    const grow = cells.filter((c) => {
      const cn = horiz ? c.col : c.row
      const cs = horiz ? c.colSpan : c.rowSpan
      const cf = horiz ? c.row : c.col
      const cfs = horiz ? c.rowSpan : c.colSpan
      return (back ? cn + cs === edge : cn === edge) && cf >= far && cf + cfs <= far + farSpan
    })
    if (!grow.length) continue
    if (grow.reduce((n, c) => n + (horiz ? c.rowSpan : c.colSpan), 0) !== farSpan) continue

    const set = new Set(grow)
    return {
      cells: cells.map((c) => {
        if (!set.has(c)) return c
        if (side === 'left') return { ...c, colSpan: c.colSpan + nearSpan }
        if (side === 'right') return { ...c, col: hole.col, colSpan: c.colSpan + nearSpan }
        if (side === 'up') return { ...c, rowSpan: c.rowSpan + nearSpan }
        return { ...c, row: hole.row, rowSpan: c.rowSpan + nearSpan }
      }),
      receiver: byReading(grow)[0],
    }
  }
  return null
}

/**
 * Give a cell's rectangle away and re-rank the tracks.
 *
 * The rectangle is handed to a neighbour rather than merely deleted, because
 * `compact` can only drop a track that has become empty EVERYWHERE. Closing the
 * top-left of a grid whose other panes still use both of its tracks leaves a
 * hole no amount of compaction can reach.
 *
 * `receiver` is a TAB ID, not a cell: compaction rebuilds every cell object and
 * re-ranks anchors, so a `GridCell` or a `CellKey` measured before the vacate is
 * stale afterwards. A tab id is the only handle that survives.
 *
 * Unchanged (same reference) when `key` names no cell, or when it is the only
 * cell — there is nobody to hand the rectangle to, and an empty grid is not a
 * layout this function is allowed to invent.
 *
 * ponytail: when no single side can absorb the rectangle, the cell is just
 * dropped and the hole shows through as the container's seam colour (the tabs
 * still go to the first remaining cell, so nothing is lost). Reaching that
 * needs a grid the shipping actions cannot build — they keep the layout tiled
 * at every step; if free-form pane resize ever lands, this is where a real
 * rectangle merge goes.
 */
function vacateCell(layout: GridLayout, key: CellKey): { layout: GridLayout; receiver: string } {
  const hole = cellAt(layout, key)
  const rest = layout.cells.filter((c) => c !== hole)
  if (!hole || !rest.length) return { layout, receiver: '' }
  const taken = absorb(rest, hole)
  const receiver = (taken?.receiver ?? byReading(rest)[0]).tabIds[0] ?? ''
  return { layout: compact({ ...layout, cells: taken?.cells ?? rest }), receiver }
}

/** Drop `tabId` from its cell, repairing `activeTabId` by taking the tab that
 *  slid into its strip position (the last one, if it was the last). */
function withoutTab(c: GridCell, tabId: string): GridCell {
  const i = c.tabIds.indexOf(tabId)
  if (i < 0) return c
  const tabIds = c.tabIds.filter((id) => id !== tabId)
  return {
    ...c,
    tabIds,
    activeTabId: c.activeTabId === tabId ? (tabIds[Math.min(i, tabIds.length - 1)] ?? '') : c.activeTabId,
  }
}

/** Take `tabId` out of the grid entirely: off its strip, and if that was the
 *  strip's last tab, the cell goes and its rectangle is absorbed. Identity when
 *  the tab is in no cell (a brand-new tab being placed for the first time). */
function pullTab(layout: GridLayout, tabId: string): GridLayout {
  const c = cellOf(layout, tabId)
  if (!c) return layout
  if (c.tabIds.length > 1)
    return { ...layout, cells: layout.cells.map((x) => (x === c ? withoutTab(x, tabId) : x)) }
  return vacateCell(layout, cellKey(c)).layout
}

// --- tab-set operations ----------------------------------------------------

/** Make `tabId` the active tab of the cell that holds it. This is what a strip
 *  click is; it deliberately does NOT reorder the strip. */
export function showTab(layout: GridLayout, tabId: string): GridLayout {
  const c = cellOf(layout, tabId)
  if (!c || c.activeTabId === tabId) return layout
  return { ...layout, cells: layout.cells.map((x) => (x === c ? { ...x, activeTabId: tabId } : x)) }
}

/**
 * Move `tabId` into cell `key` at strip index `insert` (post-splice; default =
 * append). Removes it from whatever cell held it — and if that empties the
 * source, the source cell is removed, its rectangle absorbed and the grid
 * compacted. A `tabId` in NO cell is legal and means "add it here", which is
 * how a newly opened tab joins a pane; there is no second `addTab` for that.
 *
 * A CROSS-pane move makes the tab active in its new pane, which is what
 * dragging a tab into another browser window does and what makes the gesture
 * legible. A move WITHIN one pane is a strip reorder and leaves `activeTabId`
 * alone (KAN-56 decision 1: a strip drag must not change what is shown).
 *
 * IMPLEMENTATION NOTE (the bug not to ship): vacating the source COMPACTS,
 * which re-ranks anchors, so `key` is stale afterwards. The destination is
 * resolved to one of its own tab ids first and re-found by that.
 *
 * Refuses (same reference) when `key` names no cell, or when the tab is the
 * source cell's only tab AND `key` is that same cell.
 */
export function moveTab(
  layout: GridLayout,
  tabId: string,
  key: CellKey,
  insert?: number,
): GridLayout {
  if (!tabId) return layout
  const dest = cellAt(layout, key)
  if (!dest) return layout
  const src = cellOf(layout, tabId)
  const same = !!src && cellKey(src) === key
  if (same && src.tabIds.length === 1) return layout

  const anchorId = dest.tabIds.find((id) => id !== tabId)
  if (!anchorId) return layout // dest holds only this tab: nothing to move
  const base = pullTab(layout, tabId)
  const target = cellOf(base, anchorId)
  if (!target) return layout

  const ids = [...target.tabIds]
  ids.splice(Math.max(0, Math.min(insert ?? ids.length, ids.length)), 0, tabId)
  const activeTabId = same ? target.activeTabId : tabId
  return { ...base, cells: base.cells.map((c) => (c === target ? { ...c, tabIds: ids, activeTabId } : c)) }
}

/**
 * Replace one cell's strip order — the write behind a within-strip drag, a
 * pin, or a group reshuffle.
 *
 * REFUSES anything that is not a permutation of that cell's current ids. The
 * group and pin helpers (`groups.ts`) compose over a cell's slice and are
 * generic over "a list of tab records"; a bug there must not be able to add a
 * tab to this pane or lose one out of it. `activeTabId` is preserved, since
 * reordering a strip is not a focus change.
 */
export function setCellTabs(
  layout: GridLayout,
  key: CellKey,
  tabIds: readonly string[],
): GridLayout {
  const c = cellAt(layout, key)
  if (!c || tabIds.length !== c.tabIds.length) return layout
  const have = new Set(c.tabIds)
  if (new Set(tabIds).size !== tabIds.length || tabIds.some((id) => !have.has(id))) return layout
  return { ...layout, cells: layout.cells.map((x) => (x === c ? { ...x, tabIds: [...tabIds] } : x)) }
}

/**
 * A tab was CLOSED. Drops it from its cell; if that was the cell's last tab the
 * cell goes, its rectangle is absorbed and the grid compacted.
 *
 * `null` means "there is no split any more" — fewer than two cells left, which
 * renders identically to a single full-width pane and should not keep a focus
 * ring or a divider alive to say otherwise. Nothing is lost: `layout: null` is
 * shorthand for one pane holding every tab of the space.
 */
export function removeTab(layout: GridLayout, tabId: string): GridLayout | null {
  const c = cellOf(layout, tabId)
  if (!c) return layout
  if (c.tabIds.length > 1)
    return { ...layout, cells: layout.cells.map((x) => (x === c ? withoutTab(x, tabId) : x)) }
  if (layout.cells.length - 1 < 2) return null
  return vacateCell(layout, cellKey(c)).layout
}

/**
 * Close a PANE without closing its tabs: they are appended, in order, to the
 * cell that absorbs its rectangle (first in reading order among those that
 * grew), or to the first remaining cell in reading order when no single side
 * could absorb it.
 *
 * `null` when fewer than two cells would remain — the caller then sets
 * `layout: null`, whose implicit single pane holds everything, so the tabs
 * survive that path too.
 */
export function closeCell(layout: GridLayout, key: CellKey): GridLayout | null {
  const hole = cellAt(layout, key)
  if (!hole) return layout
  if (layout.cells.length - 1 < 2) return null
  const { layout: next, receiver } = vacateCell(layout, key)
  const r = receiver ? cellOf(next, receiver) : null
  if (!r) return next
  return {
    ...next,
    cells: next.cells.map((c) => (c === r ? { ...c, tabIds: [...c.tabIds, ...hole.tabIds] } : c)),
  }
}

// --- cell / rectangle operations -------------------------------------------

const axisOf = (side: Side) => (side === 'left' || side === 'right' ? 'col' : 'row')

/** The grid line a new track goes on to land on `side` of `t`. */
function lineFor(t: GridCell, side: Side): number {
  return side === 'left' ? t.col
    : side === 'right' ? t.col + t.colSpan
    : side === 'top' ? t.row
    : t.row + t.rowSpan
}

/**
 * Split cell `key` on `side` and MOVE `tabId` into the new half. `tabId` may
 * come from any cell, or from none (splitting out a tab that has just been
 * opened).
 *
 * A track is INSERTED next to the target rather than appended to the far edge
 * of the grid. Appending is a one-liner and is right for a 1x1, but on a 2x2 it
 * grows the grid to 3 columns while filling only one row of the new column, and
 * the other row gets a hole.
 *
 * The new cell inherits the target's extent on the OTHER axis, so a split never
 * reaches across panes that were not part of it. Splitting a pane that spans
 * two rows therefore costs a THIRD row rather than cutting its neighbours in
 * half — a grid has no way to express half a track, and the alternative
 * (subdividing globally) doubles the track count on every split.
 *
 * Refuses (same reference) when the target has no cell, or when `tabId` is the
 * SOLE tab of the target: that would empty the very pane it is cutting.
 * Track sizes are not this function's business; the track count changes, which
 * is the signal `normalizeFractions` uses to fall back to an even split.
 */
export function splitCell(
  layout: GridLayout,
  key: CellKey,
  tabId: string,
  side: Side,
): GridLayout {
  const t0 = cellAt(layout, key)
  if (!t0 || !tabId) return layout
  // Anchor the target by a tab it KEEPS: pulling `tabId` may empty its own cell
  // and compact, which re-ranks `key` out from under us.
  const anchorId = t0.tabIds.find((id) => id !== tabId)
  if (!anchorId) return layout
  const base = pullTab(layout, tabId)
  const t = cellOf(base, anchorId)
  if (!t) return layout
  const at = lineFor(t, side)
  const next =
    axisOf(side) === 'col'
      ? insertAt(base, 'col', at, [tabId], tabId, t.row, t.row + t.rowSpan)
      : insertAt(base, 'row', at, [tabId], tabId, t.col, t.col + t.colSpan)
  return next === base ? layout : next
}

/**
 * Put `tabId` in a NEW full-run track at the seam `axis`/`index` identifies
 * (splitgrid's `Divider.index` is the track BEFORE the seam, so the insert line
 * is `index + 1`), over the cross-axis run `[start, end)` the same `Divider`
 * carries.
 *
 * REFUSES (same reference) when `tabId` is the SOLE tab of its cell: taking it
 * out would remove that cell and compact, and compaction re-ranks the very
 * track indices the caller measured, so the seam the user aimed at would not be
 * the seam that got the track. With a strip of two or more nothing is removed,
 * so the indices stand.
 */
export function insertAtSeam(
  layout: GridLayout,
  tabId: string,
  axis: 'col' | 'row',
  index: number,
  start: number,
  end: number,
): GridLayout {
  const c = cellOf(layout, tabId)
  if (c && c.tabIds.length === 1) return layout
  const base = pullTab(layout, tabId)
  const next = insertAt(base, axis, index + 1, [tabId], tabId, start, end)
  return next === base ? layout : next
}

/**
 * A onto B: the two cells EXCHANGE rectangles, tab sets and active tabs intact.
 * No track count changes, so BOTH axes' fractions survive a pane swap — which
 * is the whole reason this is not "vacate A, insert beside B".
 */
export function swapCells(layout: GridLayout, a: CellKey, b: CellKey): GridLayout {
  if (a === b) return layout
  const ca = cellAt(layout, a)
  const cb = cellAt(layout, b)
  if (!ca || !cb) return layout
  const rect = (c: GridCell) => ({ col: c.col, row: c.row, colSpan: c.colSpan, rowSpan: c.rowSpan })
  const ra = rect(ca)
  const rb = rect(cb)
  return {
    ...layout,
    cells: layout.cells.map((c) => (c === ca ? { ...ca, ...rb } : c === cb ? { ...cb, ...ra } : c)),
  }
}

/**
 * Move cell `key`, tab set intact, to a new cell on `side` of `target`.
 *
 * Vacate + compact + insert, not `place`: `place` moves a cell into a FREE
 * rectangle and there is no free rectangle here — the new one has to be cut out
 * of the grid. Same stale-anchor rule as `moveTab`, so the target is re-found by
 * one of its tab ids after the vacate.
 */
export function moveCellBeside(
  layout: GridLayout,
  key: CellKey,
  target: CellKey,
  side: Side,
): GridLayout {
  if (key === target) return layout
  const src = cellAt(layout, key)
  const t0 = cellAt(layout, target)
  if (!src || !t0) return layout
  const anchorId = t0.tabIds[0]
  const { layout: base } = vacateCell(layout, key)
  if (base === layout) return layout
  const t = cellOf(base, anchorId)
  if (!t) return layout
  const at = lineFor(t, side)
  const next =
    axisOf(side) === 'col'
      ? insertAt(base, 'col', at, src.tabIds, src.activeTabId, t.row, t.row + t.rowSpan)
      : insertAt(base, 'row', at, src.tabIds, src.activeTabId, t.col, t.col + t.colSpan)
  return next === base ? layout : next
}

/**
 * The cell whose rectangle shares an edge with `key`'s on `dir` — the first one
 * touching the relevant grid line anywhere in `key`'s cross-extent, scanned
 * from that extent's start so the answer is stable rather than array-order.
 * `null` at the grid edge, or when `key` names no cell.
 */
export function neighbour(layout: GridLayout, key: CellKey, dir: Side): CellKey | null {
  const c = cellAt(layout, key)
  if (!c) return null
  const horiz = dir === 'left' || dir === 'right'
  const back = dir === 'left' || dir === 'top'
  const near = horiz ? c.col : c.row
  const line = back ? near : near + (horiz ? c.colSpan : c.rowSpan)
  const far = horiz ? c.row : c.col
  const farSpan = horiz ? c.rowSpan : c.colSpan
  const hit = layout.cells
    .filter((o) => {
      if (o === c) return false
      const on = horiz ? o.col : o.row
      const os = horiz ? o.colSpan : o.rowSpan
      const of = horiz ? o.row : o.col
      const ofs = horiz ? o.rowSpan : o.colSpan
      // Overlap, not containment: a wide neighbour still shares the edge.
      return (back ? on + os === line : on === line) && of < far + farSpan && of + ofs > far
    })
    .sort((a, b) => (horiz ? a.row - b.row : a.col - b.col))[0]
  return hit ? cellKey(hit) : null
}

/**
 * Can `count` panes tile `cols` x `rows` with NO EMPTY TRACK — every row and
 * every column carrying at least one pane?
 *
 * The grid picker greys out precisely what this refuses and `reflow` returns
 * null for precisely the same picks, so what was previewed and what gets built
 * cannot drift apart.
 *
 * KAN-56 dropped the old third clause `cols * rows >= count`. It existed only
 * to refuse a target smaller than the pane count, and merging is now the
 * decided behaviour: picking 1x1 is how you get back to classic tabs, with
 * every tab preserved. What is left is exactly "no empty track".
 */
export function canReflow(count: number, cols: number, rows: number): boolean {
  if (count < 1 || cols < 1 || rows < 1) return false
  return cols <= count && rows <= Math.ceil(count / cols)
}

/**
 * Re-tile the EXISTING cells into `cols` x `rows`, tab sets carried through:
 * reading order, row-major via `findFree`, then the last cell of each row
 * stretched to the right edge so a short final row tiles completely rather than
 * leaving a hole. `null` when `canReflow` refuses, which the caller treats as
 * "no state change".
 *
 * When the target has FEWER cells than the source, panes MERGE in contiguous
 * balanced chunks — the first `n % m` targets take one extra — and the chunk's
 * first pane's `activeTabId` is what the merged pane shows. Nothing is ever
 * closed and no PTY dies; a merge is the reverse of a split, not a delete.
 *
 * `findFree` + `place` + `compact` do all the work; there is no packer here.
 */
export function reflow(layout: GridLayout, cols: number, rows: number): GridLayout | null {
  const src = readingOrder(layout)
  const n = src.length
  if (!canReflow(n, cols, rows)) return null

  const m = cols * rows
  const chunks: GridCell[][] = []
  if (m >= n) for (const c of src) chunks.push([c])
  else {
    const extra = n % m
    const base = Math.floor(n / m)
    for (let k = 0, i = 0; k < m; k++) {
      const take = base + (k < extra ? 1 : 0)
      chunks.push(src.slice(i, i + take))
      i += take
    }
  }

  let out: GridLayout = { cols, rows, cells: [] }
  for (const chunk of chunks) {
    const free = findFree(out, 1, 1)
    if (!free) break // unreachable: chunks.length <= cols * rows by construction
    out = place(out, {
      tabIds: chunk.flatMap((c) => c.tabIds),
      activeTabId: chunk[0].activeTabId,
      ...free,
      colSpan: 1,
      rowSpan: 1,
    })
  }
  const cells = out.cells.map((c) =>
    out.cells.some((o) => o.row === c.row && o.col > c.col) ? c : { ...c, colSpan: cols - c.col },
  )
  return compact({ ...out, cells })
}

/** A 1x1 layout holding every id — the base the FIRST split is cut out of, and
 *  the explicit form of what `layout: null` already means. */
export function single(tabIds: readonly string[], activeTabId: string): GridLayout {
  const ids = [...tabIds]
  if (!ids.length) return { cols: 1, rows: 1, cells: [] }
  return {
    cols: 1,
    rows: 1,
    cells: [
      {
        tabIds: ids,
        activeTabId: ids.includes(activeTabId) ? activeTabId : ids[0],
        col: 0,
        row: 0,
        colSpan: 1,
        rowSpan: 1,
      },
    ],
  }
}
