import { describe, it, expect } from 'vitest'
import type { GridCell, GridLayout } from '../src/shared/types'
import {
  compact,
  findFree,
  inBounds,
  occupies,
  overlaps,
  place,
  remove,
  single,
} from '../src/renderer/gridlayout'

const cell = (tabId: string, col: number, row: number, colSpan = 1, rowSpan = 1): GridCell => ({
  tabId,
  col,
  row,
  colSpan,
  rowSpan,
})

const layout = (cols: number, rows: number, cells: GridCell[] = []): GridLayout => ({
  cols,
  rows,
  cells,
})

describe('occupies', () => {
  it('covers the whole area of a 2x2', () => {
    expect(occupies(cell('a', 0, 0, 2, 2)).sort()).toEqual(['0,0', '0,1', '1,0', '1,1'])
  })
})

describe('overlaps', () => {
  it('detects a partial overlap the corners alone would miss', () => {
    const l = layout(3, 3, [cell('a', 0, 0, 2, 2)])
    expect(overlaps(l, cell('b', 1, 1))).toBe(true)
  })
  it('is false for adjacent, non-touching rectangles', () => {
    const l = layout(3, 3, [cell('a', 0, 0, 2, 2)])
    expect(overlaps(l, cell('b', 2, 0))).toBe(false)
  })
  it('ignores the cell being moved', () => {
    const l = layout(2, 2, [cell('a', 0, 0, 2, 1)])
    expect(overlaps(l, cell('a', 0, 0, 2, 2))).toBe(true)
    expect(overlaps(l, cell('a', 0, 0, 2, 2), 'a')).toBe(false)
  })
})

describe('inBounds', () => {
  it('accepts a cell that exactly fills the grid', () => {
    expect(inBounds(layout(2, 2), cell('a', 0, 0, 2, 2))).toBe(true)
  })
  it('rejects a cell spilling past the right edge', () => {
    expect(inBounds(layout(2, 2), cell('a', 1, 0, 2, 1))).toBe(false)
  })
  it('rejects zero and negative spans', () => {
    expect(inBounds(layout(3, 3), cell('a', 0, 0, 0, 1))).toBe(false)
    expect(inBounds(layout(3, 3), cell('a', 0, 0, 1, -1))).toBe(false)
  })
  it('rejects negative coordinates', () => {
    expect(inBounds(layout(3, 3), cell('a', -1, 0))).toBe(false)
  })
})

describe('place: one tab owns exactly one cell', () => {
  // Appending blindly would give a tab two rectangles, and render/close/compact
  // all assume one cell per tab.
  it('moves a tab that is already placed instead of duplicating it', () => {
    const start = single('t1')
    const grown = { ...start, cols: 2, rows: 1 }
    const moved = place(grown, { tabId: 't1', col: 1, row: 0, colSpan: 1, rowSpan: 1 })
    expect(moved.cells).toHaveLength(1)
    expect(moved.cells[0]).toMatchObject({ tabId: 't1', col: 1 })
  })

  it('lets a placed tab overlap its own old rectangle when resizing', () => {
    const l = { cols: 2, rows: 2, cells: [{ tabId: 't1', col: 0, row: 0, colSpan: 1, rowSpan: 1 }] }
    const bigger = place(l, { tabId: 't1', col: 0, row: 0, colSpan: 2, rowSpan: 2 })
    expect(bigger.cells).toHaveLength(1)
    expect(bigger.cells[0].colSpan).toBe(2)
  })

  it('still rejects a move that would collide with a DIFFERENT tab', () => {
    const l = {
      cols: 2, rows: 1,
      cells: [
        { tabId: 't1', col: 0, row: 0, colSpan: 1, rowSpan: 1 },
        { tabId: 't2', col: 1, row: 0, colSpan: 1, rowSpan: 1 },
      ],
    }
    expect(place(l, { tabId: 't1', col: 1, row: 0, colSpan: 1, rowSpan: 1 })).toBe(l)
  })
})

describe('place', () => {
  it('adds a cell to a free slot', () => {
    const l = place(layout(2, 2, [cell('a', 0, 0)]), cell('b', 1, 0))
    expect(l.cells.map((c) => c.tabId)).toEqual(['a', 'b'])
  })
  it('rejects an out-of-bounds cell, unchanged', () => {
    const before = layout(2, 2, [cell('a', 0, 0)])
    expect(place(before, cell('b', 1, 1, 2, 2))).toEqual(before)
  })
  it('rejects an overlapping cell, unchanged', () => {
    const before = layout(3, 3, [cell('a', 0, 0, 2, 2)])
    expect(place(before, cell('b', 1, 1))).toEqual(before)
  })
})

describe('remove', () => {
  it('drops the closed tab', () => {
    const l = remove(layout(2, 1, [cell('a', 0, 0), cell('b', 1, 0)]), 'a')
    expect(l.cells.map((c) => c.tabId)).toEqual(['b'])
  })
  it('is a no-op for an absent tab', () => {
    const before = layout(2, 1, [cell('a', 0, 0)])
    expect(remove(before, 'nope')).toEqual(before)
  })
})

describe('findFree', () => {
  it('finds the first row-major slot in a partly filled grid', () => {
    const l = layout(2, 2, [cell('a', 0, 0)])
    expect(findFree(l, 1, 1)).toEqual({ col: 1, row: 0 })
  })
  it('skips positions where the rectangle would not fit whole', () => {
    const l = layout(3, 2, [cell('a', 1, 0)])
    expect(findFree(l, 2, 1)).toEqual({ col: 0, row: 1 })
  })
  it('returns null when the grid is full', () => {
    const l = layout(2, 1, [cell('a', 0, 0), cell('b', 1, 0)])
    expect(findFree(l, 1, 1)).toBeNull()
  })
})

describe('compact', () => {
  it('shrinks a sparse 3x3 holding one tab to 1x1', () => {
    expect(compact(layout(3, 3, [cell('a', 2, 2)]))).toEqual({
      cols: 1,
      rows: 1,
      cells: [cell('a', 0, 0)],
    })
  })
  it('keeps bounds that are still needed', () => {
    const l = compact(layout(4, 4, [cell('a', 0, 0, 2, 1), cell('b', 0, 1)]))
    expect([l.cols, l.rows]).toEqual([2, 2])
  })
  it('never goes below 1x1', () => {
    expect(compact(layout(3, 3))).toEqual({ cols: 1, rows: 1, cells: [] })
  })
})

describe('single', () => {
  it('is a 1x1 grid holding the tab', () => {
    expect(single('a')).toEqual({ cols: 1, rows: 1, cells: [cell('a', 0, 0)] })
  })
})

describe('purity', () => {
  it('never mutates the input layout or its cells', () => {
    const l = layout(3, 3, [cell('a', 0, 0, 2, 2), cell('b', 2, 2)])
    const snapshot = structuredClone(l)
    place(l, cell('c', 2, 0))
    place(l, cell('d', 1, 1))
    remove(l, 'a')
    remove(l, 'absent')
    compact(l)
    findFree(l, 1, 1)
    overlaps(l, cell('c', 2, 0))
    expect(l).toEqual(snapshot)
  })
  it('returns a new cells array', () => {
    const l = layout(2, 2, [cell('a', 0, 0)])
    expect(place(l, cell('b', 1, 0)).cells).not.toBe(l.cells)
    expect(remove(l, 'a').cells).not.toBe(l.cells)
    expect(compact(l).cells).not.toBe(l.cells)
  })
})
