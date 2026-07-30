import type { CSSProperties } from 'react'
import type { GridCell, GridLayout } from '../shared/types'

/**
 * Pure geometry for the split-view render layer (KAN-46), the sibling of
 * `gridlayout.ts` the same way `fs.ts` is the sibling of `fs.handlers.ts`:
 * gridlayout owns *which cells are legal*, this module owns *how a legal
 * layout becomes CSS* and *how a divider drag becomes fractions*. No React
 * element, no DOM node, no pixel position of a pane — CSS Grid computes those
 * from the templates built here, which is the whole reason `GridCell` carries
 * spans instead of coordinates.
 */

/**
 * Track sizes are kept normalised to `sum === count`, so an untouched grid is
 * exactly `[1, 1, ...]` and `extentPx / count` is the pixel value of 1fr.
 * That invariant is what makes `resizeFractions` px<->fr conversion a single
 * division instead of a running total.
 *
 * Anything that isn't a full set of finite positive numbers falls back to an
 * even split rather than being repaired entry-by-entry: a fractions array is
 * persisted state (`workspace.json`) and a partially-plausible one — three
 * numbers for a four-column grid — has no defensible interpretation. Scaling
 * a zero-filled gap would silently render a pane at zero width, which looks
 * like the app lost a tab.
 */
export function normalizeFractions(fractions: readonly number[] | undefined, count: number): number[] {
  const n = Math.max(1, Math.floor(count))
  if (!fractions || fractions.length !== n || fractions.some((f) => !Number.isFinite(f) || f <= 0))
    return Array(n).fill(1)
  const sum = fractions.reduce((a, b) => a + b, 0)
  return fractions.map((f) => (f * n) / sum)
}

/** Rounded to 4dp so a dragged template is a readable style string rather than
 *  `1.0000000000000002fr`; 1e-4 of a track is far below one device pixel. */
export function gridTemplate(fractions: readonly number[] | undefined, count: number): string {
  return normalizeFractions(fractions, count)
    .map((f) => `${Math.round(f * 1e4) / 1e4}fr`)
    .join(' ')
}

/** A cell's `grid-area`. CSS grid lines are 1-based, `GridCell` is 0-based. */
export function cellArea(cell: GridCell): CSSProperties {
  return {
    gridColumn: `${cell.col + 1} / span ${Math.max(1, cell.colSpan)}`,
    gridRow: `${cell.row + 1} / span ${Math.max(1, cell.rowSpan)}`,
  }
}

/** `index` is the track to the LEFT of (or ABOVE) the seam, so a col divider
 *  with index 0 sits on the boundary between column 0 and column 1. */
export interface Divider {
  axis: 'col' | 'row'
  index: number
}

/** Every interior seam of the grid. An N-track axis has N-1 of them — the
 *  outer edges of the grid are not draggable, there is nothing beyond them. */
export function dividers(layout: GridLayout): Divider[] {
  const out: Divider[] = []
  for (let i = 0; i < layout.cols - 1; i++) out.push({ axis: 'col', index: i })
  for (let i = 0; i < layout.rows - 1; i++) out.push({ axis: 'row', index: i })
  return out
}

/**
 * The divider's grab box, expressed as a `grid-area` on the SAME grid as the
 * panes rather than as a pixel offset. Placing the handle at the start edge of
 * track `index + 1` (grid line `index + 2`) means it tracks the template for
 * free: rewriting `grid-template-columns` mid-drag moves the handle with the
 * seam, with no second position to keep in sync. It also means hit-testing
 * "which divider is the pointer on" is the browser's own job — the handles are
 * real elements with real hit boxes stacked above the panes, so there is no
 * hand-rolled hit-test to get wrong. Testing this function IS testing the hit
 * boxes: a handle placed on the wrong grid line is exactly a hit-test bug.
 *
 * The cross-axis span is `1 / -1`, the full length of the seam.
 */
export function dividerArea(d: Divider): CSSProperties {
  return d.axis === 'col'
    ? { gridColumn: `${d.index + 2} / span 1`, gridRow: '1 / -1' }
    : { gridRow: `${d.index + 2} / span 1`, gridColumn: '1 / -1' }
}

/** Floor on a pane's short side. A pane narrower than this cannot show a
 *  usable terminal, and a pane at zero is unrecoverable — there is no seam
 *  left to grab to bring it back. */
export const MIN_PANE_PX = 80

/**
 * The new fractions after dragging divider `index` by `deltaPx`.
 *
 * A drag is strictly local: only the two tracks either side of the seam
 * change, and their sum is preserved, so every other pane in the grid keeps
 * its exact size. `deltaPx` is measured from where the drag STARTED against
 * the fractions as they were at that moment (pass the pointerdown snapshot as
 * `fractions`), not accumulated per pointermove — accumulating drifts once the
 * clamp starts biting, because the clamped frames would be lost.
 *
 * The clamp is two-sided and applied to the delta rather than to the results,
 * which is what makes dragging past the limit *stick* at the limit instead of
 * inverting. When the pair is too small to give both sides `minPx` (a genuinely
 * tiny window) the drag is refused outright rather than splitting the
 * difference: silently redistributing tracks the user did not grab is worse
 * than nothing happening.
 */
export function resizeFractions(
  fractions: readonly number[] | undefined,
  count: number,
  index: number,
  deltaPx: number,
  extentPx: number,
  minPx: number = MIN_PANE_PX,
): number[] {
  const f = normalizeFractions(fractions, count)
  if (index < 0 || index >= f.length - 1) return f
  if (!Number.isFinite(deltaPx) || !(extentPx > 0)) return f

  // sum(f) === f.length by the normalise invariant, so this is exact.
  const pxPerFr = extentPx / f.length
  const minFr = minPx / pxPerFr
  const pair = f[index] + f[index + 1]
  if (pair < 2 * minFr) return f

  const d = Math.max(minFr - f[index], Math.min(f[index + 1] - minFr, deltaPx / pxPerFr))
  const next = [...f]
  next[index] = f[index] + d
  next[index + 1] = f[index + 1] - d
  return next
}
