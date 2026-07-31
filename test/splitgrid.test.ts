import { describe, it, expect } from 'vitest'
import type { GridCell, GridLayout } from '../src/shared/types'
import type { PaneBox, SeamBox } from '../src/renderer/splitgrid'
import {
  EDGE_FRACTION,
  MIN_PANE_PX,
  MIN_SPLIT_PX,
  SEAM_HIT_PX,
  SEAM_PX,
  STRIP_PX,
  cellArea,
  dividerArea,
  dividerId,
  dividers,
  dropZone,
  gridPlacement,
  gridTemplate,
  normalizeFractions,
  resizeFractions,
  zoneId,
} from '../src/renderer/splitgrid'

const cell = (
  tabIds: string[],
  col: number,
  row: number,
  colSpan = 1,
  rowSpan = 1,
  activeTabId = tabIds[0],
): GridCell => ({ tabIds, activeTabId, col, row, colSpan, rowSpan })

const layout = (cols: number, rows: number, cells: GridCell[] = []): GridLayout => ({ cols, rows, cells })

/** A full cols x rows of one-tab cells, named a, b, c... in reading order. */
const grid = (cols: number, rows: number): GridLayout => {
  const cells: GridCell[] = []
  let i = 0
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols; col++) cells.push(cell([String.fromCharCode(97 + i++)], col, row))
  return { cols, rows, cells }
}

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)

/** A measured pane BODY box, container-relative px — what the caller reads off
 *  `getBoundingClientRect()` for a `[data-pane]` element. */
const pane = (cellKey: string, left: number, top: number, width: number, height: number): PaneBox => ({
  cell: cellKey,
  left,
  top,
  width,
  height,
})

/** A measured seam box — the DIVIDER's own grab area, pre-inflation. */
const seamBox = (
  axis: 'col' | 'row',
  index: number,
  start: number,
  end: number,
  left: number,
  top: number,
  width: number,
  height: number,
): SeamBox => ({ axis, index, start, end, left, top, width, height })

describe('normalizeFractions', () => {
  it('defaults to an even split', () => {
    expect(normalizeFractions(undefined, 3)).toEqual([1, 1, 1])
  })
  it('keeps sum === count, the invariant resizeFractions divides by', () => {
    const f = normalizeFractions([3, 1], 2)
    expect(sum(f)).toBeCloseTo(2)
    expect(f).toEqual([1.5, 0.5])
  })
  it('is idempotent', () => {
    const once = normalizeFractions([7, 2, 1], 3)
    expect(normalizeFractions(once, 3)).toEqual(once)
  })
  it('falls back to even for a wrong-length array rather than guessing', () => {
    expect(normalizeFractions([1, 1], 3)).toEqual([1, 1, 1])
    expect(normalizeFractions([1, 1, 1, 1], 3)).toEqual([1, 1, 1])
  })
  it('falls back to even for a zero or negative or NaN entry', () => {
    // Scaling these through would render a pane at zero width, which looks
    // like a lost tab rather than a bad settings file.
    expect(normalizeFractions([1, 0], 2)).toEqual([1, 1])
    expect(normalizeFractions([2, -1], 2)).toEqual([1, 1])
    expect(normalizeFractions([1, NaN], 2)).toEqual([1, 1])
    expect(normalizeFractions([1, Infinity], 2)).toEqual([1, 1])
  })
  it('never returns an empty template for a degenerate count', () => {
    expect(normalizeFractions(undefined, 0)).toEqual([1])
    expect(normalizeFractions(undefined, -3)).toEqual([1])
  })
})

describe('gridTemplate', () => {
  it('maps an untouched axis to equal fr tracks', () => {
    expect(gridTemplate(undefined, 1)).toBe('1fr')
    expect(gridTemplate(undefined, 3)).toBe('1fr 1fr 1fr')
  })
  it('carries a resized axis through as fr, normalised', () => {
    expect(gridTemplate([3, 1], 2)).toBe('1.5fr 0.5fr')
  })
  it('rounds to 4dp so float noise never reaches the style attribute', () => {
    expect(gridTemplate([1, 1, 1.0000000000000002], 3)).toBe('1fr 1fr 1fr')
    expect(gridTemplate([1, 2], 2)).toBe('0.6667fr 1.3333fr')
  })
})

