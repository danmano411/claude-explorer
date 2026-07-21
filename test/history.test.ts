import { describe, it, expect } from 'vitest'
import { initHistory, navigate, goBack, goForward, canBack, canForward } from '../src/renderer/history'

describe('history', () => {
  it('navigate pushes current to back and clears forward', () => {
    let h = initHistory('C:\\a')
    h = navigate(h, 'C:\\a\\b')
    h = navigate(h, 'C:\\a\\b\\c')
    expect(h.current).toBe('C:\\a\\b\\c')
    expect(h.back).toEqual(['C:\\a', 'C:\\a\\b'])
    h = goBack(h)
    expect(h.current).toBe('C:\\a\\b')
    expect(canForward(h)).toBe(true)
    h = navigate(h, 'C:\\z') // navigating after back clears forward
    expect(canForward(h)).toBe(false)
  })
  it('goBack/goForward are no-ops at the ends', () => {
    let h = initHistory('C:\\a')
    expect(canBack(h)).toBe(false)
    expect(goBack(h)).toEqual(h)
    expect(goForward(h)).toEqual(h)
  })
})
