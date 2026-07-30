import { describe, it, expect } from 'vitest'
import type { GridCell, GridLayout } from '../src/shared/types'
import type { PaneBox, SeamBox } from '../src/renderer/splitgrid'
import {
  EDGE_FRACTION,
  MIN_PANE_PX,
  MIN_SPLIT_PX,
  SEAM_HIT_PX,
  SEAM_PX,
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

const cell = (tabId: string, col: number, row: number, colSpan = 1, rowSpan = 1): GridCell => ({
  tabId,
  col,
  row,
  colSpan,
  rowSpan,
})

const layout = (cols: number, rows: number, cells: GridCell[] = []): GridLayout => ({ cols, rows, cells })

/** A full cols x rows of 1x1 cells, named a, b, c... in reading order. */
const grid = (cols: number, rows: number): GridLayout => {
  const cells: GridCell[] = []
  let i = 0
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols; col++) cells.push(cell(String.fromCharCode(97 + i++), col, row))
  return { cols, rows, cells }
}

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)

/** A measured pane box, container-relative px — what the caller reads off
 *  `getBoundingClientRect()` for a `[data-pane]` element. */
const pane = (tabId: string, left: number, top: number, width: number, height: number): PaneBox => ({
  tabId,
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
    expect(cellArea(cell('a', 0, 0))).toEqual({ gridColumn: '1 / span 1', gridRow: '1 / span 1' })
    expect(cellArea(cell('b', 2, 1))).toEqual({ gridColumn: '3 / span 1', gridRow: '2 / span 1' })
  })
  it('keeps spans, which is what makes an m x n block one pane', () => {
    expect(cellArea(cell('c', 1, 0, 2, 3))).toEqual({ gridColumn: '2 / span 2', gridRow: '1 / span 3' })
  })
  it('never emits span 0 (CSS would treat it as an error)', () => {
    expect(cellArea(cell('d', 0, 0, 0, 0))).toEqual({ gridColumn: '1 / span 1', gridRow: '1 / span 1' })
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
    const span = layout(3, 2, [cell('a', 0, 0, 2, 2), cell('b', 2, 0), cell('c', 2, 1)])
    expect(dividers(span)).toEqual([
      { axis: 'col', index: 1, start: 0, end: 2 }, // a | b,c — a real edge
      { axis: 'row', index: 0, start: 2, end: 3 }, // b | c, over column 2 only
    ])
  })
  it('clamps a seam to the cross-axis run where it is really a boundary', () => {
    // The row seam above only spans column 2: over columns 0-1 it would lie
    // inside `a`.
    const span = layout(3, 2, [cell('a', 0, 0, 2, 2), cell('b', 2, 0), cell('c', 2, 1)])
    const row = dividers(span).find((d) => d.axis === 'row')!
    expect([row.start, row.end]).toEqual([2, 3])
  })
  it('splits one seam into two handles when a span straddles only its middle', () => {
    // 3x3, `e` spans cols 1-2 of the middle row. The col1|col2 line is a real
    // boundary on rows 0 and 2, and buried inside `e` on row 1.
    const l = layout(3, 3, [
      cell('a', 0, 0), cell('b', 1, 0), cell('c', 2, 0),
      cell('d', 0, 1), cell('e', 1, 1, 2, 1),
      cell('f', 0, 2), cell('g', 1, 2), cell('h', 2, 2),
    ])
    expect(dividers(l).filter((d) => d.axis === 'col' && d.index === 1)).toEqual([
      { axis: 'col', index: 1, start: 0, end: 1 },
      { axis: 'col', index: 1, start: 2, end: 3 },
    ])
    expect(new Set(dividers(l).map(dividerId)).size).toBe(dividers(l).length)
  })
  it('emits no seam where no cell has an edge at all', () => {
    // A 3x1 holding one cell in column 0: its right edge is the col0|col1 line,
    // but nothing at all touches the col1|col2 line.
    expect(dividers(layout(3, 1, [cell('a', 0, 0)])))
      .toEqual([{ axis: 'col', index: 0, start: 0, end: 1 }])
  })
  it('has none at all for a layout with no cells', () => {
    expect(dividers(layout(3, 3))).toEqual([])
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
    // Drag far past the right edge: the right pane stops at MIN_PANE_PX (80 of
    // 1000px == 0.16fr), it does not collapse and does not invert.
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
    // Right pane already at 0.2fr (100px). It may only lose 20px more.
    const next = resizeFractions([1.8, 0.2], 2, 0, 500, W)
    expect(next[1]).toBeCloseTo(0.16)
  })
  it('refuses the drag when the pair cannot fit two minimums', () => {
    // 100px wide, 2 cols: 50px each, below the 80px floor. Redistributing
    // tracks the user did not grab would be worse than doing nothing.
    expect(resizeFractions(undefined, 2, 0, 30, 100)).toEqual([1, 1])
  })
  it('honours a caller-supplied minimum', () => {
    expect(resizeFractions(undefined, 2, 0, 5000, W, 250)).toEqual([1.5, 0.5])
  })
  it('never lets a caller ask for a zero-width pane, whatever it passes', () => {
    // A pane at 0 has no seam left to grab, so the drag that created it cannot
    // be undone. minPx is floored at 1px no matter what.
    for (const bad of [0, -50, NaN]) {
      const next = resizeFractions(undefined, 2, 0, 5000, W, bad)
      expect(next[1]).toBeGreaterThan(0)
      expect(sum(next)).toBeCloseTo(2)
    }
    // 1px of 1000px over 2 tracks == 0.002fr: the floor, not the 0 asked for.
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
      expect(p.dividers).toEqual([])
    }
  })
  it('is inert for a layout with no cells — remove() on the last pane yields one', () => {
    const p = gridPlacement(layout(2, 2))
    expect(p.split).toBe(false)
    expect(p.container).toEqual({})
  })

  it('makes the caller\'s own container a grid and gives every tab a grid-area', () => {
    const p = gridPlacement(grid(2, 2))
    expect(p.split).toBe(true)
    expect(p.container.display).toBe('grid')
    expect(p.container.gridTemplateColumns).toBe('1fr 1fr')
    expect(p.container.gridTemplateRows).toBe('1fr 1fr')
    expect(Object.keys(p.panes).sort()).toEqual(['a', 'b', 'c', 'd'])
    expect(p.panes.d).toEqual({ gridColumn: '2 / span 1', gridRow: '2 / span 1' })
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
    const p = gridPlacement(layout(2, 2, [cell('a', 0, 0), cell('x', 9, 0)]))
    expect(Object.keys(p.panes)).toEqual(['a'])
    expect(p.cells.map((c) => c.tabId)).toEqual(['a'])
  })
  it('drops a duplicate tabId — two panes claiming one terminal', () => {
    const p = gridPlacement(layout(2, 1, [cell('a', 0, 0), cell('a', 1, 0)]))
    expect(Object.keys(p.panes)).toEqual(['a'])
    expect(p.panes.a).toEqual({ gridColumn: '1 / span 1', gridRow: '1 / span 1' }) // first wins
  })
  it('drops an overlapping cell instead of stacking panes silently', () => {
    const p = gridPlacement(layout(2, 2, [cell('a', 0, 0, 2, 2), cell('b', 1, 1)]))
    expect(Object.keys(p.panes)).toEqual(['a'])
  })
  it('drops a cell with no tab, so no pane is keyed on an empty string', () => {
    const p = gridPlacement(layout(2, 1, [cell('', 0, 0), cell('b', 1, 0)]))
    expect(Object.keys(p.panes)).toEqual(['b'])
  })
  it('computes its dividers from the SANITISED cells, not the raw ones', () => {
    // The overlapping `b` is dropped, so `a` really does span the whole grid
    // and there is no seam anywhere.
    const p = gridPlacement(layout(2, 2, [cell('a', 0, 0, 2, 2), cell('b', 1, 1)]))
    expect(p.dividers).toEqual([])
  })
})

