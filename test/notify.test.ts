import { describe, it, expect, vi } from 'vitest'
import {
  enteredAwaitingInput, notifyIfEnteredAwaitingInput, chimeAllowed, shouldToast, needsNotifSetup,
} from '../src/renderer/notify'

// KAN-77/79. Every assertion here is on DECISION logic (transition, mute,
// coalescing window, suppression, show-once) — never on whether an
// AudioContext or a Notification was constructed, per CLAUDE.md's testing
// rule for this ticket. `playChime`/`showToast` themselves touch browser
// globals this (node) test environment does not have and are deliberately
// left unexercised here; `chime` is always an injected spy.

describe('enteredAwaitingInput: the one moment either notification may fire', () => {
  it('is true the first time a session reports awaiting-input at all', () => {
    expect(enteredAwaitingInput(undefined, 'awaiting-input')).toBe(true)
  })

  it('is true moving from any other reported state into awaiting-input', () => {
    expect(enteredAwaitingInput('working', 'awaiting-input')).toBe(true)
    expect(enteredAwaitingInput('idle', 'awaiting-input')).toBe(true)
    expect(enteredAwaitingInput('stopped', 'awaiting-input')).toBe(true)
  })

  it('is false while already awaiting-input and staying there', () => {
    expect(enteredAwaitingInput('awaiting-input', 'awaiting-input')).toBe(false)
  })

  it('is false for every transition that is not INTO awaiting-input', () => {
    expect(enteredAwaitingInput('working', 'idle')).toBe(false)
    expect(enteredAwaitingInput('awaiting-input', 'working')).toBe(false)
    expect(enteredAwaitingInput('awaiting-input', 'idle')).toBe(false)
    expect(enteredAwaitingInput(undefined, 'working')).toBe(false)
  })
})

describe('notifyIfEnteredAwaitingInput: KAN-77 chime decision', () => {
  it('invokes the audio path on a fresh entry into awaiting-input, unmuted', () => {
    const chime = vi.fn()
    notifyIfEnteredAwaitingInput('working', 'awaiting-input', false, chime)
    expect(chime).toHaveBeenCalledTimes(1)
  })

  // The muted-by-default rule (KAN-77 acceptance #3): "muted means silent, no
  // sound on any path". Proven on the SAME transition the unmuted case above
  // just proved plays, which is what makes this a real red/green pair rather
  // than two tests that could never both fail.
  it('mute means silent: the identical transition plays no sound when muted', () => {
    const chime = vi.fn()
    notifyIfEnteredAwaitingInput('working', 'awaiting-input', true, chime)
    expect(chime).not.toHaveBeenCalled()
  })

  it('never fires on a transition that is not entering awaiting-input, even unmuted', () => {
    const chime = vi.fn()
    notifyIfEnteredAwaitingInput('working', 'idle', false, chime)
    notifyIfEnteredAwaitingInput('awaiting-input', 'working', false, chime)
    expect(chime).not.toHaveBeenCalled()
  })

  it('never fires repeatedly while a session stays awaiting-input (acceptance #2)', () => {
    const chime = vi.fn()
    notifyIfEnteredAwaitingInput('awaiting-input', 'awaiting-input', false, chime)
    expect(chime).not.toHaveBeenCalled()
  })
})

describe('chimeAllowed: KAN-77 acceptance #4, coalescing', () => {
  it('refuses a second chime within the cooldown window — several sessions blocking at once do not overlap', () => {
    expect(chimeAllowed(1000, 1000, 400)).toBe(false) // simultaneous
    expect(chimeAllowed(1350, 1000, 400)).toBe(false) // 350ms later, still cooling down
  })

  it('allows a chime again once the cooldown has fully elapsed', () => {
    expect(chimeAllowed(1400, 1000, 400)).toBe(true)
    expect(chimeAllowed(5000, 1000, 400)).toBe(true)
  })

  it('uses its own default cooldown when none is passed', () => {
    expect(chimeAllowed(100, 0)).toBe(false) // 100ms, well under any reasonable default
    expect(chimeAllowed(10_000, 0)).toBe(true)
  })
})

describe('shouldToast: KAN-79 suppression rules, as pure logic', () => {
  it('never toasts when desktop notifications are off — declining means no toast on any path (acceptance #3)', () => {
    expect(shouldToast({ notifyDesktop: false, appFocused: false, tabVisible: false })).toBe(false)
    expect(shouldToast({ notifyDesktop: false, appFocused: true, tabVisible: true })).toBe(false)
  })

  it('suppresses when the app is focused AND the blocked tab is already visible', () => {
    expect(shouldToast({ notifyDesktop: true, appFocused: true, tabVisible: true })).toBe(false)
  })

  it('toasts when focused but looking at a different tab', () => {
    expect(shouldToast({ notifyDesktop: true, appFocused: true, tabVisible: false })).toBe(true)
  })

  it('toasts when not focused, even if that tab happens to already be on screen', () => {
    expect(shouldToast({ notifyDesktop: true, appFocused: false, tabVisible: true })).toBe(true)
  })

  it('toasts when neither focused nor visible', () => {
    expect(shouldToast({ notifyDesktop: true, appFocused: false, tabVisible: false })).toBe(true)
  })
})

describe('needsNotifSetup: KAN-79 show-once rule', () => {
  it('shows the card when the key is absent — an upgrading user\'s settings.json included', () => {
    expect(needsNotifSetup({})).toBe(true)
    expect(needsNotifSetup({ notifSetupSeen: undefined })).toBe(true)
  })

  it('never shows again once the key is set', () => {
    expect(needsNotifSetup({ notifSetupSeen: true })).toBe(false)
  })
})
