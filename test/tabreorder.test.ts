import { describe, it, expect } from 'vitest'
import { reorder } from '../src/shared/tabreorder'

describe('reorder', () => {
  it('moves A to the right of C', () => {
    expect(reorder(['A', 'B', 'C', 'D'], 0, 2)).toEqual(['B', 'C', 'A', 'D'])
  })
  it('moves D to the left of B', () => {
    expect(reorder(['A', 'B', 'C', 'D'], 3, 1)).toEqual(['A', 'D', 'B', 'C'])
  })
  it('is a no-op when the post-splice insert is the item’s own index', () => {
    expect(reorder(['A', 'B', 'C'], 1, 1)).toEqual(['A', 'B', 'C'])
  })
})