describe('cellArea', () => {
  it('converts 0-based cells to 1-based grid lines with spans', () => {
    expect(cellArea(cell(['a'], 0, 0))).toEqual({ gridColumn: '1 / span 1', gridRow: '1 / span 1' })
    expect(cellArea(cell(['b'], 2, 1))).toEqual({ gridColumn: '3 / span 1', gridRow: '2 / span 1' })
  })
  it('keeps spans, which is what makes an m x n block one pane', () => {
    expect(cellArea(cell(['c'], 1, 0, 2, 3))).toEqual({ gridColumn: '2 / span 2', gridRow: '1 / span 3' })
  })
  it('never emits span 0 (CSS would treat it as an error)', () => {
    expect(cellArea(cell(['d'], 0, 0, 0, 0))).toEqual({ gridColumn: '1 / span 1', gridRow: '1 / span 1' })
  })
})

describe('dividers', () => {
  it('a single pane has none', () => {
    expect(dividers(grid(1, 1))).toEqual([])
  })
  it('an N-track axis has N-1 interior seams, and no seam on the outer edge', () => {
    expect(dividers(grid(2, 1))).toEqual([{ axis: 'col', index: 0, start: 0, end: 1 }])
    expect(dividers(grid(1, 2))).toEqual([{ axis: 'row', index: 0, start: 0, end: 1 }])
    expect(dividers(grid(3, 3))).toEqual([
      { axis: 'col', index: 0, start: 0, end: 3 },
      { axis: 'col', index: 1, start: 0, end: 3 },
      { axis: 'row', index: 0, start: 0, end: 3 },
      { axis: 'row', index: 1, start: 0, end: 3 },
    ])
  })
  it('gives every divider a unique id, so React keys are stable', () => {
    const ds = dividers(grid(4, 4))
    expect(new Set(ds.map(dividerId)).size).toBe(ds.length)
  })

  // The defect this replaced: seams were emitted per grid LINE, so a line
  // buried inside a spanning cell got a full-length handle that changed nothing
  // when dragged, yet still persisted lopsided fractions and sat above a live
  // terminal eating pointer events.
  it('emits no seam for a line that runs through the middle of a spanning cell', () => {
    // 3x2; `a` covers cols 0-1 and both rows. The col0|col1 line is inside `a`.
    const span = layout(3, 2, [cell(['a'], 0, 0, 2, 2), cell(['b'], 2, 0), cell(['c'], 2, 1)])
    expect(dividers(span)).toEqual([
      { axis: 'col', index: 1, start: 0, end: 2 }, // a | b,c — a real edge
      { axis: 'row', index: 0, start: 2, end: 3 }, // b | c, over column 2 only
    ])
  })
  it('clamps a seam to the cross-axis run where it is really a boundary', () => {
    const span = layout(3, 2, [cell(['a'], 0, 0, 2, 2), cell(['b'], 2, 0), cell(['c'], 2, 1)])
    const row = dividers(span).find((d) => d.axis === 'row')!
    expect([row.start, row.end]).toEqual([2, 3])
  })
  it('splits one seam into two handles when a span straddles only its middle', () => {
    // 3x3, `e` spans cols 1-2 of the middle row. The col1|col2 line is a real
    // boundary on rows 0 and 2, and buried inside `e` on row 1.
    const l = layout(3, 3, [
      cell(['a'], 0, 0), cell(['b'], 1, 0), cell(['c'], 2, 0),
      cell(['d'], 0, 1), cell(['e'], 1, 1, 2, 1),
      cell(['f'], 0, 2), cell(['g'], 1, 2), cell(['h'], 2, 2),
    ])
    expect(dividers(l).filter((d) => d.axis === 'col' && d.index === 1)).toEqual([
      { axis: 'col', index: 1, start: 0, end: 1 },
      { axis: 'col', index: 1, start: 2, end: 3 },
    ])
    expect(new Set(dividers(l).map(dividerId)).size).toBe(dividers(l).length)
  })
  it('emits no seam where no cell has an edge at all', () => {
    expect(dividers(layout(3, 1, [cell(['a'], 0, 0)])))
      .toEqual([{ axis: 'col', index: 0, start: 0, end: 1 }])
  })
  it('has none at all for a layout with no cells', () => {
    expect(dividers(layout(3, 3))).toEqual([])
  })

  // KAN-56: a cell is a strip now, and the seam maths must not have learned
  // about tabs. Same rectangles, same seams, however many tabs are in them.
  it('depends on the rectangles only, never on what is in the strips', () => {
    const rects: [number, number, number, number][] = [[0, 0, 2, 2], [2, 0, 1, 1], [2, 1, 1, 1]]
    const lean = layout(3, 2, rects.map(([c, r, cs, rs], i) => cell([`t${i}`], c, r, cs, rs)))
    const fat = layout(
      3, 2,
      rects.map(([c, r, cs, rs], i) => cell([`t${i}`, `u${i}`, `v${i}`], c, r, cs, rs, `v${i}`)),
    )
    expect(dividers(fat)).toEqual(dividers(lean))
  })
})

