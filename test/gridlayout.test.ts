import { describe, it, expect } from 'vitest'
import type { GridCell, GridLayout } from '../src/shared/types'
import {
  canReflow,
  cellAt,
  cellKey,
  cellOf,
  closeCell,
  compact,
  findFree,
  inBounds,
  insertAtSeam,
  layoutTabIds,
  moveCellBeside,
  moveTab,
  neighbour,
  occupies,
  overlaps,
  place,
  readingOrder,
  reflow,
  removeTab,
  setCellTabs,
  showTab,
  single,
  splitCell,
  swapCells,
} from '../src/renderer/gridlayout'

/** KAN-56: a cell is a WINDOW — an ordered strip plus the tab it is showing. */
const cell = (
  tabIds: string[],
  col: number,
  row: number,
  colSpan = 1,
  rowSpan = 1,
  activeTabId = tabIds[0],
): GridCell => ({ tabIds, activeTabId, col, row, colSpan, rowSpan })

const layout = (cols: number, rows: number, cells: GridCell[] = []): GridLayout => ({
  cols,
  rows,
  cells,
})

/** Reading order, as tab-set strings — the shape most assertions want. */
const strips = (l: GridLayout) => readingOrder(l).map((c) => c.tabIds.join(''))

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

/**
 * THE model invariants, as a list of violations. A tab in two panes gives one
 * terminal two hosts; an empty cell renders as a strip with nothing under it;
 * an `activeTabId` that is not a member shows no pane at all.
 */
const broken = (l: GridLayout) => {
  const bad: string[] = []
  const seen = new Map<string, number>()
  for (const c of l.cells) {
    if (!c.tabIds.length) bad.push(`empty cell at ${cellKey(c)}`)
    if (new Set(c.tabIds).size !== c.tabIds.length) bad.push(`repeat inside ${cellKey(c)}`)
    if (c.tabIds.length && !c.tabIds.includes(c.activeTabId))
      bad.push(`active ${c.activeTabId} not in ${cellKey(c)}`)
    if (!inBounds(l, c)) bad.push(`out of bounds at ${cellKey(c)}`)
    for (const id of c.tabIds) seen.set(id, (seen.get(id) ?? 0) + 1)
  }
  for (const [id, n] of seen) if (n > 1) bad.push(`${id} is in ${n} cells`)
  return [...bad, ...untiled(l).map((p) => `untiled ${p}`)]
}

/** a | b | c, one tab each — the smallest grid `closeCell` can act on. */
const three = () => layout(3, 1, [cell(['a'], 0, 0), cell(['b'], 1, 0), cell(['c'], 2, 0)])

describe('occupies', () => {
  it('covers the whole area of a 2x2', () => {
    expect(occupies(cell(['a'], 0, 0, 2, 2)).sort()).toEqual(['0,0', '0,1', '1,0', '1,1'])
  })
})

describe('overlaps', () => {
  it('detects a partial overlap the corners alone would miss', () => {
    const l = layout(3, 3, [cell(['a'], 0, 0, 2, 2)])
    expect(overlaps(l, cell(['b'], 1, 1))).toBe(true)
  })
  it('is false for adjacent, non-touching rectangles', () => {
    const l = layout(3, 3, [cell(['a'], 0, 0, 2, 2)])
    expect(overlaps(l, cell(['b'], 2, 0))).toBe(false)
  })
  it('ignores the cell at the anchor being rewritten', () => {
    const l = layout(2, 2, [cell(['a'], 0, 0, 2, 1)])
    expect(overlaps(l, cell(['a'], 0, 0, 2, 2))).toBe(true)
    expect(overlaps(l, cell(['a'], 0, 0, 2, 2), '0,0')).toBe(false)
  })
})

describe('inBounds', () => {
  it('accepts a cell that exactly fills the grid', () => {
    expect(inBounds(layout(2, 2), cell(['a'], 0, 0, 2, 2))).toBe(true)
  })
  it('rejects a cell spilling past the right edge', () => {
    expect(inBounds(layout(2, 2), cell(['a'], 1, 0, 2, 1))).toBe(false)
  })
  it('rejects zero and negative spans', () => {
    expect(inBounds(layout(3, 3), cell(['a'], 0, 0, 0, 1))).toBe(false)
    expect(inBounds(layout(3, 3), cell(['a'], 0, 0, 1, -1))).toBe(false)
  })
  it('rejects negative coordinates', () => {
    expect(inBounds(layout(3, 3), cell(['a'], -1, 0))).toBe(false)
  })
})

