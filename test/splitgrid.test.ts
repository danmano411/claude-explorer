import { describe, it, expect } from 'vitest'
import type { GridCell, GridLayout } from '../src/shared/types'
import {
  MIN_PANE_PX,
  cellArea,
  dividerArea,
  dividers,
  gridTemplate,
  normalizeFractions,
  resizeFractions,
} from '../src/renderer/splitgrid'

const cell = (tabId: string, col: number, row: number, colSpan = 1, rowSpan = 1): GridCell => ({
  tabId,
  col,
  row,
  colSpan,
  rowSpan,
})

const layout = (cols: number, rows: number, cells: GridCell[] = []): GridLayout => ({ cols, rows, cells })

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)

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
    expect(dividers(layout(1, 1))).toEqual([])
  })
  it('an N-track axis has N-1 interior seams, and no seam on the outer edge', () => {
    expect(dividers(layout(2, 1))).toEqual([{ axis: 'col', index: 0 }])
    expect(dividers(layout(1, 2))).toEqual([{ axis: 'row', index: 0 }])
    expect(dividers(layout(3, 3))).toEqual([
      { axis: 'col', index: 0 },
      { axis: 'col', index: 1 },
      { axis: 'row', index: 0 },
      { axis: 'row', index: 1 },
    ])
  })
  it('gives every divider a unique axis+index, so React keys are stable', () => {
    const ds = dividers(layout(4, 4))
    expect(new Set(ds.map((d) => `${d.axis}${d.index}`)).size).toBe(ds.length)
  })
})

describe('dividerArea', () => {
  // A handle placed on the wrong grid line IS a hit-test bug: these are the
  // grab boxes the browser hit-tests against.
  it('puts a col handle on the line between its two tracks, spanning all rows', () => {
    expect(dividerArea({ axis: 'col', index: 0 })).toEqual({ gridColumn: '2 / span 1', gridRow: '1 / -1' })
    expect(dividerArea({ axis: 'col', index: 1 })).toEqual({ gridColumn: '3 / span 1', gridRow: '1 / -1' })
  })
  it('puts a row handle on the line between its two tracks, spanning all columns', () => {
    expect(dividerArea({ axis: 'row', index: 0 })).toEqual({ gridRow: '2 / span 1', gridColumn: '1 / -1' })
  })
  it('never lands on line 1, which is the grid edge and not draggable', () => {
    for (const d of dividers(layout(4, 4))) {
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
  it('is measured from the snapshot, so the same delta is not applied twice', () => {
    const once = resizeFractions(undefined, 2, 0, 100, W)
    expect(resizeFractions(undefined, 2, 0, 100, W)).toEqual(once)
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
    expect(resizeFractions(undefined, 2, 0, 5000, W, 0)).toEqual([2, 0])
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
