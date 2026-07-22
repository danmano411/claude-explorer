import { describe, it, expect } from 'vitest'
import { dropIndex, reorder } from '../src/renderer/tabreorder'

describe('dropIndex', () => {
  it('drops to the right of the target (dragging rightward)', () => {
    expect(dropIndex(0, 2, 'right')).toBe(2) // A onto C-right in [A,B,C,D]
  })
  it('drops to the left of the target (dragging leftward)', () => {
    expect(dropIndex(3, 1, 'left')).toBe(1) // D onto B-left in [A,B,C,D]
  })
  it('drops to the right of an adjacent target', () => {
    expect(dropIndex(0, 1, 'right')).toBe(1)
  })
})

describe('reorder', () => {
  it('moves A to the right of C', () => {
    expect(reorder(['A', 'B', 'C', 'D'], 0, dropIndex(0, 2, 'right'))).toEqual(['B', 'C', 'A', 'D'])
  })
  it('moves D to the left of B', () => {
    expect(reorder(['A', 'B', 'C', 'D'], 3, dropIndex(3, 1, 'left'))).toEqual(['A', 'D', 'B', 'C'])
  })
  it('is a no-op when dropping a tab onto its own right edge neighbor position', () => {
    expect(reorder(['A', 'B', 'C'], 1, dropIndex(1, 1, 'left'))).toEqual(['A', 'B', 'C'])
  })
})
