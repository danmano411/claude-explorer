import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SPACE_KEYBINDS, findSpaceBindingConflict, isTextBox, isTypingTarget, knownAppShortcut,
  pinnedSpaceIndex, resolveSpaceKeybinds, spaceCycle, spaceIndex, type SpaceKeybinds,
} from '../src/renderer/keys'

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

// KAN-83. `spaceIndex`/`pinnedSpaceIndex`/`spaceCycle` used to hardcode their
// chord; these prove the parameter actually REPLACES it rather than merely
// widening the match — the surest way a half-done rebind ships is the new
// chord working while the old one keeps firing too.
describe('KAN-83: customizable Mods/KeyBinding parameters', () => {
  it('spaceIndex matches a rebound Mods and no longer matches the default Ctrl chord', () => {
    const rebound = { alt: true }
    expect(spaceIndex(key('3', 'Digit3', { alt: true }), rebound)).toBe(2)
    expect(spaceIndex(key('3', 'Digit3', { ctrl: true }), rebound)).toBeNull()
  })

  it('pinnedSpaceIndex matches a rebound Mods and no longer matches the default Ctrl+Shift chord', () => {
    const rebound = { alt: true, shift: true }
    expect(pinnedSpaceIndex(key('#', 'Digit3', { alt: true, shift: true }), rebound)).toBe(2)
    expect(pinnedSpaceIndex(key('#', 'Digit3', { ctrl: true, shift: true }), rebound)).toBeNull()
  })

  it('spaceCycle matches a rebound key entirely off Tab, independently for next/prev', () => {
    const next = { mods: { ctrl: true }, key: ']' }
    const prev = { mods: { ctrl: true }, key: '[' }
    expect(spaceCycle(key(']', 'BracketRight', { ctrl: true }), next, prev)).toBe(1)
    expect(spaceCycle(key('[', 'BracketLeft', { ctrl: true }), next, prev)).toBe(-1)
    // The old Tab chord is dead once rebound — a half-fix would leave it live.
    expect(spaceCycle(key('Tab', 'Tab', { ctrl: true }), next, prev)).toBeNull()
    expect(spaceCycle(key('Tab', 'Tab', { ctrl: true, shift: true }), next, prev)).toBeNull()
  })

  it('every function still falls back to the historical default with no argument', () => {
    expect(spaceIndex(key('3', 'Digit3', { ctrl: true }))).toBe(2)
    expect(pinnedSpaceIndex(key('#', 'Digit3', { ctrl: true, shift: true }))).toBe(2)
    expect(spaceCycle(key('Tab', 'Tab', { ctrl: true }))).toBe(1)
    expect(spaceCycle(key('Tab', 'Tab', { ctrl: true, shift: true }))).toBe(-1)
  })
})

describe('resolveSpaceKeybinds', () => {
  it('with nothing stored, is exactly DEFAULT_SPACE_KEYBINDS', () => {
    expect(resolveSpaceKeybinds(undefined)).toEqual(DEFAULT_SPACE_KEYBINDS)
  })

  it('fills in only the missing fields — rebinding one action need not restate the other three', () => {
    const resolved = resolveSpaceKeybinds({ switchUnpinned: { alt: true } })
    expect(resolved.switchUnpinned).toEqual({ alt: true })
    expect(resolved.switchPinned).toEqual(DEFAULT_SPACE_KEYBINDS.switchPinned)
    expect(resolved.cycleNext).toEqual(DEFAULT_SPACE_KEYBINDS.cycleNext)
    expect(resolved.cyclePrev).toEqual(DEFAULT_SPACE_KEYBINDS.cyclePrev)
  })
})

describe('findSpaceBindingConflict (KAN-83 acceptance #5: refuse a duplicate)', () => {
  it('refuses switchPinned rebinding onto switchUnpinned\'s current mods', () => {
    const current: SpaceKeybinds = { ...DEFAULT_SPACE_KEYBINDS, switchUnpinned: { alt: true } }
    expect(findSpaceBindingConflict('switchPinned', { alt: true }, current)).toBe('switchUnpinned')
  })

  it('does not refuse a binding that differs from every other action', () => {
    expect(findSpaceBindingConflict('switchPinned', { alt: true }, DEFAULT_SPACE_KEYBINDS)).toBeNull()
  })

  it('refuses cyclePrev rebinding onto cycleNext\'s current mods+key', () => {
    expect(
      findSpaceBindingConflict('cyclePrev', { mods: { ctrl: true }, key: 'Tab' }, DEFAULT_SPACE_KEYBINDS),
    ).toBe('cycleNext')
  })

  it('does not refuse two cycle actions that share mods but differ by key', () => {
    const current: SpaceKeybinds = { ...DEFAULT_SPACE_KEYBINDS, cyclePrev: { mods: { ctrl: true }, key: '[' } }
    expect(findSpaceBindingConflict('cycleNext', { mods: { ctrl: true }, key: ']' }, current)).toBeNull()
  })

  it('refuses a cycle action pointed at a digit that a switch action already claims with the same mods', () => {
    // The edge case a fully-generic cycle rebind opens up: cycleNext has no
    // fixed key, so nothing stops a user aiming it at '3' — which, with the
    // same mods as switchUnpinned, is indistinguishable from Ctrl+3 at
    // keypress time even though the two are stored in completely different
    // shapes (Mods vs KeyBinding).
    expect(
      findSpaceBindingConflict('cycleNext', { mods: { ctrl: true }, key: '3' }, DEFAULT_SPACE_KEYBINDS),
    ).toBe('switchUnpinned')
  })

  it('a cycle action on a LETTER key never conflicts with a switch action, digit or not', () => {
    expect(
      findSpaceBindingConflict('cycleNext', { mods: { ctrl: true }, key: 'g' }, DEFAULT_SPACE_KEYBINDS),
    ).toBeNull()
  })
})

describe('knownAppShortcut (KAN-83 acceptance: warn, do not block)', () => {
  it('names Ctrl+Shift+G as the grid picker', () => {
    expect(knownAppShortcut({ mods: { ctrl: true, shift: true }, key: 'g' })).toMatch(/grid picker/)
  })
  it('names Ctrl+F as Search, case-insensitively', () => {
    expect(knownAppShortcut({ mods: { ctrl: true }, key: 'F' })).toMatch(/Search/)
  })
  it('is null for a chord that collides with nothing the app already owns', () => {
    expect(knownAppShortcut({ mods: { ctrl: true, alt: true }, key: 'q' })).toBeNull()
  })
})
