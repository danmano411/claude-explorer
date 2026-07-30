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

/**
 * Adds a track before index `at`, on behalf of a split of `keeper`'s cell.
 *
 * The tricky third case is what makes a split of one pane in a 2x2 tile. A cell
 * that STRADDLES the new line must widen — obviously — but so must every cell
 * that merely ENDS on it, because it was the thing covering the track the new
 * line was cut out of, at its own rows. `keeper` is the exception: the new pane
 * takes that track over exactly `keeper`'s extent, so `keeper` stays as it is.
 *
 * That exception is safe because a tiled grid cannot contain a second cell that
 * touches the line inside `keeper`'s cross-extent: such a cell would have to
 * cover the track just before the line at one of `keeper`'s rows, which is
 * `keeper`'s own area. So "ends on the line and isn't the keeper" is exactly
 * "should absorb the new track", with no cross-axis test needed.
 *
 * Private: an inserted track with nothing in it is precisely the gap `compact`
 * exists to remove, so `split` is the only sane way to reach this.
 */
function insertTrack(
  layout: GridLayout,
  axis: 'col' | 'row',
  at: number,
  keeper: string,
): GridLayout {
  const cells = layout.cells.map((c) => {
    const start = axis === 'col' ? c.col : c.row
    const span = axis === 'col' ? c.colSpan : c.rowSpan
    if (start >= at) return axis === 'col' ? { ...c, col: c.col + 1 } : { ...c, row: c.row + 1 }
    const widen = start + span > at || (start + span === at && c.tabId !== keeper)
    if (!widen) return c
    return axis === 'col' ? { ...c, colSpan: c.colSpan + 1 } : { ...c, rowSpan: c.rowSpan + 1 }
  })
  return axis === 'col'
    ? { ...layout, cols: layout.cols + 1, cells }
    : { ...layout, rows: layout.rows + 1, cells }
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
  const at = axis === 'col' ? f.col + f.colSpan : f.row + f.rowSpan
  return place(
    insertTrack(layout, axis, at, focusedTabId),
    axis === 'col'
      ? { tabId, col: at, row: f.row, colSpan: 1, rowSpan: f.rowSpan }
      : { tabId, col: f.col, row: at, colSpan: f.colSpan, rowSpan: 1 },
  )
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
  const rest = layout.cells.filter((c) => c.tabId !== tabId)
  if (rest.length < 2) return null
  return compact({ ...layout, cells: absorb(rest, hole) ?? rest })
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
