import { describe, it, expect } from 'vitest'
import { emptySelection, applyClick } from '../src/renderer/selection'
const arr = (s: { indices: Set<number> }) => [...s.indices].sort((a, b) => a - b)

describe('selection', () => {
  it('plain click selects one', () => {
    const s = applyClick(emptySelection(), 3, { ctrl: false, shift: false })
    expect(arr(s)).toEqual([3]); expect(s.anchor).toBe(3)
  })
  it('ctrl toggles', () => {
    let s = applyClick(emptySelection(), 1, { ctrl: false, shift: false })
    s = applyClick(s, 4, { ctrl: true, shift: false })
    expect(arr(s)).toEqual([1, 4])
    s = applyClick(s, 4, { ctrl: true, shift: false })
    expect(arr(s)).toEqual([1])
  })
  it('shift selects contiguous range from anchor', () => {
    let s = applyClick(emptySelection(), 2, { ctrl: false, shift: false })
    s = applyClick(s, 5, { ctrl: false, shift: true })
    expect(arr(s)).toEqual([2, 3, 4, 5])
  })
  it('ctrl+shift adds a range to the existing set', () => {
    let s = applyClick(emptySelection(), 0, { ctrl: false, shift: false })
    s = applyClick(s, 8, { ctrl: true, shift: false })
    s = applyClick(s, 10, { ctrl: true, shift: true })
    expect(arr(s)).toEqual([0, 8, 9, 10])
  })
})