describe('dividerArea', () => {
  // A handle placed on the wrong grid line IS a hit-test bug: these are the
  // grab boxes the browser hit-tests against.
  it('puts a col handle on the line between its two tracks, spanning its run', () => {
    expect(dividerArea({ axis: 'col', index: 0, start: 0, end: 3 }))
      .toEqual({ gridColumn: '2 / span 1', gridRow: '1 / 4' })
    expect(dividerArea({ axis: 'col', index: 1, start: 0, end: 3 }))
      .toEqual({ gridColumn: '3 / span 1', gridRow: '1 / 4' })
  })
  it('puts a row handle on the line between its two tracks, spanning its run', () => {
    expect(dividerArea({ axis: 'row', index: 0, start: 0, end: 2 }))
      .toEqual({ gridRow: '2 / span 1', gridColumn: '1 / 3' })
  })
  it('confines a partial seam to its own run instead of crossing a neighbour', () => {
    expect(dividerArea({ axis: 'row', index: 0, start: 2, end: 3 }))
      .toEqual({ gridRow: '2 / span 1', gridColumn: '3 / 4' })
  })
  it('never lands on line 1, which is the grid edge and not draggable', () => {
    for (const d of dividers(grid(4, 4))) {
      const a = dividerArea(d)
      const line = parseInt(String(d.axis === 'col' ? a.gridColumn : a.gridRow), 10)
      expect(line).toBeGreaterThanOrEqual(2)
      expect(line).toBeLessThanOrEqual(4) // last interior line of a 4-track axis
    }
  })
})

