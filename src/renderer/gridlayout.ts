import type { GridCell, GridLayout } from '../shared/types'

/** Every "col,row" key a cell covers. Overlap is an AREA question, not a
 *  corner one: a 2x2 at (0,0) and a 1x1 at (1,1) collide on exactly one key. */
export function occupies(cell: GridCell): string[] {
  const keys: string[] = []
  for (let r = cell.row; r < cell.row + cell.rowSpan; r++)
    for (let c = cell.col; c < cell.col + cell.colSpan; c++) keys.push(`${c},${r}`)
  return keys
}

/** `ignoreTabId` lets a cell be tested against a layout it already lives in,
 *  so a move or resize does not collide with its own old rectangle. */
export function overlaps(layout: GridLayout, cell: GridCell, ignoreTabId?: string): boolean {
  const taken = new Set(layout.cells.filter((c) => c.tabId !== ignoreTabId).flatMap(occupies))
  return occupies(cell).some((k) => taken.has(k))
}

export function inBounds(layout: GridLayout, cell: GridCell): boolean {
  if (cell.colSpan < 1 || cell.rowSpan < 1) return false
  if (cell.col < 0 || cell.row < 0) return false
  return cell.col + cell.colSpan <= layout.cols && cell.row + cell.rowSpan <= layout.rows
}

/**
 * A rejected drop is a normal outcome, not an error — return the layout
 * unchanged so the caller can just assign the result either way.
 *
 * A tab occupies exactly one cell, so placing a tab that is already in the
 * layout MOVES it. Appending blindly would give one tab two rectangles, and
 * every consumer (render, close, compact) assumes one cell per tab. Its own old
 * rectangle is ignored for the collision test, which is what makes a move to an
 * overlapping-with-itself position legal.
 */
export function place(layout: GridLayout, cell: GridCell): GridLayout {
  if (!inBounds(layout, cell) || overlaps(layout, cell, cell.tabId)) return layout
  return { ...layout, cells: [...layout.cells.filter((c) => c.tabId !== cell.tabId), cell] }
}

export function remove(layout: GridLayout, tabId: string): GridLayout {
  return { ...layout, cells: layout.cells.filter((c) => c.tabId !== tabId) }
}

