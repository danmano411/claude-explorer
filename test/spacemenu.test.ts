import { describe, it, expect } from 'vitest'
import { acceleratorLabel, canDeleteSpace, nextFocusIndex, spaceNeedsInput } from '../src/renderer/spacemenu'
import type { ClaudeState } from '../src/shared/types'

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

// KAN-76. The trap the ticket itself names: "asserting a CSS class exists
// somewhere in the tree proves nothing about whether the RIGHT space got
// marked." These assert on the DERIVATION directly — the exact membership
// list `spaceNeedsInput` is handed for one space, never the whole workspace —
// which is the only way to catch a version that (say) forgets to filter by
// `spaceId` and marks every space, or every space, whenever ANY session
// anywhere is blocked.
describe('spaceNeedsInput', () => {
  const state = (entries: Array<[string, ClaudeState]>) => new Map(entries)

  it('true when a member Claude tab is awaiting-input', () => {
    const members = [{ terminalKind: 'claude' as const, ptyId: 'p1' }]
    expect(spaceNeedsInput(members, state([['p1', 'awaiting-input']]))).toBe(true)
  })

  it('false for working, idle or stopped — only awaiting-input counts', () => {
    const members = [{ terminalKind: 'claude' as const, ptyId: 'p1' }]
    for (const s of ['working', 'idle', 'stopped'] as const) {
      expect(spaceNeedsInput(members, state([['p1', s]]))).toBe(false)
    }
  })

  it('false when the pty has no reported state at all (unknown, not blocked)', () => {
    const members = [{ terminalKind: 'claude' as const, ptyId: 'p1' }]
    expect(spaceNeedsInput(members, new Map())).toBe(false)
  })

  it('false for a restored tab with no ptyId yet, even if some OTHER pty in the map is blocked', () => {
    // Guards against `.get(undefined)` accidentally matching a real entry —
    // it must not, but the point of a positive fixture here is to prove the
    // false case isn't false only because the map is empty.
    const members = [{ terminalKind: 'claude' as const, ptyId: undefined }]
    expect(spaceNeedsInput(members, state([['p1', 'awaiting-input']]))).toBe(false)
  })

  it('false for a shell tab, even one that happens to share a ptyId key with a blocked entry', () => {
    const members = [{ terminalKind: 'shell' as const, ptyId: 'p1' }]
    expect(spaceNeedsInput(members, state([['p1', 'awaiting-input']]))).toBe(false)
  })

  it('true once at least one of several members is blocked — marked once, not counted', () => {
    const members = [
      { terminalKind: 'claude' as const, ptyId: 'p1' },
      { terminalKind: 'claude' as const, ptyId: 'p2' },
      { terminalKind: 'claude' as const, ptyId: 'p3' },
    ]
    // Two blocked, not one — the derivation is a boolean, and the caller must
    // never have to fold a count back into "is this space marked at all".
    expect(spaceNeedsInput(members, state([['p2', 'awaiting-input'], ['p3', 'awaiting-input']]))).toBe(true)
  })

  // THE ACTUAL REPORTED SCENARIO (KAN-76's own testing note): several spaces
  // exist, only ONE has a blocked tab, and the caller must be able to tell
  // them apart — a version that closed over the wrong space's tab id, or
  // ignored `spaceId` and scanned every pty in the map, would pass every
  // single-space test above and still mark the wrong row.
  it('distinguishes between spaces sharing the same claudeState map', () => {
    const spaceA = [{ terminalKind: 'claude' as const, ptyId: 'a1' }]
    const spaceB = [{ terminalKind: 'claude' as const, ptyId: 'b1' }]
    const spaceC = [{ terminalKind: 'claude' as const, ptyId: 'c1' }]
    const shared = state([['b1', 'awaiting-input']])
    expect(spaceNeedsInput(spaceA, shared)).toBe(false)
    expect(spaceNeedsInput(spaceB, shared)).toBe(true)
    expect(spaceNeedsInput(spaceC, shared)).toBe(false)
  })

  // "Markers clear when the session leaves the blocked state" — since this is
  // purely derived (never stored), the SAME map, re-queried after the one
  // entry changes, must flip straight back to false. No separate "clear" path
  // to forget.
  it('clears the instant the map no longer says awaiting-input, with no separate clear step', () => {
    const members = [{ terminalKind: 'claude' as const, ptyId: 'p1' }]
    expect(spaceNeedsInput(members, state([['p1', 'awaiting-input']]))).toBe(true)
    expect(spaceNeedsInput(members, state([['p1', 'working']]))).toBe(false)
  })
})