// KAN-56: hit-testing a pointer against the boxes the browser measured.
// Priority is seam > edge > centre; see the module comment for the geometry.
describe('dropZone', () => {
  it('is none when the pointer is over no pane at all', () => {
    expect(dropZone([pane('a', 0, 0, 800, 600)], [], 900, 300)).toEqual({ kind: 'none' })
  })

  it('is none for a zero-size pane, even where its box would contain the point', () => {
    expect(dropZone([pane('a', 0, 0, 0, 0)], [], 0, 0)).toEqual({ kind: 'none' })
  })

  it('is centre for the pane middle, and still centre exactly at the [.25, .75] boundary', () => {
    const p = pane('a', 0, 0, 800, 600)
    expect(dropZone([p], [], 400, 300)).toMatchObject({ kind: 'centre', tabId: 'a' })
    // dl = (800 * EDGE_FRACTION) / 800 === EDGE_FRACTION exactly: the centre
    // zone is inclusive of its own boundary, not open.
    expect(dropZone([p], [], 800 * EDGE_FRACTION, 300)).toMatchObject({ kind: 'centre', tabId: 'a' })
    // One px inside that boundary tips into the edge zone.
    expect(dropZone([p], [], 800 * EDGE_FRACTION - 1, 300)).toMatchObject({
      kind: 'edge',
      tabId: 'a',
      side: 'left',
    })
  })

  it('picks the nearest edge at each of the four midpoints', () => {
    const p = pane('a', 0, 0, 800, 600)
    expect(dropZone([p], [], 0, 300)).toMatchObject({ kind: 'edge', side: 'left' })
    expect(dropZone([p], [], 800, 300)).toMatchObject({ kind: 'edge', side: 'right' })
    expect(dropZone([p], [], 400, 0)).toMatchObject({ kind: 'edge', side: 'top' })
    expect(dropZone([p], [], 400, 600)).toMatchObject({ kind: 'edge', side: 'bottom' })
  })

  it('resolves an exact corner tie by a fixed order — left, right, top, bottom', () => {
    const p = pane('a', 0, 0, 800, 600)
    expect(dropZone([p], [], 0, 0)).toMatchObject({ side: 'left' }) // top-left
    expect(dropZone([p], [], 800, 0)).toMatchObject({ side: 'right' }) // top-right
    expect(dropZone([p], [], 0, 600)).toMatchObject({ side: 'left' }) // bottom-left
    expect(dropZone([p], [], 800, 600)).toMatchObject({ side: 'right' }) // bottom-right
  })

  it('degrades a too-narrow split axis to centre, without degrading the other axis', () => {
    // 100px wide, well under MIN_SPLIT_PX: a left/right split here would leave
    // a pane too small to grab a seam back from.
    const p = pane('a', 0, 0, 100, 600)
    expect(100).toBeLessThan(MIN_SPLIT_PX)
    expect(dropZone([p], [], 5, 300)).toMatchObject({ kind: 'centre', tabId: 'a' })
    // The row axis (600px) is nowhere near the floor, so it still splits.
    expect(dropZone([p], [], 50, 5)).toMatchObject({ kind: 'edge', side: 'top' })
  })

  it('a seam wins inside its grab band, and yields to the edge zone just outside it', () => {
    const a = pane('a', 0, 0, 400, 100)
    // Seam sits at x=400-402; SEAM_HIT_PX inflates and centres the grab band
    // around it, to [394, 406].
    const s = seamBox('col', 0, 0, 1, 400, 0, 2, 100)
    expect(dropZone([a], [s], 396, 50)).toMatchObject({ kind: 'seam', axis: 'col', index: 0 })
    // Still inside `a`'s right quarter (x >= 300), but outside the grab band.
    expect(dropZone([a], [s], 390, 50)).toMatchObject({ kind: 'edge', tabId: 'a', side: 'right' })
  })
})

describe('zoneId', () => {
  it('gives each zone kind its own stable string, seams reusing dividerId', () => {
    expect(zoneId({ kind: 'none' })).toBe('none')
    expect(
      zoneId({ kind: 'centre', tabId: 'a', box: { left: 0, top: 0, width: 1, height: 1 } }),
    ).toBe('centre:a')
    expect(
      zoneId({ kind: 'edge', tabId: 'a', side: 'left', box: { left: 0, top: 0, width: 1, height: 1 } }),
    ).toBe('edge:a:left')
    const d = { axis: 'col' as const, index: 0, start: 0, end: 1 }
    expect(
      zoneId({ kind: 'seam', ...d, box: { left: 0, top: 0, width: 1, height: 1 } }),
    ).toBe(`seam:${dividerId(d)}`)
  })
})