export function findFree(
  layout: GridLayout,
  colSpan: number,
  rowSpan: number,
): { col: number; row: number } | null {
  for (let row = 0; row < layout.rows; row++)
    for (let col = 0; col < layout.cols; col++) {
      const probe = { tabId: '', col, row, colSpan, rowSpan }
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
 * tabs collapses a 3x3 back to a single pane.
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

/** Which side of a cell a new one goes on. A renderer-level type: the grid
 *  model in `shared/types.ts` has no notion of a direction, only of extents. */
export type Side = 'left' | 'right' | 'top' | 'bottom'

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
 * This is the KAN-56 generalisation of "one keeper cell" to "a run", and it is
 * the SAME set of cells for `split`: a tiled grid cannot contain a second cell
 * that touches the line inside the keeper's cross-extent, because such a cell
 * would have to cover the track just before the line at one of the keeper's
 * rows, which is the keeper's own area. So `split` keeps its exact behaviour
 * and the left/top and seam inserts fall out of the same rule, with no second
 * geometry primitive.
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
  // module's own ponytail note says a grid can carry a hole (see `closePane`),
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
 * and put `tabId` in it.
 *
 * Returns `layout` unchanged when the run is empty or out of bounds, when `at`
 * is out of range, or when `tabId` is falsy. `at === <track count>` is legal and
 * appends at the far edge.
 */
export function insertAt(
  layout: GridLayout,
  axis: 'col' | 'row',
  at: number,
  tabId: string,
  start: number,
  end: number,
): GridLayout {
  const along = axis === 'col' ? layout.cols : layout.rows
  const across = axis === 'col' ? layout.rows : layout.cols
  if (!tabId || end <= start || start < 0 || end > across || at < 0 || at > along) return layout
  return place(
    insertTrack(layout, axis, at, start, end),
    axis === 'col'
      ? { tabId, col: at, row: start, colSpan: 1, rowSpan: end - start }
      : { tabId, col: start, row: at, colSpan: end - start, rowSpan: 1 },
  )
}

/**
 * Split the pane showing `focusedTabId`, putting `tabId` in the new one.
 *
 * A track is INSERTED next to the focused cell rather than appended to the far
 * edge of the grid. Appending is a one-liner and is right for a 1x1, but on a
 * 2x2 it grows the grid to 3 columns while filling only one row of the new
 * column, and the other row gets a hole.
 *
 * The new cell inherits the focused cell's extent on the OTHER axis, so a split
 * never reaches across panes that were not part of it. Splitting a pane that
 * spans two rows therefore costs a THIRD row rather than cutting its neighbours
 * in half — a grid has no way to express half a track, and the alternative
 * (subdividing globally) doubles the track count on every split.
 *
 * No-op (same reference) when nothing is focused in this grid, or when `tabId`
 * already has a pane — a tab owns at most one cell, so "split with a tab that
 * is already on screen" has no meaning that isn't just a move. Track sizes are
 * not this function's business; the track count changes, which is the signal
 * `normalizeFractions` uses to fall back to an even split.
 */
export function split(
  layout: GridLayout,
  focusedTabId: string,
  tabId: string,
  axis: 'col' | 'row',
): GridLayout {
  const f = layout.cells.find((c) => c.tabId === focusedTabId)
  if (!f || !tabId || layout.cells.some((c) => c.tabId === tabId)) return layout
  return axis === 'col'
    ? insertAt(layout, 'col', f.col + f.colSpan, tabId, f.row, f.row + f.rowSpan)
    : insertAt(layout, 'row', f.row + f.rowSpan, tabId, f.col, f.col + f.colSpan)
}

/**
 * Grow the neighbours on ONE side of `hole` to cover it, or null if no single
 * side can cover it exactly.
 *
 * Per-slice rather than "find the one cell that fits": removing a pane whose
 * neighbour on every side is the wrong shape is normal (close the wide pane of
 * `a | b` over `c | d | e` and only the row below can take it, in three
 * pieces). The candidates on a side are the cells that meet its edge and lie
 * entirely within the hole's cross-extent; since a tiled grid gives them
 * disjoint cross-ranges, their spans summing to the hole's is exactly "they
 * cover it, with nothing hanging over".
 */
function absorb(cells: readonly GridCell[], hole: GridCell): GridCell[] | null {
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
    return cells.map((c) => {
      if (!set.has(c)) return c
      if (side === 'left') return { ...c, colSpan: c.colSpan + nearSpan }
      if (side === 'right') return { ...c, col: hole.col, colSpan: c.colSpan + nearSpan }
      if (side === 'up') return { ...c, rowSpan: c.rowSpan + nearSpan }
      return { ...c, row: hole.row, rowSpan: c.rowSpan + nearSpan }
    })
  }
  return null
}

/**
 * Remove a pane. `null` means "there is no split any more" — fewer than two
 * cells left, which renders identically to a full-width single pane and should
 * not keep a focus ring or a divider alive to say otherwise.
 *
 * The rectangle is handed to a neighbour rather than merely deleted, because
 * `compact` can only drop a track that has become empty EVERYWHERE. Closing the
 * top-left of a grid whose other panes still use both of its tracks leaves a
 * hole no amount of compaction can reach.
 *
 * ponytail: when no single side can absorb the rectangle, the cell is just
 * dropped and the hole shows through as the container's seam colour. Reaching
 * that needs a grid the ship-ping split/close actions cannot build (they keep
 * the layout tiled at every step); if free-form drag-to-split ever lands, this
 * is where a real rectangle merge goes.
 */
export function closePane(layout: GridLayout, tabId: string): GridLayout | null {
  const hole = layout.cells.find((c) => c.tabId === tabId)
  if (!hole) return layout
  if (layout.cells.length - 1 < 2) return null
  return vacate(layout, tabId)
}

/**
 * Give `tabId`'s rectangle away and re-rank the tracks — `closePane`'s body,
 * minus its "is there still a split" verdict. Moving a pane elsewhere has to do
 * exactly this first, and doing it any other way leaves the hole `compact`
 * cannot reach (see `closePane`).
 *
 * Unchanged (same reference) when `tabId` has no cell, or when it is the only
 * cell — there is nobody to hand the rectangle to and an empty grid is not a
 * layout this function is allowed to invent.
 */
function vacate(layout: GridLayout, tabId: string): GridLayout {
  const hole = layout.cells.find((c) => c.tabId === tabId)
  const rest = layout.cells.filter((c) => c.tabId !== tabId)
  if (!hole || !rest.length) return layout
  return compact({ ...layout, cells: absorb(rest, hole) ?? rest })
}

/**
 * Put `tabId` in a new cell on `side` of `targetTabId`'s cell.
 *
 * If `tabId` already has a cell it is VACATED first — so this is both "split
 * that pane and show this tab in the new half" and "move this pane over there",
 * which is why there is one function and not two. `place()` is not used
 * directly: place() moves one cell into a FREE rectangle, and there is no free
 * rectangle here — the new one has to be cut out of the grid.
 *
 * No-op (same reference) when the target has no cell (including the case where
 * vacating `tabId` was what removed it), or when the two ids are the same.
 */
export function placeBeside(
  layout: GridLayout,
  tabId: string,
  targetTabId: string,
  side: Side,
): GridLayout {
  if (!tabId || tabId === targetTabId) return layout
  const base = vacate(layout, tabId)
  const t = base.cells.find((c) => c.tabId === targetTabId)
  if (!t) return layout
  const axis = side === 'left' || side === 'right' ? 'col' : 'row'
  const at =
    side === 'left' ? t.col
    : side === 'right' ? t.col + t.colSpan
    : side === 'top' ? t.row
    : t.row + t.rowSpan
  const next =
    axis === 'col'
      ? insertAt(base, 'col', at, tabId, t.row, t.row + t.rowSpan)
      : insertAt(base, 'row', at, tabId, t.col, t.col + t.colSpan)
  return next === base ? layout : next
}

/**
 * Put `tabId` in a NEW full-run track at the seam `axis`/`index` identifies
 * (splitgrid's `Divider.index` is the track BEFORE the seam, so the insert line
 * is `index + 1`), over the cross-axis run `[start, end)` the same `Divider`
 * carries.
 *
 * REFUSES (same reference) when `tabId` already has a cell: vacating compacts,
 * and compaction re-ranks the very track indices this was told about, so the
 * seam the user aimed at would not be the seam that got the track.
 * ponytail: ceiling is "no seam drop for a placed pane" — the edge quarter
 * already serves moving one. Re-derive the seam after the vacate if anyone
 * wants both.
 */
export function placeAtSeam(
  layout: GridLayout,
  tabId: string,
  axis: 'col' | 'row',
  index: number,
  start: number,
  end: number,
): GridLayout {
  if (layout.cells.some((c) => c.tabId === tabId)) return layout
  return insertAt(layout, axis, index + 1, tabId, start, end)
}

/**
 * `tabId` takes over `targetTabId`'s rectangle. When `tabId` already has a cell
 * the two EXCHANGE rectangles; otherwise `targetTabId` is displaced off screen
 * and keeps its place on the strip, which is `showIn`'s existing meaning.
 *
 * Separate from `showIn` on purpose: `showIn` MUST keep no-opping on an
 * already-placed tab, because `selectTab` calls it on every tab click and a
 * click must be a focus move, never a swap. A drop is the explicit gesture that
 * earns the swap.
 *
 * No-op (same reference) when either id is empty, when the target has no cell,
 * or when the two are the same.
 */
export function occupy(layout: GridLayout, tabId: string, targetTabId: string): GridLayout {
  if (!tabId || !targetTabId || tabId === targetTabId) return layout
  const t = layout.cells.find((c) => c.tabId === targetTabId)
  if (!t) return layout
  const own = layout.cells.find((c) => c.tabId === tabId)
  if (!own) return place(remove(layout, targetTabId), { ...t, tabId })
  return {
    ...layout,
    cells: layout.cells.map((c) =>
      c.tabId === tabId ? { ...t, tabId }
      : c.tabId === targetTabId ? { ...own, tabId: targetTabId }
      : c,
    ),
  }
}

/**
 * The tab whose cell shares an edge with `tabId`'s on `dir` — the first cell
 * touching the relevant grid line anywhere in `tabId`'s cross-extent, scanned
 * from that extent's start so the answer is stable rather than array-order.
 * `null` at the grid edge, or when `tabId` has no cell.
 */
export function neighbour(layout: GridLayout, tabId: string, dir: Side): string | null {
  const c = layout.cells.find((x) => x.tabId === tabId)
  if (!c) return null
  const horiz = dir === 'left' || dir === 'right'
  const back = dir === 'left' || dir === 'top'
  const near = horiz ? c.col : c.row
  const line = back ? near : near + (horiz ? c.colSpan : c.rowSpan)
  const far = horiz ? c.row : c.col
  const farSpan = horiz ? c.rowSpan : c.colSpan
  return (
    layout.cells
      .filter((o) => {
        if (o.tabId === tabId) return false
        const on = horiz ? o.col : o.row
        const os = horiz ? o.colSpan : o.rowSpan
        const of = horiz ? o.row : o.col
        const ofs = horiz ? o.rowSpan : o.colSpan
        // Overlap, not containment: a wide neighbour still shares the edge.
        return (back ? on + os === line : on === line) && of < far + farSpan && of + ofs > far
      })
      .sort((a, b) => (horiz ? a.row - b.row : a.col - b.col))[0]?.tabId ?? null
  )
}

/**
 * Can `count` panes tile EXACTLY `cols` x `rows` — every cell filled, every row
 * and every column used, nothing dropped?
 *
 * The grid picker greys out precisely what this refuses and `reflow` returns
 * null for precisely the same picks, so what was previewed and what gets built
 * cannot drift apart. Three clauses: no empty column, a cell for every pane, no
 * empty row.
 */
export function canReflow(count: number, cols: number, rows: number): boolean {
  if (count < 1 || cols < 1 || rows < 1) return false
  return cols <= count && cols * rows >= count && rows <= Math.ceil(count / cols)
}

/**
 * Re-tile `tabIds` (STRIP ORDER) into `cols` x `rows`: row-major via `findFree`,
 * then the last cell of each row stretched to the right edge so a short final
 * row still tiles completely rather than leaving a hole. `null` when `canReflow`
 * refuses, which the caller treats as "no state change".
 *
 * `findFree` + `place` + `compact` do all the work; there is no packer here.
 */
export function reflow(
  tabIds: readonly string[],
  cols: number,
  rows: number,
): GridLayout | null {
  if (!canReflow(tabIds.length, cols, rows)) return null
  let out: GridLayout = { cols, rows, cells: [] }
  for (const tabId of tabIds) {
    const free = findFree(out, 1, 1)
    if (!free) break // unreachable: canReflow guarantees cols * rows >= count
    out = place(out, { tabId, ...free, colSpan: 1, rowSpan: 1 })
  }
  const cells = out.cells.map((c) =>
    out.cells.some((o) => o.row === c.row && o.col > c.col) ? c : { ...c, colSpan: cols - c.col },
  )
  return compact({ ...out, cells })
}

/**
 * Show `tabId` in the pane that currently holds `focusedTabId` — clicking a tab
 * on the strip while a split is up retargets the focused pane instead of
 * opening another one. The displaced tab keeps its place on the strip and
 * simply stops being visible; a space member with no cell is a normal state.
 *
 * No-op (same reference) when `tabId` already has a pane of its own (clicking a
 * tab you can already see just moves focus to it), or when the focused tab has
 * no pane to retarget.
 */
export function showIn(layout: GridLayout, focusedTabId: string, tabId: string): GridLayout {
  if (!tabId || tabId === focusedTabId) return layout
  if (layout.cells.some((c) => c.tabId === tabId)) return layout
  const f = layout.cells.find((c) => c.tabId === focusedTabId)
  if (!f) return layout
  return place(remove(layout, focusedTabId), { ...f, tabId })
}

export function single(tabId: string): GridLayout {
  return { cols: 1, rows: 1, cells: [{ tabId, col: 0, row: 0, colSpan: 1, rowSpan: 1 }] }
}
