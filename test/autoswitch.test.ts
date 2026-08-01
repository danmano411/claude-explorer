import { describe, it, expect } from 'vitest'
import { shouldAutoSwitch, isTypingActive, TYPING_SUPPRESS_MS } from '../src/renderer/autoswitch'
import type { ClaudeState } from '../src/shared/types'

/**
 * KAN-80. `autoswitch.ts` is brand new — there is no equivalent on `main` at
 * all, so the honest "red on main" here is that the module does not exist
 * there; importing it fails to resolve. This file has never run — no
 * node_modules in this worktree (see the task brief) — so every assertion
 * below is UNVERIFIED, reported as such rather than claimed as a pass.
 *
 * Per CLAUDE.md's testing rule and the ticket itself ("the suppression rules
 * ARE the ticket"): the negative cases below are what actually earn their
 * place. A single "it switches in the happy path" test is the easy half and
 * proves nothing about the three rules that make this safe to ship at all.
 */

const on = { autoSwitchOnInput: true }
const off = { autoSwitchOnInput: false }
const notTyping = (activeState: ClaudeState | undefined = undefined) => ({ typingActive: false, activeState })

describe('shouldAutoSwitch: the happy path (proves the negatives below are real, not vacuous)', () => {
  it('switches on a fresh entry into awaiting-input when nothing suppresses it', () => {
    expect(shouldAutoSwitch({ prev: 'working', next: 'awaiting-input' }, on, notTyping())).toBe(true)
  })

  it('also switches on a session\'s very first ever report of awaiting-input', () => {
    expect(shouldAutoSwitch({ prev: undefined, next: 'awaiting-input' }, on, notTyping())).toBe(true)
  })
})

describe('shouldAutoSwitch: acceptance #1 — default off, never switches when the setting is off', () => {
  it('refuses the identical transition that switches above, purely because the setting is off', () => {
    expect(shouldAutoSwitch({ prev: 'working', next: 'awaiting-input' }, off, notTyping())).toBe(false)
  })

  it('refuses even when every other condition is maximally favourable', () => {
    // No typing, nothing blocked on screen, a fresh entry — the ONLY thing
    // standing between this and a switch is the setting, and it still holds.
    expect(shouldAutoSwitch({ prev: undefined, next: 'awaiting-input' }, off, { typingActive: false, activeState: 'idle' })).toBe(false)
  })
})

describe('shouldAutoSwitch: suppression #1 — never switches while the user is typing', () => {
  it('refuses a fresh entry into awaiting-input while a text box or terminal is actively being typed into', () => {
    expect(
      shouldAutoSwitch({ prev: 'working', next: 'awaiting-input' }, on, { typingActive: true, activeState: undefined }),
    ).toBe(false)
  })

  it('switches the instant typing is no longer active, same transition otherwise', () => {
    expect(
      shouldAutoSwitch({ prev: 'working', next: 'awaiting-input' }, on, { typingActive: false, activeState: undefined }),
    ).toBe(true)
  })
})

describe('shouldAutoSwitch: suppression #2 — never switches repeatedly (at most once, prefer the first)', () => {
  it('does not switch a second time while the first switch\'s destination is still the one on screen and still blocked', () => {
    // Session A enters awaiting-input; nothing is blocking the current view,
    // so the switch happens.
    const toA = shouldAutoSwitch({ prev: 'working', next: 'awaiting-input' }, on, notTyping(undefined))
    expect(toA).toBe(true)
    // The caller lands on A. A moment later session B ALSO enters
    // awaiting-input — but the view is now A, and A is STILL awaiting-input
    // (the user hasn't answered it), which is exactly the state
    // `effectiveActiveState` carries into this second call. Several sessions
    // blocking "in sequence" must produce exactly one switch, not a slideshow.
    const toB = shouldAutoSwitch({ prev: 'working', next: 'awaiting-input' }, on, notTyping('awaiting-input'))
    expect(toB).toBe(false)
  })

  it('is free to switch again once the user has actually left the first blocked tab (its state is no longer awaiting-input)', () => {
    // Not a permanent lock — once A is answered (or the user navigates off it
    // on their own) a NEW blocked session is once again a legitimate switch.
    expect(
      shouldAutoSwitch({ prev: 'working', next: 'awaiting-input' }, on, notTyping('idle')),
    ).toBe(true)
  })
})

describe('shouldAutoSwitch: suppression #3 — never switches away from a session that is itself blocked', () => {
  it('refuses even a fresh, otherwise-eligible entry when the visible tab is awaiting-input', () => {
    expect(
      shouldAutoSwitch({ prev: 'working', next: 'awaiting-input' }, on, { typingActive: false, activeState: 'awaiting-input' }),
    ).toBe(false)
  })

  it('does not confuse "blocked" with any other state — working/idle/stopped on screen still allow a switch', () => {
    for (const activeState of ['working', 'idle', 'stopped', undefined] as const) {
      expect(
        shouldAutoSwitch({ prev: 'working', next: 'awaiting-input' }, on, { typingActive: false, activeState }),
      ).toBe(true)
    }
  })
})

describe('shouldAutoSwitch: never fires on a transition that is not ENTERING awaiting-input', () => {
  it('refuses staying awaiting-input, leaving it, or any other transition, even with nothing else suppressing it', () => {
    expect(shouldAutoSwitch({ prev: 'awaiting-input', next: 'awaiting-input' }, on, notTyping())).toBe(false)
    expect(shouldAutoSwitch({ prev: 'awaiting-input', next: 'working' }, on, notTyping())).toBe(false)
    expect(shouldAutoSwitch({ prev: 'working', next: 'idle' }, on, notTyping())).toBe(false)
    expect(shouldAutoSwitch({ prev: undefined, next: 'working' }, on, notTyping())).toBe(false)
  })
})

describe('isTypingActive: the recency window behind suppression #1', () => {
  it('is false when not on a typing surface at all, no matter how recent the keystroke', () => {
    expect(isTypingActive(false, 1000, 1000)).toBe(false)
  })

  it('is true immediately after a keystroke on a typing surface', () => {
    expect(isTypingActive(true, 1000, 1000)).toBe(true)
  })

  it('stays true within the suppression window', () => {
    expect(isTypingActive(true, 1000, 1000 + TYPING_SUPPRESS_MS - 1)).toBe(true)
  })

  it('goes false once the window has fully elapsed — focus alone does not suppress forever', () => {
    expect(isTypingActive(true, 1000, 1000 + TYPING_SUPPRESS_MS)).toBe(false)
    expect(isTypingActive(true, 1000, 1_000_000)).toBe(false)
  })

  it('honours a custom window when one is passed', () => {
    expect(isTypingActive(true, 1000, 1400, 500)).toBe(true)
    expect(isTypingActive(true, 1000, 1600, 500)).toBe(false)
  })
})