describe('resizeFractions', () => {
  const W = 1000

  it('a 100px drag right on a 2-col 1000px grid moves 0.2fr across the seam', () => {
    // 1000px / 2fr => 500px per fr, so 100px == 0.2fr.
    expect(resizeFractions(undefined, 2, 0, 100, W)).toEqual([1.2, 0.8])
  })
  it('is symmetric for a leftward drag', () => {
    expect(resizeFractions(undefined, 2, 0, -100, W)).toEqual([0.8, 1.2])
  })
  it('preserves the total, so the grid still fills its box', () => {
    expect(sum(resizeFractions(undefined, 3, 1, 137, W))).toBeCloseTo(3)
  })
  it('touches ONLY the two tracks either side of the seam', () => {
    const next = resizeFractions(undefined, 4, 1, 100, W) // 250px per fr
    expect(next[0]).toBe(1)
    expect(next[3]).toBe(1)
    expect(next[1]).toBeCloseTo(1.4)
    expect(next[2]).toBeCloseTo(0.6)
  })

  it('clamps at minPx instead of letting a pane reach zero', () => {
    const next = resizeFractions(undefined, 2, 0, 5000, W)
    expect(next[1]).toBeCloseTo(0.16)
    expect(next[0]).toBeCloseTo(1.84)
    expect(next[1] * (W / 2)).toBeCloseTo(MIN_PANE_PX)
  })
  it('clamps the same way on the other side', () => {
    const next = resizeFractions(undefined, 2, 0, -5000, W)
    expect(next[0]).toBeCloseTo(0.16)
    expect(next[1]).toBeCloseTo(1.84)
  })
  it('sticks at the clamp and comes back exactly — the clamp is on the delta', () => {
    const pinned = resizeFractions(undefined, 2, 0, 5000, W)
    expect(resizeFractions(undefined, 2, 0, 6000, W)).toEqual(pinned) // still pinned
    expect(resizeFractions(undefined, 2, 0, 0, W)).toEqual([1, 1]) // fully reversible
  })
  it('respects an already-narrow neighbour rather than the initial split', () => {
    const next = resizeFractions([1.8, 0.2], 2, 0, 500, W)
    expect(next[1]).toBeCloseTo(0.16)
  })
  it('refuses the drag when the pair cannot fit two minimums', () => {
    expect(resizeFractions(undefined, 2, 0, 30, 100)).toEqual([1, 1])
  })
  it('honours a caller-supplied minimum', () => {
    // SplitDividers passes MIN_PANE_PX + STRIP_PX on the row axis, because a
    // row's floor has to leave room for that pane's own strip as well.
    expect(resizeFractions(undefined, 2, 0, 5000, W, 250)).toEqual([1.5, 0.5])
    const row = resizeFractions(undefined, 2, 0, 5000, W, MIN_PANE_PX + STRIP_PX)
    expect(row[1] * (W / 2)).toBeCloseTo(MIN_PANE_PX + STRIP_PX)
  })
  it('never lets a caller ask for a zero-width pane, whatever it passes', () => {
    for (const bad of [0, -50, NaN]) {
      const next = resizeFractions(undefined, 2, 0, 5000, W, bad)
      expect(next[1]).toBeGreaterThan(0)
      expect(sum(next)).toBeCloseTo(2)
    }
    const floored = resizeFractions(undefined, 2, 0, 5000, W, 0)
    expect(floored[1]).toBeCloseTo(0.002, 6)
    expect(floored[1] * (W / 2)).toBeCloseTo(1)
  })

  it('is a no-op for a seam that does not exist', () => {
    expect(resizeFractions(undefined, 2, 1, 100, W)).toEqual([1, 1]) // index cols-1
    expect(resizeFractions(undefined, 2, -1, 100, W)).toEqual([1, 1])
    expect(resizeFractions(undefined, 1, 0, 100, W)).toEqual([1])
  })
  it('is a no-op for a zero-size or non-finite measurement', () => {
    expect(resizeFractions(undefined, 2, 0, 100, 0)).toEqual([1, 1])
    expect(resizeFractions(undefined, 2, 0, NaN, W)).toEqual([1, 1])
  })
  it('normalises a bad fractions array before resizing instead of propagating it', () => {
    expect(resizeFractions([5, 5], 2, 0, 100, W)).toEqual([1.2, 0.8])
    expect(resizeFractions([0, 2], 2, 0, 100, W)).toEqual([1.2, 0.8])
  })
})

