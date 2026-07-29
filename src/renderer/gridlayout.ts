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

/**
 * Tightest bounds still containing every cell, minimum 1x1 — so closing two of
 * three tabs collapses a 3x3 back to a single pane.
 *
 * Empty leading rows/columns are dropped by shifting the survivors to the
 * origin, not just by lowering `cols`/`rows`: the lone tab left in a 3x3 is
 * often the one at (2,2), and leaving it there would keep the grid 3x3 with a
 * hole where the closed tabs were.
 */
export function compact(layout: GridLayout): GridLayout {
  if (!layout.cells.length) return { cols: 1, rows: 1, cells: [] }
  const minCol = Math.min(...layout.cells.map((c) => c.col))
  const minRow = Math.min(...layout.cells.map((c) => c.row))
  const cells = layout.cells.map((c) => ({ ...c, col: c.col - minCol, row: c.row - minRow }))
  return {
    cols: Math.max(1, ...cells.map((c) => c.col + c.colSpan)),
    rows: Math.max(1, ...cells.map((c) => c.row + c.rowSpan)),
    cells,
  }
}

export function single(tabId: string): GridLayout {
  return { cols: 1, rows: 1, cells: [{ tabId, col: 0, row: 0, colSpan: 1, rowSpan: 1 }] }
}
