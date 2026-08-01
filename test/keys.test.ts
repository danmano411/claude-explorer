import { describe, it, expect } from 'vitest'
import { isTextBox, isTypingTarget, pinnedSpaceIndex, spaceCycle, spaceIndex } from '../src/renderer/keys'

/**
 * `KeyboardEvent` fields these predicates read, structurally — vitest here
 * runs in `environment: 'node'` (see vitest.config.ts), so there is no real
 * DOM `KeyboardEvent` constructor; every predicate takes a plain object shape
 * instead, matching how the rest of this repo's pure modules are tested.
 */
const key = (
  k: string,
  code: string,
  mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {},
): KeyboardEvent =>
  ({
    key: k,
    code,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    metaKey: !!mods.meta,
  }) as KeyboardEvent

describe('spaceIndex', () => {
  it('Ctrl+1..Ctrl+9 map to 0-based indices 0..8', () => {
    for (let d = 1; d <= 9; d++) {
      expect(spaceIndex(key(String(d), `Digit${d}`, { ctrl: true }))).toBe(d - 1)
    }
  })
  it('is null with no ctrl at all', () => {
    expect(spaceIndex(key('3', 'Digit3'))).toBeNull()
  })
  // KAN-82's whole reason for a SEPARATE pinned predicate: Ctrl+Shift+3 reports
  // e.key === '!', which Number() would turn into NaN anyway, but the modifier
  // check must ALSO reject Shift explicitly — a future change to the digit
  // parsing must not accidentally let Shift ride along.
  it('is null when Shift rides along — that press belongs to pinnedSpaceIndex', () => {
    expect(spaceIndex(key('!', 'Digit1', { ctrl: true, shift: true }))).toBeNull()
  })
  it('is null with Alt or Meta held', () => {
    expect(spaceIndex(key('3', 'Digit3', { ctrl: true, alt: true }))).toBeNull()
    expect(spaceIndex(key('3', 'Digit3', { ctrl: true, meta: true }))).toBeNull()
  })
  it('is null for a non-digit key', () => {
    expect(spaceIndex(key('a', 'KeyA', { ctrl: true }))).toBeNull()
  })
})

describe('pinnedSpaceIndex', () => {
  it('Ctrl+Shift+1..Ctrl+Shift+9 map to 0-based indices 0..8, reading e.code', () => {
    // e.key values a real browser reports for Shift+digit (US layout) — proof
    // that this predicate is NOT reading e.key the way spaceIndex does.
    const shiftedKeys = ['!', '@', '#', '$', '%', '^', '&', '*', '(']
    for (let d = 1; d <= 9; d++) {
      const e = key(shiftedKeys[d - 1], `Digit${d}`, { ctrl: true, shift: true })
      expect(pinnedSpaceIndex(e)).toBe(d - 1)
    }
  })
  it('is null without Shift — that press belongs to spaceIndex, a DIFFERENT group', () => {
    expect(pinnedSpaceIndex(key('3', 'Digit3', { ctrl: true }))).toBeNull()
  })
  it('is null without Ctrl', () => {
    expect(pinnedSpaceIndex(key('#', 'Digit3', { shift: true }))).toBeNull()
  })
  it('is null with Alt or Meta additionally held', () => {
    expect(pinnedSpaceIndex(key('#', 'Digit3', { ctrl: true, shift: true, alt: true }))).toBeNull()
    expect(pinnedSpaceIndex(key('#', 'Digit3', { ctrl: true, shift: true, meta: true }))).toBeNull()
  })
  it('is null for a non-digit code', () => {
    expect(pinnedSpaceIndex(key('A', 'KeyA', { ctrl: true, shift: true }))).toBeNull()
  })
})

describe('spaceCycle', () => {
  it('Ctrl+Tab is forward (+1)', () => {
    expect(spaceCycle(key('Tab', 'Tab', { ctrl: true }))).toBe(1)
  })
  it('Ctrl+Shift+Tab is backward (-1)', () => {
    expect(spaceCycle(key('Tab', 'Tab', { ctrl: true, shift: true }))).toBe(-1)
  })
  it('is null for plain Tab (no ctrl) — this must not hijack ordinary tabbing', () => {
    expect(spaceCycle(key('Tab', 'Tab'))).toBeNull()
  })
  it('is null for Ctrl+Tab with Alt or Meta also held', () => {
    expect(spaceCycle(key('Tab', 'Tab', { ctrl: true, alt: true }))).toBeNull()
    expect(spaceCycle(key('Tab', 'Tab', { ctrl: true, meta: true }))).toBeNull()
  })
  it('is null for a non-Tab key even with Ctrl held', () => {
    expect(spaceCycle(key('3', 'Digit3', { ctrl: true }))).toBeNull()
  })
})

// Unchanged by this ticket, but exercised here because App.tsx's new listeners
// reuse it as the same gate the digit shortcuts already used (KAN-59).
describe('isTextBox / isTypingTarget', () => {
  it('isTextBox is true only for INPUT, not TEXTAREA (a terminal is a textarea)', () => {
    expect(isTextBox({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true)
    expect(isTextBox({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(false)
  })
  it('isTypingTarget is true for both INPUT and TEXTAREA', () => {
    expect(isTypingTarget({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true)
    expect(isTypingTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true)
  })
})