describe('gridPlacement', () => {
  it('is inert without a layout, so the classic single-pane path is untouched', () => {
    for (const l of [null, undefined]) {
      const p = gridPlacement(l)
      expect(p.split).toBe(false)
      expect(p.container).toEqual({}) // no display:grid — the container stays a block
      expect(p.panes).toEqual({})
      expect(p.strips).toEqual({}) // no slots either: one global strip, no panes
      expect(p.dividers).toEqual([])
    }
  })
  it('is inert for a layout with no usable cells', () => {
    const p = gridPlacement(layout(2, 2))
    expect(p.split).toBe(false)
    expect(p.container).toEqual({})
  })

  it('makes the caller\'s own container a grid and gives every pane a grid-area', () => {
    const p = gridPlacement(grid(2, 2))
    expect(p.split).toBe(true)
    expect(p.container.display).toBe('grid')
    expect(p.container.gridTemplateColumns).toBe('1fr 1fr')
    expect(p.container.gridTemplateRows).toBe('1fr 1fr')
    expect(Object.keys(p.panes).sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  // KAN-56: a pane is a window and a window has a title bar. The pane BODY
  // starts below its own strip — `top` from the style attribute beating the
  // stylesheet's `inset: 0` is a RESIZE of a node that never moves, which is
  // what keeps an xterm alive across a pane change.
  it('pushes each pane below its own strip', () => {
    const p = gridPlacement(grid(2, 2))
    expect(p.panes.d).toEqual({ gridColumn: '2 / span 1', gridRow: '2 / span 1', top: STRIP_PX })
  })
  it('gives every cell a slot for its strip, on the same grid area as the pane', () => {
    const p = gridPlacement(grid(2, 2))
    expect(Object.keys(p.strips).sort()).toEqual(['0,0', '0,1', '1,0', '1,1'])
    expect(p.strips['1,1']).toEqual({ gridColumn: '2 / span 1', gridRow: '2 / span 1' })
    expect(p.strips['1,1']).not.toHaveProperty('top') // the strip IS the top
  })

  // Only the ACTIVE tab of a cell renders. A pane keyed on a background tab
  // would paint two terminals into one rectangle.
  it('places only each cell\'s active tab, never the rest of its strip', () => {
    const p = gridPlacement(
      layout(2, 1, [cell(['a', 'x'], 0, 0, 1, 1, 'x'), cell(['b', 'y'], 1, 0, 1, 1, 'b')]),
    )
    expect(Object.keys(p.panes).sort()).toEqual(['b', 'x'])
    expect(p.panes.x).toMatchObject({ gridColumn: '1 / span 1' })
    expect(p.panes.b).toMatchObject({ gridColumn: '2 / span 1' })
  })

  it('paints exactly one seam between panes, via the grid gap', () => {
    const p = gridPlacement(grid(2, 2))
    expect(p.container.gap).toBe(`${SEAM_PX}px`)
    expect(p.container.background).toBe('var(--line)')
  })
  it('carries the caller\'s fractions into the template and back out normalised', () => {
    const p = gridPlacement(grid(2, 1), [3, 1])
    expect(p.container.gridTemplateColumns).toBe('1.5fr 0.5fr')
    expect(p.cols).toEqual([1.5, 0.5])
    expect(p.rows).toEqual([1])
  })

  // workspace.json is a file on disk; gridlayout's invariants are not enforced
  // on the way back in.
  it('drops an out-of-bounds cell instead of letting CSS invent implicit tracks', () => {
    const p = gridPlacement(layout(2, 2, [cell(['a'], 0, 0), cell(['x'], 9, 0)]))
    expect(Object.keys(p.panes)).toEqual(['a'])
    expect(p.cells.map((c) => c.tabIds)).toEqual([['a']])
  })
  it('drops a repeated tab id from the LATER strip — two panes, one terminal', () => {
    const p = gridPlacement(layout(2, 1, [cell(['a', 'x'], 0, 0), cell(['x', 'b'], 1, 0, 1, 1, 'x')]))
    expect(p.cells.map((c) => c.tabIds)).toEqual([['a', 'x'], ['b']])
    // The later cell's activeTabId went with it, so it falls back to a member.
    expect(p.cells[1].activeTabId).toBe('b')
    expect(Object.keys(p.panes).sort()).toEqual(['a', 'b'])
  })
  it('drops a cell whose whole strip was already claimed', () => {
    const p = gridPlacement(layout(2, 1, [cell(['a'], 0, 0), cell(['a'], 1, 0)]))
    expect(p.cells).toHaveLength(1)
    expect(p.cells[0]).toMatchObject({ col: 0 }) // first wins
    expect(p.strips).toEqual({ '0,0': { gridColumn: '1 / span 1', gridRow: '1 / span 1' } })
  })
  it('repairs an activeTabId that is not in its own strip', () => {
    const p = gridPlacement(layout(2, 1, [cell(['a', 'x'], 0, 0, 1, 1, 'gone'), cell(['b'], 1, 0)]))
    expect(p.cells[0].activeTabId).toBe('a')
    expect(Object.keys(p.panes).sort()).toEqual(['a', 'b'])
  })
  it('drops an overlapping cell instead of stacking panes silently', () => {
    const p = gridPlacement(layout(2, 2, [cell(['a'], 0, 0, 2, 2), cell(['b'], 1, 1)]))
    expect(Object.keys(p.panes)).toEqual(['a'])
  })
  it('drops a cell with no tabs at all, so no pane is keyed on an empty string', () => {
    const p = gridPlacement(layout(2, 1, [cell([], 0, 0), cell(['b'], 1, 0)]))
    expect(Object.keys(p.panes)).toEqual(['b'])
    expect(Object.keys(p.strips)).toEqual(['1,0'])
  })
  it('drops a second cell at the same anchor, which would give one slot two strips', () => {
    const p = gridPlacement(layout(2, 1, [cell(['a'], 0, 0), cell(['b'], 0, 0), cell(['c'], 1, 0)]))
    expect(p.cells.map((c) => c.tabIds)).toEqual([['a'], ['c']])
    expect(Object.keys(p.strips).sort()).toEqual(['0,0', '1,0'])
  })
  it('computes its dividers from the SANITISED cells, not the raw ones', () => {
    // The trailing cell repeats `a`, so it holds nothing and is dropped. In the
    // RAW list it spans the whole row and would suppress both seams — a grid
    // with two visible pane edges and no handle to drag either of them.
    const p = gridPlacement(
      layout(3, 1, [cell(['a'], 0, 0), cell(['b'], 1, 0), cell(['c'], 2, 0), cell(['a'], 0, 0, 3, 1)]),
    )
    expect(p.cells).toHaveLength(3)
    expect(p.dividers).toEqual([
      { axis: 'col', index: 0, start: 0, end: 1 },
      { axis: 'col', index: 1, start: 0, end: 1 },
    ])
  })
})

// KAN-56: hit-testing a pointer against the boxes the browser measured.
// Priority is seam > strip > edge > centre — the STRIP is not in this function
// at all, because it is a real element whose own handler takes the drop first,
// and the boxes passed here are pane BODIES.
describe('dropZone', () => {
  it('is none when the pointer is over no pane at all', () => {
    expect(dropZone([pane('0,0', 0, 0, 800, 600)], [], 900, 300)).toEqual({ kind: 'none' })
  })

  it('is none for a zero-size pane, even where its box would contain the point', () => {
    expect(dropZone([pane('0,0', 0, 0, 0, 0)], [], 0, 0)).toEqual({ kind: 'none' })
  })

  it('is centre for the pane middle, and still centre exactly at the [.25, .75] boundary', () => {
    const p = pane('0,0', 0, 0, 800, 600)
    expect(dropZone([p], [], 400, 300)).toMatchObject({ kind: 'centre', cell: '0,0' })
    // dl = (800 * EDGE_FRACTION) / 800 === EDGE_FRACTION exactly: the centre
    // zone is inclusive of its own boundary, not open.
    expect(dropZone([p], [], 800 * EDGE_FRACTION, 300)).toMatchObject({ kind: 'centre', cell: '0,0' })
    // One px inside that boundary tips into the edge zone.
    expect(dropZone([p], [], 800 * EDGE_FRACTION - 1, 300)).toMatchObject({
      kind: 'edge',
      cell: '0,0',
      side: 'left',
    })
  })

  it('picks the nearest edge at each of the four midpoints', () => {
    const p = pane('0,0', 0, 0, 800, 600)
    expect(dropZone([p], [], 0, 300)).toMatchObject({ kind: 'edge', side: 'left' })
    expect(dropZone([p], [], 800, 300)).toMatchObject({ kind: 'edge', side: 'right' })
    expect(dropZone([p], [], 400, 0)).toMatchObject({ kind: 'edge', side: 'top' })
    expect(dropZone([p], [], 400, 600)).toMatchObject({ kind: 'edge', side: 'bottom' })
  })

  it('reports the cell under the pointer, not the first pane in the list', () => {
    const boxes = [pane('0,0', 0, 0, 400, 600), pane('1,0', 400, 0, 400, 600)]
    expect(dropZone(boxes, [], 600, 300)).toMatchObject({ kind: 'centre', cell: '1,0' })
    expect(dropZone(boxes, [], 790, 300)).toMatchObject({ kind: 'edge', cell: '1,0', side: 'right' })
  })

  it('paints the half it would create, not the whole pane, for an edge zone', () => {
    const z = dropZone([pane('0,0', 10, 20, 800, 600)], [], 10, 320)
    expect(z).toMatchObject({ kind: 'edge', side: 'left' })
    expect((z as { box: unknown }).box).toEqual({ left: 10, top: 20, width: 400, height: 600 })
  })

  it('resolves an exact corner tie by a fixed order — left, right, top, bottom', () => {
    // A square keeps the ties exactly representable; on 800x600 the diagonals
    // land on float noise and pick a side for a reason that is not this rule.
    const p = pane('0,0', 0, 0, 400, 400)
    expect(dropZone([p], [], 0, 0)).toMatchObject({ side: 'left' }) // top-left
    expect(dropZone([p], [], 400, 0)).toMatchObject({ side: 'right' }) // top-right
    expect(dropZone([p], [], 0, 400)).toMatchObject({ side: 'left' }) // bottom-left
    expect(dropZone([p], [], 400, 400)).toMatchObject({ side: 'right' }) // bottom-right
    // On the diagonal, away from the corner: still right, not top.
    expect(dropZone([p], [], 350, 50)).toMatchObject({ side: 'right' })
    expect(dropZone([p], [], 50, 350)).toMatchObject({ side: 'left' })
  })

  it('degrades a too-narrow split axis to centre, without degrading the other axis', () => {
    // 100px wide, well under MIN_SPLIT_PX: a left/right split here would leave
    // a pane too small to grab a seam back from.
    const p = pane('0,0', 0, 0, 100, 600)
    expect(100).toBeLessThan(MIN_SPLIT_PX)
    expect(dropZone([p], [], 5, 300)).toMatchObject({ kind: 'centre', cell: '0,0' })
    // The row axis (600px) is nowhere near the floor, so it still splits.
    expect(dropZone([p], [], 50, 5)).toMatchObject({ kind: 'edge', side: 'top' })
  })
  it('splits at exactly MIN_SPLIT_PX and refuses one pixel below it', () => {
    expect(dropZone([pane('0,0', 0, 0, MIN_SPLIT_PX, 600)], [], 1, 300))
      .toMatchObject({ kind: 'edge', side: 'left' })
    expect(dropZone([pane('0,0', 0, 0, MIN_SPLIT_PX - 1, 600)], [], 1, 300))
      .toMatchObject({ kind: 'centre' })
  })

  it('a seam wins inside its grab band, and yields to the edge zone just outside it', () => {
    const a = pane('0,0', 0, 0, 400, 100)
    // Seam sits at x=400-402; SEAM_HIT_PX inflates and centres the grab band
    // around it, to [395, 407].
    const s = seamBox('col', 0, 0, 1, 400, 0, 2, 100)
    expect(dropZone([a], [s], 396, 50)).toMatchObject({ kind: 'seam', axis: 'col', index: 0 })
    // Still inside `a`'s right quarter (x >= 300), but outside the grab band.
    expect(dropZone([a], [s], 390, 50)).toMatchObject({ kind: 'edge', cell: '0,0', side: 'right' })
  })
  it('centres the grab band on the seam, so it favours neither neighbour', () => {
    // A 2px seam at x=400 inflated to SEAM_HIT_PX reaches (SEAM_HIT_PX - 2) / 2
    // past each side of it — equally.
    const s = seamBox('col', 0, 0, 1, 400, 0, 2, 100)
    const reach = (SEAM_HIT_PX - 2) / 2
    const boxes = [pane('0,0', 0, 0, 400, 100), pane('1,0', 402, 0, 400, 100)]
    expect(dropZone(boxes, [s], 400 - reach, 50)).toMatchObject({ kind: 'seam' })
    expect(dropZone(boxes, [s], 402 + reach, 50)).toMatchObject({ kind: 'seam' })
    expect(dropZone(boxes, [s], 400 - reach - 1, 50)).toMatchObject({ kind: 'edge', cell: '0,0' })
    expect(dropZone(boxes, [s], 402 + reach + 1, 50)).toMatchObject({ kind: 'edge', cell: '1,0' })
  })
  it('carries the seam run through, so the insert knows how far the track goes', () => {
    const s = seamBox('row', 1, 2, 3, 0, 400, 800, 2)
    expect(dropZone([pane('0,0', 0, 0, 800, 800)], [s], 400, 400))
      .toMatchObject({ kind: 'seam', axis: 'row', index: 1, start: 2, end: 3 })
  })
})

describe('zoneId', () => {
  it('gives each zone kind its own stable string, seams reusing dividerId', () => {
    const box = { left: 0, top: 0, width: 1, height: 1 }
    expect(zoneId({ kind: 'none' })).toBe('none')
    expect(zoneId({ kind: 'centre', cell: '1,0', box })).toBe('centre:1,0')
    expect(zoneId({ kind: 'edge', cell: '1,0', side: 'left', box })).toBe('edge:1,0:left')
    const d = { axis: 'col' as const, index: 0, start: 0, end: 1 }
    expect(zoneId({ kind: 'seam', ...d, box })).toBe(`seam:${dividerId(d)}`)
  })
  it('separates the zones of two different panes, which is what stops the repaint', () => {
    const box = { left: 0, top: 0, width: 1, height: 1 }
    expect(zoneId({ kind: 'centre', cell: '0,0', box })).not.toBe(
      zoneId({ kind: 'centre', cell: '1,0', box }),
    )
  })
})
