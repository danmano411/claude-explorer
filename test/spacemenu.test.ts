import { describe, it, expect } from 'vitest'
import { acceleratorLabel, canDeleteSpace, nextFocusIndex } from '../src/renderer/spacemenu'

describe('acceleratorLabel', () => {
  it('labels the first nine UNPINNED indices Ctrl+1..Ctrl+9 (pinned omitted or false)', () => {
    expect(acceleratorLabel(0)).toBe('Ctrl+1')
    expect(acceleratorLabel(8)).toBe('Ctrl+9')
    expect(acceleratorLabel(0, false)).toBe('Ctrl+1')
  })

  it('has no label past the ninth index or below zero, unpinned or pinned', () => {
    expect(acceleratorLabel(9)).toBeNull()
    expect(acceleratorLabel(-1)).toBeNull()
    expect(acceleratorLabel(9, true)).toBeNull()
    expect(acceleratorLabel(-1, true)).toBeNull()
  })

  // KAN-82: pinned spaces get Ctrl+Shift+N instead of Ctrl+N, same nine slots.
  it('labels the first nine PINNED indices Ctrl+Shift+1..Ctrl+Shift+9', () => {
    expect(acceleratorLabel(0, true)).toBe('Ctrl+Shift+1')
    expect(acceleratorLabel(8, true)).toBe('Ctrl+Shift+9')
  })

  // The index is GROUP-RELATIVE, not the row's absolute position — a pinned
  // space and an unpinned space can both legitimately be passed index 2, and
  // must come back with DIFFERENT labels distinguished only by `pinned`.
  it('the same index means different spaces depending on pinned — group-relative, not absolute', () => {
    expect(acceleratorLabel(2, false)).toBe('Ctrl+3')
    expect(acceleratorLabel(2, true)).toBe('Ctrl+Shift+3')
  })
})

describe('canDeleteSpace', () => {
  it('refuses when it is the only space', () => {
    expect(canDeleteSpace(1)).toBe(false)
  })

  it('allows deletion once more than one space exists', () => {
    expect(canDeleteSpace(2)).toBe(true)
  })
})

describe('nextFocusIndex', () => {
  it('ArrowDown from no selection (-1) lands on the first item', () => {
    expect(nextFocusIndex(-1, 'ArrowDown', 4)).toBe(0)
  })

  it('ArrowUp from no selection (-1) lands on the LAST item, not the penultimate one', () => {
    // Regression: naive (idx - 1 + count) % count with idx=-1 gives count-2.
    expect(nextFocusIndex(-1, 'ArrowUp', 4)).toBe(3)
  })

  it('wraps ArrowDown past the last item back to the first', () => {
    expect(nextFocusIndex(3, 'ArrowDown', 4)).toBe(0)
  })

  it('wraps ArrowUp past the first item back to the last', () => {
    expect(nextFocusIndex(0, 'ArrowUp', 4)).toBe(3)
  })

  it('returns -1 for an empty list', () => {
    expect(nextFocusIndex(-1, 'ArrowDown', 0)).toBe(-1)
  })
})