describe('cellKey / cellAt / cellOf / readingOrder', () => {
  it('addresses a cell by its anchor, which the no-overlap rule makes unique', () => {
    const l = layout(2, 1, [cell(['a', 'x'], 0, 0), cell(['b'], 1, 0)])
    expect(cellKey(l.cells[1])).toBe('1,0')
    expect(cellAt(l, '1,0')!.tabIds).toEqual(['b'])
    expect(cellAt(l, '9,9')).toBeNull()
  })
  it('finds a tab wherever in its strip it sits, not just at the front', () => {
    const l = layout(2, 1, [cell(['a', 'x'], 0, 0), cell(['b'], 1, 0)])
    expect(cellKey(cellOf(l, 'x')!)).toBe('0,0')
    expect(cellOf(l, 'nobody')).toBeNull()
  })
  it('orders cells by row then col, whatever order the array is in', () => {
    const l = layout(2, 2, [
      cell(['d'], 1, 1),
      cell(['b'], 1, 0),
      cell(['c'], 0, 1),
      cell(['a'], 0, 0),
    ])
    expect(strips(l)).toEqual(['a', 'b', 'c', 'd'])
    expect(layoutTabIds(l)).toEqual(['a', 'b', 'c', 'd'])
  })
  it('concatenates whole strips, so layoutTabIds is Space.tabIds', () => {
    const l = layout(2, 1, [cell(['c', 'd'], 1, 0), cell(['a', 'b'], 0, 0)])
    expect(layoutTabIds(l)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('place: the invariant chokepoint', () => {
  it('replaces whatever sits at the same anchor rather than stacking on it', () => {
    const l = layout(2, 1, [cell(['a'], 0, 0)])
    const after = place(l, cell(['b'], 0, 0))
    expect(after.cells).toHaveLength(1)
    expect(after.cells[0].tabIds).toEqual(['b'])
  })

  it('lets a cell overlap its OWN old rectangle when it grows', () => {
    const l = layout(2, 2, [cell(['a'], 0, 0)])
    const bigger = place(l, cell(['a'], 0, 0, 2, 2))
    expect(bigger.cells).toHaveLength(1)
    expect(bigger.cells[0].colSpan).toBe(2)
  })

  it('refuses a rectangle that collides with a DIFFERENT cell', () => {
    const l = layout(2, 1, [cell(['a'], 0, 0), cell(['b'], 1, 0)])
    expect(place(l, cell(['a'], 1, 0))).toBe(l)
  })

  // The bug this exists to make unrepresentable: one terminal with two hosts.
  it('refuses a cell holding a tab another cell already claims', () => {
    const l = layout(2, 1, [cell(['a', 'x'], 0, 0)])
    expect(place(l, cell(['b', 'x'], 1, 0))).toBe(l)
    expect(place(l, cell(['b'], 1, 0)).cells).toHaveLength(2)
  })

  it('refuses a cell that repeats a tab inside its own strip', () => {
    const l = layout(2, 1, [cell(['a'], 0, 0)])
    expect(place(l, cell(['b', 'b'], 1, 0))).toBe(l)
  })

  it('refuses an empty strip — a pane with nothing under it is not a pane', () => {
    const l = layout(2, 1, [cell(['a'], 0, 0)])
    expect(place(l, cell([], 1, 0))).toBe(l)
  })

  // A stale pointer, not a structural fault: repaired rather than refused.
  it('repairs an activeTabId that is not a member, instead of dropping the cell', () => {
    const l = place(layout(1, 1), { ...cell(['a', 'b'], 0, 0), activeTabId: 'gone' })
    expect(l.cells[0].activeTabId).toBe('a')
  })

  it('rejects an out-of-bounds cell, unchanged', () => {
    const before = layout(2, 2, [cell(['a'], 0, 0)])
    expect(place(before, cell(['b'], 1, 1, 2, 2))).toBe(before)
  })
})

describe('findFree', () => {
  it('finds the first row-major slot in a partly filled grid', () => {
    expect(findFree(layout(2, 2, [cell(['a'], 0, 0)]), 1, 1)).toEqual({ col: 1, row: 0 })
  })
  it('skips positions where the rectangle would not fit whole', () => {
    expect(findFree(layout(3, 2, [cell(['a'], 1, 0)]), 2, 1)).toEqual({ col: 0, row: 1 })
  })
  it('returns null when the grid is full', () => {
    expect(findFree(layout(2, 1, [cell(['a'], 0, 0), cell(['b'], 1, 0)]), 1, 1)).toBeNull()
  })
})

describe('compact', () => {
  it('shrinks a sparse 3x3 holding one cell to 1x1', () => {
    expect(compact(layout(3, 3, [cell(['a'], 2, 2)]))).toEqual({
      cols: 1,
      rows: 1,
      cells: [cell(['a'], 0, 0)],
    })
  })
  it('keeps bounds that are still needed', () => {
    const l = compact(layout(4, 4, [cell(['a'], 0, 0, 2, 1), cell(['b'], 0, 1)]))
    expect([l.cols, l.rows]).toEqual([2, 2])
  })
  it('never goes below 1x1', () => {
    expect(compact(layout(3, 3))).toEqual({ cols: 1, rows: 1, cells: [] })
    // ...nor when a hostile file gives a cell no tracks at all: a zero-track
    // `grid-template-columns` is invalid CSS, not an empty grid.
    expect(compact(layout(3, 3, [cell(['a'], 0, 0, 0, 0)]))).toMatchObject({ cols: 1, rows: 1 })
  })

  // The one that matters: close the MIDDLE pane of a 1x3 and the survivors are
  // at columns 0 and 2. Trimming the bounds alone keeps `cols: 3` and paints a
  // third of the window as an empty gap between two panes.
  it('drops a track that emptied out in the middle', () => {
    const l = compact(layout(3, 1, [cell(['a'], 0, 0), cell(['c'], 2, 0)]))
    expect([l.cols, l.rows]).toEqual([2, 1])
    expect(l.cells).toEqual([cell(['a'], 0, 0), cell(['c'], 1, 0)])
    expect(untiled(l)).toEqual([])
  })

  it('keeps a span whose tracks are still occupied — by itself, if nothing else', () => {
    const l = compact(layout(3, 2, [cell(['a'], 0, 0, 3, 1), cell(['b'], 0, 1, 3, 1)]))
    expect([l.cols, l.rows]).toEqual([3, 2])
    expect(untiled(l)).toEqual([])
  })
})

describe('single', () => {
  it('is one pane holding EVERY tab — the explicit form of layout: null', () => {
    expect(single(['a', 'b', 'c'], 'b')).toEqual({
      cols: 1,
      rows: 1,
      cells: [cell(['a', 'b', 'c'], 0, 0, 1, 1, 'b')],
    })
  })
  it('falls back to the first tab when the asked-for active tab is not a member', () => {
    expect(single(['a', 'b'], 'zzz').cells[0].activeTabId).toBe('a')
  })
  it('is an empty grid for no tabs at all', () => {
    expect(single([], '')).toEqual({ cols: 1, rows: 1, cells: [] })
  })
})

describe('showTab', () => {
  it('changes what a pane shows without touching its strip order', () => {
    const l = layout(2, 1, [cell(['a', 'x'], 0, 0), cell(['b'], 1, 0)])
    const after = showTab(l, 'x')
    expect(cellAt(after, '0,0')!.activeTabId).toBe('x')
    expect(cellAt(after, '0,0')!.tabIds).toEqual(['a', 'x'])
  })
  it('is a no-op for a tab already shown, or one in no pane', () => {
    const l = layout(2, 1, [cell(['a', 'x'], 0, 0), cell(['b'], 1, 0)])
    expect(showTab(l, 'a')).toBe(l)
    expect(showTab(l, 'nobody')).toBe(l)
  })
})

describe('moveTab', () => {
  const two = () => layout(2, 1, [cell(['a', 'x'], 0, 0), cell(['b', 'y'], 1, 0)])

  it('moves a tab between panes, leaving it in exactly one', () => {
    const after = moveTab(two(), 'x', '1,0')
    expect(cellAt(after, '0,0')!.tabIds).toEqual(['a'])
    expect(cellAt(after, '1,0')!.tabIds).toEqual(['b', 'y', 'x'])
    expect([after.cols, after.rows]).toEqual([2, 1])
    expect(broken(after)).toEqual([])
  })

  it('honours the insert index, so a strip drop lands where the pointer was', () => {
    expect(cellAt(moveTab(two(), 'x', '1,0', 0), '1,0')!.tabIds).toEqual(['x', 'b', 'y'])
    expect(cellAt(moveTab(two(), 'x', '1,0', 1), '1,0')!.tabIds).toEqual(['b', 'x', 'y'])
    // Out of range clamps rather than producing a hole in the array.
    expect(cellAt(moveTab(two(), 'x', '1,0', 99), '1,0')!.tabIds).toEqual(['b', 'y', 'x'])
  })

  // Dragging a tab into another browser window shows it there; landing it
  // invisibly behind whatever that pane was showing is the wrong gesture.
  it('makes the tab active in the pane it arrives in', () => {
    expect(cellAt(moveTab(two(), 'x', '1,0'), '1,0')!.activeTabId).toBe('x')
  })

  // ...but a move WITHIN one strip is a reorder, and reordering must not change
  // which tab the pane is showing (KAN-56 decision 1).
  it('leaves the shown tab alone when the move is inside one strip', () => {
    const l = layout(2, 1, [cell(['a', 'x'], 0, 0, 1, 1, 'a'), cell(['b'], 1, 0)])
    const after = moveTab(l, 'x', '0,0', 0)
    expect(cellAt(after, '0,0')!.tabIds).toEqual(['x', 'a'])
    expect(cellAt(after, '0,0')!.activeTabId).toBe('a')
  })

  it('removes the source pane when its last tab leaves, and absorbs the hole', () => {
    const after = moveTab(three(), 'a', '1,0')
    expect(after.cells).toHaveLength(2)
    expect(cellOf(after, 'a')).toBe(cellOf(after, 'b'))
    expect(broken(after)).toEqual([])
  })

  // THE stale-anchor bug: vacating the source compacts, which re-ranks anchors,
  // so the destination key measured before the move names a different cell (or
  // no cell) after it. Here `b`'s pane slides from 1,0 to 0,0 as `a`'s goes.
  it('still lands in the intended pane when the vacate re-ranks the anchors', () => {
    const l = layout(3, 1, [cell(['a'], 0, 0), cell(['b', 'q'], 1, 0), cell(['c'], 2, 0)])
    const after = moveTab(l, 'a', '1,0')
    expect(cellAt(after, '1,0')).toBeNull() // the key really did go stale
    expect(cellOf(after, 'a')!.tabIds).toEqual(['b', 'q', 'a'])
    expect(broken(after)).toEqual([])
  })

  it('refuses a destination that is not a cell, and a lone tab onto its own pane', () => {
    const l = two()
    expect(moveTab(l, 'x', '9,9')).toBe(l)
    expect(moveTab(l, '', '1,0')).toBe(l)
    const lone = layout(2, 1, [cell(['a'], 0, 0), cell(['b'], 1, 0)])
    expect(moveTab(lone, 'a', '0,0')).toBe(lone)
  })

  it('adds a tab that is in no pane yet — how a newly opened tab joins one', () => {
    const after = moveTab(two(), 'fresh', '1,0')
    expect(cellAt(after, '1,0')!.tabIds).toEqual(['b', 'y', 'fresh'])
    expect(broken(after)).toEqual([])
  })
})

describe('setCellTabs', () => {
  const l = () => layout(2, 1, [cell(['a', 'x', 'z'], 0, 0, 1, 1, 'x'), cell(['b'], 1, 0)])

  it('rewrites one strip order and leaves the shown tab alone', () => {
    const after = setCellTabs(l(), '0,0', ['z', 'a', 'x'])
    expect(cellAt(after, '0,0')!.tabIds).toEqual(['z', 'a', 'x'])
    expect(cellAt(after, '0,0')!.activeTabId).toBe('x')
    expect(cellAt(after, '1,0')!.tabIds).toEqual(['b'])
  })

  // groups.ts composes over a cell's slice and is generic over "a list of tab
  // records"; a bug there must not be able to add a tab to this pane or lose
  // one out of it.
  it('refuses anything that is not a permutation of the strip it is replacing', () => {
    const before = l()
    expect(setCellTabs(before, '0,0', ['a', 'x'])).toBe(before) // short
    expect(setCellTabs(before, '0,0', ['a', 'x', 'z', 'b'])).toBe(before) // long
    expect(setCellTabs(before, '0,0', ['a', 'x', 'b'])).toBe(before) // a stranger
    expect(setCellTabs(before, '0,0', ['a', 'a', 'x'])).toBe(before) // a duplicate
    expect(setCellTabs(before, '9,9', ['a'])).toBe(before)
  })
})

describe('removeTab', () => {
  it('drops a closed tab from its strip and keeps the pane', () => {
    const after = removeTab(layout(2, 1, [cell(['a', 'x'], 0, 0), cell(['b'], 1, 0)]), 'x')!
    expect(after.cells).toHaveLength(2)
    expect(cellAt(after, '0,0')!.tabIds).toEqual(['a'])
  })

  it('shows the neighbouring tab when the one that closed was the shown one', () => {
    const l = layout(2, 1, [cell(['a', 'x', 'z'], 0, 0, 1, 1, 'x'), cell(['b'], 1, 0)])
    expect(cellAt(removeTab(l, 'x')!, '0,0')!.activeTabId).toBe('z')
  })

  it('closes the pane when its last tab closes, and the survivors still tile', () => {
    const after = removeTab(three(), 'b')!
    expect(after.cells).toHaveLength(2)
    expect(layoutTabIds(after)).toEqual(['a', 'c'])
    expect(broken(after)).toEqual([])
  })

  it('is null once fewer than two panes are left — one pane is not a split', () => {
    expect(removeTab(layout(2, 1, [cell(['a'], 0, 0), cell(['b'], 1, 0)]), 'b')).toBeNull()
  })

  it('is a no-op for a tab in no pane', () => {
    const l = three()
    expect(removeTab(l, 'zzz')).toBe(l)
  })
})

describe('closeCell', () => {
  // A pane closing is not its tabs closing: they move to whoever took the floor
  // space. Losing them here would kill live Claude sessions.
  it('merges the closed pane tabs into the neighbour that absorbs its rectangle', () => {
    const l = layout(3, 1, [cell(['a'], 0, 0), cell(['b', 'q'], 1, 0), cell(['c'], 2, 0)])
    const after = closeCell(l, '1,0')!
    expect(after.cells).toHaveLength(2)
    expect(cellOf(after, 'b')!.tabIds).toEqual(['a', 'b', 'q'])
    expect(layoutTabIds(after).sort()).toEqual(['a', 'b', 'c', 'q'])
    expect(broken(after)).toEqual([])
  })

  // No single cell is the right shape here: the pane being closed is two
  // columns wide and the row below it is two separate panes. Absorbing per
  // slice is what keeps this tiled.
  it('splits the rectangle between several neighbours when no one cell fits', () => {
    const l = layout(3, 2, [
      cell(['a'], 0, 0, 1, 2),
      cell(['b'], 1, 0, 2, 1),
      cell(['d'], 1, 1),
      cell(['e'], 2, 1),
    ])
    expect(untiled(l)).toEqual([])
    const after = closeCell(l, '1,0')!
    expect(broken(after)).toEqual([])
    expect(cellOf(after, 'd')).toMatchObject({ row: 0, rowSpan: 2 })
    expect(cellOf(after, 'e')).toMatchObject({ row: 0, rowSpan: 2 })
    expect(layoutTabIds(after).sort()).toEqual(['a', 'b', 'd', 'e'])
  })

  it('is null once fewer than two panes are left', () => {
    expect(closeCell(layout(2, 1, [cell(['a'], 0, 0), cell(['b'], 1, 0)]), '1,0')).toBeNull()
  })

  it('is a no-op for a key that names no pane', () => {
    const l = three()
    expect(closeCell(l, '9,9')).toBe(l)
  })
})

describe('splitCell', () => {
  it('cuts a track beside the target and moves the tab into it', () => {
    const after = splitCell(single(['a', 'b'], 'a'), '0,0', 'b', 'right')
    expect([after.cols, after.rows]).toEqual([2, 1])
    expect(strips(after)).toEqual(['a', 'b'])
    expect(cellOf(after, 'b')!.activeTabId).toBe('b')
    expect(broken(after)).toEqual([])
  })

  it('cuts on the row axis for top and bottom', () => {
    const after = splitCell(single(['a', 'b'], 'a'), '0,0', 'b', 'bottom')
    expect([after.cols, after.rows]).toEqual([1, 2])
    expect(cellOf(after, 'b')).toMatchObject({ col: 0, row: 1 })
    expect(broken(after)).toEqual([])
  })

  it('inserts before the target for left and top, not after', () => {
    const after = splitCell(single(['a', 'b'], 'a'), '0,0', 'b', 'left')
    expect(cellOf(after, 'b')).toMatchObject({ col: 0 })
    expect(cellOf(after, 'a')).toMatchObject({ col: 1 })
    expect(broken(after)).toEqual([])
  })

  // The case an append-a-column implementation gets wrong: growing the grid to
  // 3 columns fills only the split pane's own row, and the other row is left
  // with a hole where the new column crosses it.
  it('leaves no hole when one pane of a 2x2 is split', () => {
    const l = layout(2, 2, [
      cell(['a', 'e'], 0, 0),
      cell(['b'], 1, 0),
      cell(['c'], 0, 1),
      cell(['d'], 1, 1),
    ])
    const after = splitCell(l, '0,0', 'e', 'right')
    expect([after.cols, after.rows]).toEqual([3, 2])
    expect(broken(after)).toEqual([])
    // 'c' was below the split and absorbed the new column at its own row.
    expect(cellOf(after, 'c')).toMatchObject({ col: 0, colSpan: 2 })
    expect(cellOf(after, 'a')).toMatchObject({ col: 0, colSpan: 1 })
  })

  it('takes the tab from ANOTHER pane, emptying it if that was its last', () => {
    const l = layout(2, 1, [cell(['a'], 0, 0), cell(['b', 'q'], 1, 0)])
    const after = splitCell(l, '1,0', 'a', 'right')
    expect(broken(after)).toEqual([])
    expect(layoutTabIds(after)).toEqual(['b', 'q', 'a'])
    expect(after.cells).toHaveLength(2)
  })

  // Splitting a pane's only tab out of it would empty the very pane being cut.
  it('refuses to split out the sole tab of the target pane', () => {
    const l = layout(2, 1, [cell(['a'], 0, 0), cell(['b'], 1, 0)])
    expect(splitCell(l, '0,0', 'a', 'right')).toBe(l)
    expect(splitCell(l, '9,9', 'b', 'right')).toBe(l)
    expect(splitCell(l, '0,0', '', 'right')).toBe(l)
  })

  it('stays tiled through a chain of splits on both axes', () => {
    let l = single(['a', 'b', 'c', 'd', 'e'], 'a')
    l = splitCell(l, '0,0', 'b', 'right')
    l = splitCell(l, '0,0', 'c', 'bottom')
    l = splitCell(l, cellKey(cellOf(l, 'b')!), 'd', 'bottom')
    l = splitCell(l, cellKey(cellOf(l, 'a')!), 'e', 'right')
    expect(l.cells).toHaveLength(5)
    expect(broken(l)).toEqual([])
  })
})

describe('insertAtSeam', () => {
  const seamed = () => layout(2, 1, [cell(['a', 'q'], 0, 0), cell(['b'], 1, 0)])

  it('opens a new track at the seam and puts the tab in it', () => {
    const after = insertAtSeam(seamed(), 'q', 'col', 0, 0, 1)
    expect([after.cols, after.rows]).toEqual([3, 1])
    expect(strips(after)).toEqual(['a', 'q', 'b'])
    expect(broken(after)).toEqual([])
  })

  // Taking a pane's only tab would remove that pane and compact, and compaction
  // re-ranks the very track indices the caller measured off the DOM.
  it('refuses a tab that is the sole occupant of its pane', () => {
    const l = seamed()
    expect(insertAtSeam(l, 'b', 'col', 0, 0, 1)).toBe(l)
  })

  it('refuses a run or an index the grid cannot carry', () => {
    const l = seamed()
    expect(insertAtSeam(l, 'q', 'col', 0, 1, 1)).toBe(l) // empty run
    expect(insertAtSeam(l, 'q', 'col', 0, 0, 9)).toBe(l) // run past the edge
    expect(insertAtSeam(l, 'q', 'col', 9, 0, 1)).toBe(l) // no such seam
  })
})

describe('swapCells', () => {
  it('exchanges two panes rectangles with both strips intact', () => {
    const l = layout(2, 1, [cell(['a', 'x'], 0, 0, 1, 1, 'x'), cell(['b'], 1, 0)])
    const after = swapCells(l, '0,0', '1,0')
    expect(cellAt(after, '0,0')!.tabIds).toEqual(['b'])
    expect(cellAt(after, '1,0')!.tabIds).toEqual(['a', 'x'])
    expect(cellAt(after, '1,0')!.activeTabId).toBe('x')
    expect(broken(after)).toEqual([])
  })

  // No track count changes, which is exactly why a swap keeps both axes'
  // dragged fractions instead of resetting them to an even split.
  it('changes no track count and no span', () => {
    const l = layout(3, 1, [cell(['a'], 0, 0, 2, 1), cell(['b'], 2, 0)])
    const after = swapCells(l, '0,0', '2,0')
    expect([after.cols, after.rows]).toEqual([3, 1])
    expect(cellOf(after, 'b')).toMatchObject({ col: 0, colSpan: 2 })
    expect(cellOf(after, 'a')).toMatchObject({ col: 2, colSpan: 1 })
  })

  it('refuses a swap with itself or with a key that names no pane', () => {
    const l = three()
    expect(swapCells(l, '0,0', '0,0')).toBe(l)
    expect(swapCells(l, '0,0', '9,9')).toBe(l)
  })
})

describe('moveCellBeside', () => {
  it('moves a whole pane, strip intact, and compacts the hole it left', () => {
    const after = moveCellBeside(three(), '0,0', '2,0', 'right')
    expect(after.cells).toHaveLength(3)
    expect(strips(after)).toEqual(['b', 'c', 'a'])
    expect(broken(after)).toEqual([])
  })

  it('carries a multi-tab strip and its shown tab across', () => {
    const l = layout(3, 1, [cell(['a', 'x'], 0, 0, 1, 1, 'x'), cell(['b'], 1, 0), cell(['c'], 2, 0)])
    const after = moveCellBeside(l, '0,0', '2,0', 'right')
    expect(cellOf(after, 'a')!.tabIds).toEqual(['a', 'x'])
    expect(cellOf(after, 'a')!.activeTabId).toBe('x')
  })

  it('refuses a move onto itself or onto a key that names no pane', () => {
    const l = three()
    expect(moveCellBeside(l, '0,0', '0,0', 'right')).toBe(l)
    expect(moveCellBeside(l, '0,0', '9,9', 'right')).toBe(l)
    expect(moveCellBeside(l, '9,9', '0,0', 'right')).toBe(l)
  })
})

describe('neighbour', () => {
  it('names the pane sharing the edge on that side', () => {
    const l = layout(2, 2, [
      cell(['a'], 0, 0),
      cell(['b'], 1, 0),
      cell(['c'], 0, 1),
      cell(['d'], 1, 1),
    ])
    expect(neighbour(l, '0,0', 'right')).toBe('1,0')
    expect(neighbour(l, '1,0', 'left')).toBe('0,0')
    expect(neighbour(l, '0,0', 'bottom')).toBe('0,1')
    expect(neighbour(l, '0,1', 'top')).toBe('0,0')
  })
  it('is null at the grid edge, and for a key that names no pane', () => {
    const l = layout(2, 1, [cell(['a'], 0, 0), cell(['b'], 1, 0)])
    expect(neighbour(l, '0,0', 'left')).toBeNull()
    expect(neighbour(l, '0,0', 'top')).toBeNull()
    expect(neighbour(l, '9,9', 'right')).toBeNull()
  })
  it('finds a wider neighbour it only partly overlaps', () => {
    const l = layout(2, 2, [cell(['a'], 0, 0, 2, 1), cell(['b'], 0, 1), cell(['c'], 1, 1)])
    expect(neighbour(l, '1,1', 'top')).toBe('0,0')
    expect(neighbour(l, '0,0', 'bottom')).toBe('0,1') // the first in cross order
  })
})

// The grid picker greys out precisely what canReflow refuses, and reflow
// returns null for precisely the same picks, so what was previewed and what
// gets built cannot drift apart.
describe('canReflow', () => {
  it('accepts an exact tiling', () => {
    expect(canReflow(4, 2, 2)).toBe(true)
  })

  // KAN-56 dropped the `cols * rows >= count` clause: a target SMALLER than the
  // pane count now merges panes, and 1x1 is how you get back to classic tabs.
  it('accepts a grid smaller than the pane count, which merges', () => {
    expect(canReflow(3, 2, 1)).toBe(true)
    expect(canReflow(5, 2, 2)).toBe(true)
    expect(canReflow(2, 1, 1)).toBe(true)
    expect(canReflow(4, 3, 1)).toBe(true)
  })
  it('refuses more columns than there are panes, which would leave one empty', () => {
    expect(canReflow(4, 5, 1)).toBe(false)
    expect(canReflow(2, 3, 1)).toBe(false)
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
  const four = () =>
    layout(4, 1, [
      cell(['a'], 0, 0),
      cell(['b'], 1, 0),
      cell(['c'], 2, 0),
      cell(['d'], 3, 0),
    ])

  it('tiles panes row-major in reading order, stretching only a short last row', () => {
    const l = reflow(four(), 3, 2)!
    expect([l.cols, l.rows]).toEqual([3, 2])
    expect(cellOf(l, 'a')).toMatchObject({ col: 0, row: 0, colSpan: 1 })
    expect(cellOf(l, 'b')).toMatchObject({ col: 1, row: 0, colSpan: 1 })
    expect(cellOf(l, 'c')).toMatchObject({ col: 2, row: 0, colSpan: 1 })
    // 'd' is alone in row 1, so it stretches to the right edge rather than
    // leaving columns 1-2 of that row uncovered.
    expect(cellOf(l, 'd')).toMatchObject({ col: 0, row: 1, colSpan: 3 })
    expect(broken(l)).toEqual([])
  })

  it('carries whole strips through, not just the shown tab', () => {
    const l = layout(2, 1, [cell(['a', 'x'], 0, 0, 1, 1, 'x'), cell(['b', 'y'], 1, 0)])
    const after = reflow(l, 1, 2)!
    expect(strips(after)).toEqual(['ax', 'by'])
    expect(cellOf(after, 'a')!.activeTabId).toBe('x')
  })

  // Merging, decision 5: contiguous balanced chunks, the first n % m taking one
  // extra, and the chunk's FIRST pane decides what the merged pane shows.
  it('merges panes in contiguous chunks when the target has fewer cells', () => {
    const l = reflow(three(), 2, 1)!
    expect([l.cols, l.rows]).toEqual([2, 1])
    expect(strips(l)).toEqual(['ab', 'c'])
    expect(broken(l)).toEqual([])
  })
  it('balances the chunks across the whole target', () => {
    expect(strips(reflow(four(), 2, 1)!)).toEqual(['ab', 'cd'])
    const five = layout(5, 1, ['a', 'b', 'c', 'd', 'e'].map((id, i) => cell([id], i, 0)))
    expect(strips(reflow(five, 2, 1)!)).toEqual(['abc', 'de'])
  })
  it('shows the first pane of a chunk after a merge', () => {
    const l = layout(2, 1, [cell(['a', 'x'], 0, 0, 1, 1, 'x'), cell(['b'], 1, 0)])
    expect(reflow(l, 1, 1)!.cells[0].activeTabId).toBe('x')
  })

  // 1x1 is the way BACK to classic tabs: every tab preserved, in the order the
  // panes read, and nothing closed.
  it('collapses to one pane holding every tab, in reading order', () => {
    const l = reflow(three(), 1, 1)!
    expect(l.cells).toHaveLength(1)
    expect(layoutTabIds(l)).toEqual(['a', 'b', 'c'])
    expect(broken(l)).toEqual([])
  })

  it('refuses a grid that would leave an empty track — no state change', () => {
    expect(reflow(three(), 4, 1)).toBeNull()
    expect(reflow(three(), 2, 3)).toBeNull()
  })

  it('leaves no two cells overlapping when a row does not divide evenly', () => {
    const five = layout(5, 1, ['a', 'b', 'c', 'd', 'e'].map((id, i) => cell([id], i, 0)))
    const l = reflow(five, 3, 2)!
    expect(l.cells).toHaveLength(5)
    expect(broken(l)).toEqual([])
  })
})

describe('purity', () => {
  it('never mutates the input layout or its cells', () => {
    // Deliberately SPARSE (nothing in column 2 or row 2), so `compact` really
    // does have anchors to re-rank — against a tiled fixture it would rewrite
    // every cell to the value it already had and mutation would not show.
    const l = layout(4, 4, [cell(['a', 'x'], 0, 0, 2, 2), cell(['b'], 3, 3)])
    const snapshot = structuredClone(l)
    place(l, cell(['c'], 2, 0))
    moveTab(l, 'x', '3,3')
    setCellTabs(l, '0,0', ['x', 'a'])
    showTab(l, 'x')
    removeTab(l, 'a')
    splitCell(l, '0,0', 'x', 'right')
    swapCells(l, '0,0', '3,3')
    moveCellBeside(l, '0,0', '3,3', 'right')
    closeCell(l, '0,0')
    reflow(l, 2, 1)
    compact(l)
    findFree(l, 1, 1)
    expect(l).toEqual(snapshot)
  })
  it('returns a new cells array', () => {
    const l = layout(2, 2, [cell(['a', 'x'], 0, 0), cell(['b'], 1, 0)])
    expect(place(l, cell(['c'], 0, 1)).cells).not.toBe(l.cells)
    expect(showTab(l, 'x').cells).not.toBe(l.cells)
    expect(compact(l).cells).not.toBe(l.cells)
  })
})

/**
 * The invariants are enforced in the model, not asked of callers, so no
 * SEQUENCE of legal operations may be able to break them either. Deterministic
 * PRNG (mulberry32) so a failure is reproducible rather than flaky.
 */
describe('invariant sweep: no tab in two panes, none in none, nothing untiled', () => {
  function mulberry32(seed: number) {
    let a = seed
    return () => {
      a |= 0
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  it('holds after every op of 400 random sequences, and loses no tab', () => {
    const ids = ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7']
    for (let seed = 1; seed <= 400; seed++) {
      const rand = mulberry32(seed * 104729)
      const pick = <X>(xs: readonly X[]): X => xs[Math.floor(rand() * xs.length)]
      let l = single(ids, 't0')
      // Cut it into a few panes first, so the sequences act on real grids.
      for (let k = 0; k < 3; k++) {
        const target = pick(l.cells)
        if (target.tabIds.length < 2) continue
        l = splitCell(l, cellKey(target), pick(target.tabIds), pick(['left', 'right', 'top', 'bottom'] as const))
      }

      for (let step = 0; step < 12; step++) {
        const keys = l.cells.map(cellKey)
        const tab = pick(ids.filter((id) => cellOf(l, id)))
        const op = Math.floor(rand() * 8)
        const next =
          op === 0 ? moveTab(l, tab, pick(keys), Math.floor(rand() * 4))
          : op === 1 ? splitCell(l, pick(keys), tab, pick(['left', 'right', 'top', 'bottom'] as const))
          : op === 2 ? swapCells(l, pick(keys), pick(keys))
          : op === 3 ? moveCellBeside(l, pick(keys), pick(keys), pick(['left', 'right', 'top', 'bottom'] as const))
          : op === 4 ? showTab(l, tab)
          : op === 5 ? insertAtSeam(l, tab, pick(['col', 'row'] as const), Math.floor(rand() * 3), 0, 1 + Math.floor(rand() * 2))
          : op === 6 ? (closeCell(l, pick(keys)) ?? l)
          : (reflow(l, 1 + Math.floor(rand() * 3), 1 + Math.floor(rand() * 3)) ?? l)

        expect(broken(next)).toEqual([])
        // None of these ops closes a tab, so every one is still in some pane.
        expect([...layoutTabIds(next)].sort()).toEqual([...ids].sort())
        l = next
      }
    }
  })
})
