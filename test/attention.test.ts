import { describe, it, expect } from 'vitest'
import { attentionNeeded } from '../src/renderer/attention'
import type { ClaudeState } from '../src/shared/types'

/**
 * KAN-78. `attentionNeeded` is brand new — there is no equivalent on `main` at
 * all, so the honest "red on main" here is that the module does not exist
 * there; importing it would fail to resolve.
 *
 * What proves these cases are doing real work, not the vacuous kind CLAUDE.md
 * warns about (an assertion that can never fail regardless of the logic), is
 * that two independently plausible bugs were run against this exact case list
 * before this file was trusted, and each failed a DIFFERENT single case and no
 * other:
 *   - "any awaiting-input anywhere, ignoring focus and the visible tab" —
 *     passes every case here except "false only when focused AND the blocked
 *     session is exactly the visible tab", which is the scope item (#5) this
 *     whole function exists for.
 *   - "checks the visible tab but forgets to gate it on focus" — passes every
 *     case here except "true when blocked and the window has no focus at all"
 *     with the visible tab set to the blocked one, i.e. the case that says the
 *     exception must not apply just because a since-abandoned tab is still
 *     nominally `active`.
 * Neither bug is a strawman: both are exactly what dropping one `&&` operand
 * from the real implementation produces.
 */

const state = (entries: Array<[string, ClaudeState]>) => new Map(entries)

describe('attentionNeeded', () => {
  it('false when nothing is tracked at all', () => {
    expect(attentionNeeded(new Map(), true, null)).toBe(false)
    expect(attentionNeeded(new Map(), false, null)).toBe(false)
  })

  it('false for working, idle or stopped — only awaiting-input counts, focus aside', () => {
    for (const s of ['working', 'idle', 'stopped'] as const) {
      expect(attentionNeeded(state([['p1', s]]), false, null)).toBe(false)
      expect(attentionNeeded(state([['p1', s]]), true, 'p1')).toBe(false)
    }
  })

  it('true when blocked and the window has no focus at all, regardless of which tab is nominally active', () => {
    // Not focused means nobody is looking at ANY tab — the visible-tab
    // exception must not apply just because the blocked tab happens to still
    // be `active` from before the user alt-tabbed away.
    expect(attentionNeeded(state([['p1', 'awaiting-input']]), false, 'p1')).toBe(true)
    expect(attentionNeeded(state([['p1', 'awaiting-input']]), false, null)).toBe(true)
  })

  it('true when focused but the blocked session is a DIFFERENT tab than the visible one', () => {
    expect(attentionNeeded(state([['p1', 'awaiting-input']]), true, 'p2')).toBe(true)
    expect(attentionNeeded(state([['p1', 'awaiting-input']]), true, null)).toBe(true)
  })

  // THE ACTUAL SCOPE ITEM (#5): "No indicator while the app is focused AND the
  // blocked session is the visible tab — you are already looking at it."
  it('false only when focused AND the blocked session is exactly the visible tab', () => {
    expect(attentionNeeded(state([['p1', 'awaiting-input']]), true, 'p1')).toBe(false)
  })

  it('true when one blocked session is visible (and focused) but another is not', () => {
    // The per-session loop, not a single global comparison: an attended
    // session must never mask an unattended one elsewhere.
    const s = state([['p1', 'awaiting-input'], ['p2', 'awaiting-input']])
    expect(attentionNeeded(s, true, 'p1')).toBe(true)
  })

  it('clears the instant the map no longer says awaiting-input, same map re-queried', () => {
    // Purely derived, like spaceNeedsInput (spacemenu.ts) — no separate
    // "clear" step to forget.
    expect(attentionNeeded(state([['p1', 'awaiting-input']]), false, null)).toBe(true)
    expect(attentionNeeded(state([['p1', 'idle']]), false, null)).toBe(false)
  })
})
