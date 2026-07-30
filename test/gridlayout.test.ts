import { describe, it, expect } from 'vitest'
import type { GridCell, GridLayout } from '../src/shared/types'
import {
  canReflow,
  closePane,
  compact,
  findFree,
  inBounds,
  occupies,
  overlaps,
  place,
  reflow,
  remove,
  showIn,
  single,
  split,
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

/**
 * Every grid position covered by exactly one cell — the thing a user sees as
 * "the panes tile with no gaps and nothing stacked". Returned as the list of
 * offending positions so a failure names them.
 */
const untiled = (l: GridLayout) => {
  const count = new Map<string, number>()
  for (const c of l.cells) for (const k of occupies(c)) count.set(k, (count.get(k) ?? 0) + 1)
  const bad: string[] = []
  for (let r = 0; r < l.rows; r++)
    for (let c = 0; c < l.cols; c++) {
      const n = count.get(`${c},${r}`) ?? 0
      if (n !== 1) bad.push(`${c},${r}=${n}`)
    }
  return bad
}

describe('compact: interior gaps, not just the bounds', () => {
  // The one that matters: close the MIDDLE pane of a 1x3 and the survivors are
  // at columns 0 and 2. Trimming the bounds alone keeps `cols: 3` and paints a
  // third of the window as an empty gap between two panes.
  it('drops a track that emptied out in the middle', () => {
    const l = compact(layout(3, 1, [cell('a', 0, 0), cell('c', 2, 0)]))
    expect([l.cols, l.rows]).toEqual([2, 1])
    expect(l.cells).toEqual([cell('a', 0, 0), cell('c', 1, 0)])
    expect(untiled(l)).toEqual([])
  })

  it('keeps a span whose tracks are still occupied — by itself, if nothing else', () => {
    // Column 1 is used only by 'a', which spans it. Dropping it would tear a
    // 3-wide pane down to 2 for no reason and un-tile the row below.
    const l = compact(layout(3, 2, [cell('a', 0, 0, 3, 1), cell('b', 0, 1, 3, 1)]))
    expect([l.cols, l.rows]).toEqual([3, 2])
    expect(untiled(l)).toEqual([])
  })
})

describe('split', () => {
  it('turns a single pane into two side by side', () => {
    const l = split(single('a'), 'a', 'b', 'col')
    expect([l.cols, l.rows]).toEqual([2, 1])
    expect(l.cells).toContainEqual(cell('b', 1, 0))
    expect(untiled(l)).toEqual([])
  })

  it('and stacked, on the row axis', () => {
    const l = split(single('a'), 'a', 'b', 'row')
    expect([l.cols, l.rows]).toEqual([1, 2])
    expect(l.cells).toContainEqual(cell('b', 0, 1))
    expect(untiled(l)).toEqual([])
  })

  // The case an append-a-column implementation gets wrong: growing the grid to
  // 3 columns fills only the split pane's own row, and the other row is left
  // with a hole where the new column crosses it.
  it('leaves no hole when one pane of a 2x2 is split', () => {
    const l = split(
      layout(2, 2, [cell('a', 0, 0), cell('b', 1, 0), cell('c', 0, 1), cell('d', 1, 1)]),
      'a', 'e', 'col',
    )
    expect([l.cols, l.rows]).toEqual([3, 2])
    expect(untiled(l)).toEqual([])
    // 'c' was below the split and absorbed the new column at its own row.
    expect(l.cells.find((x) => x.tabId === 'c')).toMatchObject({ col: 0, colSpan: 2 })
    expect(l.cells.find((x) => x.tabId === 'a')).toMatchObject({ col: 0, colSpan: 1 })
  })

  it('stays tiled through a chain of splits on both axes', () => {
    let l = single('a')
    l = split(l, 'a', 'b', 'col')
    l = split(l, 'a', 'c', 'row')
    l = split(l, 'b', 'd', 'row')
    l = split(l, 'd', 'e', 'col')
    expect(l.cells).toHaveLength(5)
    expect(untiled(l)).toEqual([])
  })

  it('refuses a tab that already has a pane, and an unfocused grid', () => {
    const l = split(single('a'), 'a', 'b', 'col')
    expect(split(l, 'a', 'b', 'col')).toBe(l)
    expect(split(l, 'nobody', 'z', 'col')).toBe(l)
    expect(split(l, 'a', '', 'col')).toBe(l)
  })
})

describe('closePane', () => {
  it('hands the rectangle to the neighbour beside it', () => {
    let l = split(single('a'), 'a', 'b', 'col')
    l = split(l, 'b', 'c', 'col')            // a | b | c
    const after = closePane(l, 'b')!
    expect(untiled(after)).toEqual([])
    expect(after.cells.map((x) => x.tabId).sort()).toEqual(['a', 'c'])
  })

  // No single cell is the right shape here: the pane being closed is two
  // columns wide and the row below it is two separate panes. Absorbing per
  // slice is what keeps this tiled.
  it('splits the rectangle between several neighbours when no one cell fits', () => {
    const l = layout(3, 2, [
      cell('a', 0, 0, 1, 2), cell('b', 1, 0, 2, 1),
      cell('d', 1, 1), cell('e', 2, 1),
    ])
    expect(untiled(l)).toEqual([])
    const after = closePane(l, 'b')!
    expect(untiled(after)).toEqual([])
    expect(after.cells.find((x) => x.tabId === 'd')).toMatchObject({ row: 0, rowSpan: 2 })
    expect(after.cells.find((x) => x.tabId === 'e')).toMatchObject({ row: 0, rowSpan: 2 })
  })

  it('is null once fewer than two panes are left — one pane is not a split', () => {
    const l = split(single('a'), 'a', 'b', 'col')
    expect(closePane(l, 'b')).toBeNull()
  })

  it('is a no-op for a tab with no pane', () => {
    const l = split(single('a'), 'a', 'b', 'col')
    expect(closePane(l, 'zzz')).toBe(l)
  })
})

describe('showIn', () => {
  it('puts the clicked tab in the focused pane, evicting the tab that was there', () => {
    const l = split(single('a'), 'a', 'b', 'col')
    const after = showIn(l, 'b', 'c')
    expect(after.cells.map((x) => x.tabId).sort()).toEqual(['a', 'c'])
    expect(after.cells.find((x) => x.tabId === 'c')).toMatchObject({ col: 1, row: 0 })
    expect(untiled(after)).toEqual([])
  })

  it('leaves a tab that already has a pane alone — that click is just focus', () => {
    const l = split(single('a'), 'a', 'b', 'col')
    expect(showIn(l, 'a', 'b')).toBe(l)
    expect(showIn(l, 'a', 'a')).toBe(l)
    expect(showIn(l, 'nobody', 'c')).toBe(l)
  })
})

describe('single', () => {
  it('is a 1x1 grid holding the tab', () => {
    expect(single('a')).toEqual({ cols: 1, rows: 1, cells: [cell('a', 0, 0)] })
  })
})

// KAN-56: the grid picker greys out precisely what canReflow refuses, and
// reflow returns null for precisely the same picks, so the two can never
// drift apart from each other.
describe('canReflow', () => {
  it('accepts an exact tiling', () => {
    expect(canReflow(4, 2, 2)).toBe(true)
  })
  it('refuses a grid with less area than panes', () => {
    expect(canReflow(5, 2, 2)).toBe(false)
    expect(canReflow(4, 3, 1)).toBe(false)
    expect(canReflow(2, 1, 1)).toBe(false)
  })
  it('refuses more columns than there are panes, which would leave one empty', () => {
    expect(canReflow(4, 5, 1)).toBe(false)
  })
  it('refuses a row count no pane reaches, which would leave one empty', () => {
    expect(canReflow(4, 2, 3)).toBe(false)
  })
  it('refuses a degenerate count or grid', () => {
    expect(canReflow(0, 2, 2)).toBe(false)
    expect(canReflow(4, 0, 2)).toBe(false)
    expect(canReflow(4, 2, 0)).toBe(false)
  })
})

describe('reflow', () => {
  it('tiles panes row-major in strip order, stretching only the last cell of a short row', () => {
    const l = reflow(['a', 'b', 'c', 'd'], 3, 2)!
    expect([l.cols, l.rows]).toEqual([3, 2])
    expect(l.cells.find((c) => c.tabId === 'a')).toMatchObject({ col: 0, row: 0, colSpan: 1 })
    expect(l.cells.find((c) => c.tabId === 'b')).toMatchObject({ col: 1, row: 0, colSpan: 1 })
    expect(l.cells.find((c) => c.tabId === 'c')).toMatchObject({ col: 2, row: 0, colSpan: 1 })
    // 'd' is alone in row 1, so it stretches to the right edge rather than
    // leaving columns 1-2 of that row uncovered.
    expect(l.cells.find((c) => c.tabId === 'd')).toMatchObject({ col: 0, row: 1, colSpan: 3 })
    expect(untiled(l)).toEqual([])
  })

  it('refuses a grid smaller than the pane count — no eviction, just null', () => {
    expect(reflow(['a', 'b', 'c', 'd', 'e'], 2, 2)).toBeNull()
  })

  it('leaves no two cells overlapping when a row does not divide evenly', () => {
    const l = reflow(['a', 'b', 'c', 'd', 'e'], 3, 2)!
    expect(l.cells).toHaveLength(5)
    expect(untiled(l)).toEqual([])
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
