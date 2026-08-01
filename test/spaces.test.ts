import { describe, it, expect } from 'vitest'
import type { Space } from '../src/shared/types'
import {
  addTabToSpace,
  createSpace,
  deleteSpace,
  orderSpaces,
  removeTabFromSpace,
  renameSpace,
  reorderInSpace,
  setActiveTab,
  setSpaceColor,
  setSpacePinned,
  switchSpace,
} from '../src/renderer/spaces'

/**
 * The real persisted type. KAN-43 has landed `activeTabId?: string` on `Space`
 * itself, so this is now a plain alias — kept only so the sweep's local helpers
 * stay readable. The module is still written over a structural type (`Spaced`),
 * which is why `Space` drops straight in.
 *
 * Document repair (dedupe, orphan adoption, space-id collapse, dangling
 * `activeSpaceId`) is NOT tested here: it lives in `sanitize()`, and its tests
 * live with it in test/workspace.test.ts.
 */
type S = Space

const space = (id: string, tabIds: string[] = [], activeTabId?: string): S => ({
  id,
  name: id,
  tabIds,
  layout: null,
  ...(activeTabId === undefined ? {} : { activeTabId }),
})

/** KAN-57. */
const pinnedSpace = (id: string, tabIds: string[] = []): S => ({ ...space(id, tabIds), pinned: true })

/** THE invariant: every known tab is owned by exactly one space — never zero
 *  (unreachable live session), never two (ambiguous PTY ownership). */
function ownedExactlyOnce(spaces: readonly S[], knownTabIds: readonly string[]): boolean {
  const counts = new Map<string, number>()
  for (const s of spaces) for (const id of s.tabIds) counts.set(id, (counts.get(id) ?? 0) + 1)
  if (counts.size !== new Set(knownTabIds).size) return false
  for (const id of knownTabIds) if (counts.get(id) !== 1) return false
  return true
}

/** No space remembers an active tab it does not own. */
function activeTabsAreMembers(spaces: readonly S[]): boolean {
  return spaces.every((s) => s.activeTabId === undefined || s.tabIds.includes(s.activeTabId))
}

describe('createSpace', () => {
  it('appends a new empty space and hands back its id', () => {
    const before = [space('a', ['t1'])]
    const { spaces, id } = createSpace(before, 'Research')
    expect(spaces).toHaveLength(2)
    expect(spaces[0]).toBe(before[0])
    expect(spaces[1].id).toBe(id)
    expect(spaces[1].name).toBe('Research')
    expect(spaces[1].tabIds).toEqual([])
    expect(spaces[1].activeTabId).toBeUndefined()
  })
  it('creates a complete Space at runtime, layout included', () => {
    const { spaces } = createSpace<S>([], 'First')
    expect(spaces[0].layout).toBeNull()
  })
  it('gives two spaces created back to back different ids', () => {
    const first = createSpace<S>([], 'A')
    const second = createSpace(first.spaces, 'B')
    expect(second.id).not.toBe(first.id)
  })
  it('does not mutate its input', () => {
    const before = [space('a')]
    createSpace(before, 'B')
    expect(before).toHaveLength(1)
  })
})

describe('renameSpace', () => {
  it('renames only the matching space', () => {
    const spaces = [space('a'), space('b')]
    const result = renameSpace(spaces, 'a', 'Renamed')
    expect(result[0].name).toBe('Renamed')
    expect(result[1]).toBe(spaces[1])
  })
  it('is a no-op (same reference) for an unknown spaceId', () => {
    const spaces = [space('a')]
    expect(renameSpace(spaces, 'nope', 'x')).toBe(spaces)
  })
  it('keeps membership and the remembered active tab', () => {
    const spaces = [space('a', ['t1', 't2'], 't2')]
    const result = renameSpace(spaces, 'a', 'New')
    expect(result[0].tabIds).toEqual(['t1', 't2'])
    expect(result[0].activeTabId).toBe('t2')
  })
})

describe('deleteSpace', () => {
  it('refuses to delete the last remaining space', () => {
    const spaces = [space('only', ['t1'])]
    const result = deleteSpace(spaces, 'only', 'only')
    expect(result).toEqual({ ok: false, reason: 'LAST_SPACE' })
  })
  it('refuses an unknown spaceId, and says so rather than blaming the last space', () => {
    const spaces = [space('only')]
    expect(deleteSpace(spaces, 'only', 'ghost')).toEqual({ ok: false, reason: 'NO_SUCH_SPACE' })
  })
  it('returns the tab ids the deleted space owned so the caller can kill their PTYs', () => {
    const spaces = [space('a', ['t1', 't2']), space('b', ['t3'])]
    const result = deleteSpace(spaces, 'a', 'a')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.closedTabIds).toEqual(['t1', 't2'])
    expect(result.spaces.map((s) => s.id)).toEqual(['b'])
  })
  it('moves the active space to the one that took the deleted slot', () => {
    const spaces = [space('a'), space('b'), space('c')]
    const result = deleteSpace(spaces, 'b', 'b')
    expect(result.ok && result.activeSpaceId).toBe('c')
  })
  it('falls back to the previous space when the LAST space was the active one', () => {
    const spaces = [space('a'), space('b')]
    const result = deleteSpace(spaces, 'b', 'b')
    expect(result.ok && result.activeSpaceId).toBe('a')
  })
  it('leaves the active space alone when deleting a different one', () => {
    const spaces = [space('a'), space('b'), space('c')]
    const result = deleteSpace(spaces, 'c', 'a')
    expect(result.ok && result.activeSpaceId).toBe('c')
  })
  // Passing a stale id straight back out would hand the caller a dangling
  // activeSpaceId it had no way to notice — the switcher would then render
  // nothing and every subsequent op would miss its findIndex.
  it('never returns an activeSpaceId that names nothing, even when handed one', () => {
    const spaces = [space('a'), space('b')]
    const result = deleteSpace(spaces, 'GARBAGE', 'b')
    expect(result.ok && result.activeSpaceId).toBe('a')
    expect(result.ok && result.spaces.some((s) => s.id === result.activeSpaceId)).toBe(true)
  })
  it('does not mutate its input', () => {
    const spaces = [space('a', ['t1']), space('b')]
    const snapshot = structuredClone(spaces)
    deleteSpace(spaces, 'a', 'a')
    expect(spaces).toEqual(snapshot)
  })

  // KAN-57: deleting a space with a live Claude session or shell in it is
  // recoverable UI-side (a confirm), but the refusal for a PINNED space has to
  // hold even if a caller skips the menu entirely — so it lives here, in the
  // data layer, not only behind a disabled button.
  describe('PINNED (KAN-57)', () => {
    it('refuses to delete a pinned space among others', () => {
      const spaces = [space('a', ['t1']), pinnedSpace('b', ['t2']), space('c', ['t3'])]
      expect(deleteSpace(spaces, 'a', 'b')).toEqual({ ok: false, reason: 'PINNED' })
    })
    it('hands out no closedTabIds for a refused pinned space — nothing licenses a PTY kill', () => {
      const spaces = [space('a', ['t1']), pinnedSpace('b', ['t2'])]
      const r = deleteSpace(spaces, 'a', 'b')
      expect(r.ok).toBe(false)
      expect('closedTabIds' in r).toBe(false)
    })
    it('reports the unknown-id refusal before ever looking at pinned', () => {
      const spaces = [pinnedSpace('a', ['t1'])]
      expect(deleteSpace(spaces, 'a', 'ghost')).toEqual({ ok: false, reason: 'NO_SUCH_SPACE' })
    })
    // The user's explicit "keep this" beats the structural floor: a pinned
    // lone space should say the thing the user can actually undo.
    it('reports PINNED, not LAST_SPACE, for a pinned lone space', () => {
      const spaces = [pinnedSpace('only', ['t1'])]
      expect(deleteSpace(spaces, 'only', 'only')).toEqual({ ok: false, reason: 'PINNED' })
    })
    it('still deletes an unpinned space normally', () => {
      const spaces = [space('a', ['t1']), pinnedSpace('b', ['t2']), space('c', ['t3'])]
      const r = deleteSpace(spaces, 'a', 'c')
      expect(r.ok).toBe(true)
      expect(r.ok && r.closedTabIds).toEqual(['t3'])
    })
  })
})

describe('setSpacePinned', () => {
  it('sets the field', () => {
    const result = setSpacePinned([space('a')], 'a', true)
    expect(result[0].pinned).toBe(true)
  })
  it('is a no-op (same reference) for an unknown spaceId', () => {
    const spaces = [space('a')]
    expect(setSpacePinned(spaces, 'ghost', true)).toBe(spaces)
  })
  it('is a no-op (same reference) when the state already holds', () => {
    const pinned = setSpacePinned([space('a')], 'a', true)
    expect(setSpacePinned(pinned, 'a', true)).toBe(pinned)
    const unpinned = [space('a')]
    expect(setSpacePinned(unpinned, 'a', false)).toBe(unpinned)
  })
  // The stripActiveTab precedent: unpinning deletes the key rather than
  // writing `false`, so a never-pinned space and an unpinned one persist
  // identically and neither writes a field a pre-KAN-57 reader would choke on.
  it('unpinning deletes the key rather than writing false', () => {
    const pinned = setSpacePinned([space('a')], 'a', true)
    const un = setSpacePinned(pinned, 'a', false)
    expect('pinned' in un[0]).toBe(false)
  })
  it('touches only the named space', () => {
    const spaces = [space('a'), space('b')]
    const result = setSpacePinned(spaces, 'a', true)
    expect(result[1]).toBe(spaces[1])
  })
})

describe('setSpaceColor', () => {
  it('sets a preset (a plain var() string)', () => {
    const result = setSpaceColor([space('a')], 'a', 'var(--clay)')
    expect(result[0].color).toBe('var(--clay)')
  })
  it('sets a custom light/dark pair', () => {
    const result = setSpaceColor([space('a')], 'a', { light: '#C15F3Cff', dark: '#D2795Aff' })
    expect(result[0].color).toEqual({ light: '#C15F3Cff', dark: '#D2795Aff' })
  })
  it('is a no-op (same reference) for an unknown spaceId', () => {
    const spaces = [space('a')]
    expect(setSpaceColor(spaces, 'ghost', 'var(--clay)')).toBe(spaces)
  })
  // Same delete-the-key convention as unpinning: an uncolored space and one
  // whose color was cleared must persist identically.
  it('clearing (undefined) deletes the key rather than writing it', () => {
    const colored = setSpaceColor([space('a')], 'a', 'var(--clay)')
    const cleared = setSpaceColor(colored, 'a', undefined)
    expect('color' in cleared[0]).toBe(false)
  })
  it('touches only the named space', () => {
    const spaces = [space('a'), space('b')]
    const result = setSpaceColor(spaces, 'a', 'var(--clay)')
    expect(result[1]).toBe(spaces[1])
  })
})

// KAN-81. The Jira ticket calls out the trap directly: "pinned sorts first"
// is trivially true when the lone pinned space is already at index 0, so
// every arrangement below interleaves pinned and unpinned so the sorted and
// unsorted orders genuinely differ.
describe('orderSpaces', () => {
  it('partitions pinned before unpinned, preserving relative order WITHIN each run', () => {
    // a, c unpinned; b, d pinned — interleaved, so a naive re-sort or a
    // reversal would both look plausible if this assertion used a simpler
    // input. The correct answer keeps b before d (their relative order among
    // themselves) and a before c, with the whole pinned run leading.
    const spaces = [space('a'), pinnedSpace('b'), space('c'), pinnedSpace('d')]
    expect(orderSpaces(spaces).map((s) => s.id)).toEqual(['b', 'd', 'a', 'c'])
  })
  it('is a no-op ordering when nothing is pinned', () => {
    const spaces = [space('a'), space('b'), space('c')]
    expect(orderSpaces(spaces).map((s) => s.id)).toEqual(['a', 'b', 'c'])
  })
  it('is a no-op ordering when everything is pinned', () => {
    const spaces = [pinnedSpace('a'), pinnedSpace('b'), pinnedSpace('c')]
    expect(orderSpaces(spaces).map((s) => s.id)).toEqual(['a', 'b', 'c'])
  })
  it('handles a single pinned space at the END of the list — the case index-0 would miss', () => {
    const spaces = [space('a'), space('b'), pinnedSpace('c')]
    expect(orderSpaces(spaces).map((s) => s.id)).toEqual(['c', 'a', 'b'])
  })
  it('does not mutate its input', () => {
    const spaces = [space('a'), pinnedSpace('b'), space('c')]
    const snapshot = structuredClone(spaces)
    orderSpaces(spaces)
    expect(spaces).toEqual(snapshot)
  })
})

describe('switchSpace', () => {
  it('returns the target id, its membership and its remembered active tab', () => {
    const spaces = [space('a', ['t1']), space('b', ['t2', 't3'], 't3')]
    expect(switchSpace(spaces, 'a', 'b')).toEqual({
      activeSpaceId: 'b',
      tabIds: ['t2', 't3'],
      activeTabId: 't3',
    })
  })
  it('reports no remembered active tab as undefined, not as a guess', () => {
    const spaces = [space('a', ['t1']), space('b', ['t2', 't3'])]
    expect(switchSpace(spaces, 'a', 'b').activeTabId).toBeUndefined()
  })
  it('mutates nothing — the space being left keeps its state for the return trip', () => {
    const spaces = [space('a', ['t1'], 't1'), space('b', ['t2'], 't2')]
    const snapshot = structuredClone(spaces)
    switchSpace(spaces, 'a', 'b')
    expect(spaces).toEqual(snapshot)
  })
  it('copies tabIds so the caller cannot mutate the space through the result', () => {
    const spaces = [space('a', ['t1'])]
    const result = switchSpace(spaces, 'a', 'a')
    result.tabIds.push('t99')
    expect(spaces[0].tabIds).toEqual(['t1'])
  })
  it('keeps you where you are for an unknown target', () => {
    const spaces = [space('a', ['t1']), space('b', ['t2'])]
    expect(switchSpace(spaces, 'b', 'ghost')).toEqual({
      activeSpaceId: 'b',
      tabIds: ['t2'],
      activeTabId: undefined,
    })
  })
  it('falls back to the first space when neither target nor active id resolves', () => {
    const spaces = [space('a', ['t1'])]
    expect(switchSpace(spaces, 'ghost', 'alsoghost').activeSpaceId).toBe('a')
  })
  it('is total on an empty list instead of throwing', () => {
    expect(() => switchSpace([], 'a', 'b')).not.toThrow()
    expect(switchSpace([], 'a', 'b')).toEqual({ activeSpaceId: 'a', tabIds: [] })
  })
})

describe('setActiveTab', () => {
  it('records the per-space active tab', () => {
    const spaces = [space('a', ['t1', 't2'])]
    expect(setActiveTab(spaces, 'a', 't2')[0].activeTabId).toBe('t2')
  })
  it('refuses a tab that is not in that space', () => {
    const spaces = [space('a', ['t1'], 't1'), space('b', ['t2'])]
    expect(setActiveTab(spaces, 'a', 't2')).toBe(spaces)
    expect(setActiveTab(spaces, 'a', 'nosuchtab')).toBe(spaces)
  })
  it('is a no-op for an unknown spaceId', () => {
    const spaces = [space('a', ['t1'])]
    expect(setActiveTab(spaces, 'nope', 't1')).toBe(spaces)
  })
  it('is a no-op (same reference) when the tab is already active', () => {
    const spaces = [space('a', ['t1', 't2'], 't2')]
    expect(setActiveTab(spaces, 'a', 't2')).toBe(spaces)
  })
  it('touches only the named space', () => {
    const spaces = [space('a', ['t1']), space('b', ['t2'], 't2')]
    const result = setActiveTab(spaces, 'a', 't1')
    expect(result[1]).toBe(spaces[1])
  })
})

describe('addTabToSpace', () => {
  it('appends the tab to the space', () => {
    const spaces = [space('a', ['t1'], 't1')]
    const result = addTabToSpace(spaces, 'a', 't2')
    expect(result[0].tabIds).toEqual(['t1', 't2'])
  })
  it('makes the first tab of an empty space active', () => {
    const result = addTabToSpace([space('a')], 'a', 't1')
    expect(result[0].activeTabId).toBe('t1')
  })
  it('does not steal focus from a space that already has an active tab', () => {
    const result = addTabToSpace([space('a', ['t1'], 't1')], 'a', 't2')
    expect(result[0].activeTabId).toBe('t1')
  })
  it('evicts the tab from every other space — exactly one owner, always', () => {
    const spaces = [space('a', ['t1', 't2'], 't2'), space('b', ['t3'], 't3')]
    const result = addTabToSpace(spaces, 'b', 't2')
    expect(result[0].tabIds).toEqual(['t1'])
    expect(result[1].tabIds).toEqual(['t3', 't2'])
    expect(ownedExactlyOnce(result, ['t1', 't2', 't3'])).toBe(true)
  })
  it('repairs the source space active tab when the moved tab was its active one', () => {
    const spaces = [space('a', ['t1', 't2'], 't2'), space('b', [])]
    const result = addTabToSpace(spaces, 'b', 't2')
    expect(result[0].activeTabId).toBe('t1')
    expect(activeTabsAreMembers(result)).toBe(true)
  })
  it('leaves the source space with no active tab when it moved its only tab out', () => {
    const spaces = [space('a', ['t1'], 't1'), space('b', [])]
    const result = addTabToSpace(spaces, 'b', 't1')
    expect(result[0].tabIds).toEqual([])
    expect(result[0].activeTabId).toBeUndefined()
    expect('activeTabId' in result[0]).toBe(false)
  })
  it('is a no-op (same reference) when the tab is already in that space', () => {
    const spaces = [space('a', ['t1'])]
    expect(addTabToSpace(spaces, 'a', 't1')).toBe(spaces)
  })
  it('is a no-op for an unknown spaceId — and does NOT evict the tab from its owner', () => {
    const spaces = [space('a', ['t1'])]
    expect(addTabToSpace(spaces, 'ghost', 't1')).toBe(spaces)
  })
  it('does not validate the tabId against a tab registry — it has none', () => {
    // Documents the boundary: membership and the tab list are separate here, so
    // an id that names no tab is accepted. Sweeping it up is sanitize()'s job
    // (test/workspace.test.ts), not a second repair path in here.
    const result = addTabToSpace([space('a')], 'a', 'nosuchtab')
    expect(result[0].tabIds).toEqual(['nosuchtab'])
  })
  // Pins the documented precondition rather than a wish: the input below cannot
  // come out of sanitize(), so repairing it here would be a second normalizer
  // that only ever fires for a caller that already broke the invariant.
  it('does NOT repair a dirty target — a two-owner input stays two-owner', () => {
    const spaces = [space('a', ['t1']), space('b', ['t1', 't1'])]
    expect(addTabToSpace(spaces, 'b', 't1')).toBe(spaces)
  })
  it('does not mutate its input', () => {
    const spaces = [space('a', ['t1', 't2'], 't2'), space('b', ['t3'])]
    const snapshot = structuredClone(spaces)
    addTabToSpace(spaces, 'b', 't2')
    expect(spaces).toEqual(snapshot)
  })
})

describe('removeTabFromSpace', () => {
  it('drops the tab from the membership', () => {
    const result = removeTabFromSpace([space('a', ['t1', 't2', 't3'])], 'a', 't2')
    expect(result[0].tabIds).toEqual(['t1', 't3'])
  })
  it('promotes the tab that slid into the removed active slot', () => {
    const result = removeTabFromSpace([space('a', ['t1', 't2', 't3'], 't2')], 'a', 't2')
    expect(result[0].activeTabId).toBe('t3')
  })
  it('falls back to the previous tab when the active LAST tab is removed', () => {
    const result = removeTabFromSpace([space('a', ['t1', 't2'], 't2')], 'a', 't2')
    expect(result[0].activeTabId).toBe('t1')
  })
  it('leaves no active tab at all when the last tab goes', () => {
    const result = removeTabFromSpace([space('a', ['t1'], 't1')], 'a', 't1')
    expect(result[0].tabIds).toEqual([])
    expect(result[0].activeTabId).toBeUndefined()
  })
  it('leaves a non-active removal alone', () => {
    const result = removeTabFromSpace([space('a', ['t1', 't2'], 't2')], 'a', 't1')
    expect(result[0].activeTabId).toBe('t2')
  })
  it('is a no-op for an unknown spaceId or a non-member tab', () => {
    const spaces = [space('a', ['t1'])]
    expect(removeTabFromSpace(spaces, 'ghost', 't1')).toBe(spaces)
    expect(removeTabFromSpace(spaces, 'a', 'ghost')).toBe(spaces)
  })
  it('does not mutate its input', () => {
    const spaces = [space('a', ['t1', 't2'], 't2')]
    const snapshot = structuredClone(spaces)
    removeTabFromSpace(spaces, 'a', 't2')
    expect(spaces).toEqual(snapshot)
  })
})

describe('reorderInSpace', () => {
  it('moves a tab within the space order', () => {
    const result = reorderInSpace([space('a', ['t1', 't2', 't3'])], 'a', 0, 2)
    expect(result[0].tabIds).toEqual(['t2', 't3', 't1'])
  })
  it('indexes THIS space, not a global list — a second space is untouched', () => {
    const spaces = [space('a', ['t1', 't2']), space('b', ['t3', 't4'])]
    const result = reorderInSpace(spaces, 'b', 0, 1)
    expect(result[0]).toBe(spaces[0])
    expect(result[1].tabIds).toEqual(['t4', 't3'])
  })
  it('changes order only — membership and the active tab survive', () => {
    const result = reorderInSpace([space('a', ['t1', 't2', 't3'], 't1')], 'a', 0, 2)
    expect(result[0].activeTabId).toBe('t1')
    expect([...result[0].tabIds].sort()).toEqual(['t1', 't2', 't3'])
  })
  it('is a no-op (same reference) for an unknown spaceId', () => {
    const spaces = [space('a', ['t1', 't2'])]
    expect(reorderInSpace(spaces, 'ghost', 0, 1)).toBe(spaces)
  })
  it('is a no-op for an out-of-range from, rather than dropping a tab', () => {
    const spaces = [space('a', ['t1', 't2'])]
    expect(reorderInSpace(spaces, 'a', 5, 0)).toBe(spaces)
    expect(reorderInSpace(spaces, 'a', -1, 0)).toBe(spaces)
  })
  it('is a no-op when the move lands where it started', () => {
    const spaces = [space('a', ['t1', 't2'])]
    expect(reorderInSpace(spaces, 'a', 1, 1)).toBe(spaces)
  })
  it('clamps an out-of-range insert instead of throwing', () => {
    const result = reorderInSpace([space('a', ['t1', 't2', 't3'])], 'a', 0, 99)
    expect(result[0].tabIds).toEqual(['t2', 't3', 't1'])
  })
  it('does not mutate its input', () => {
    const spaces = [space('a', ['t1', 't2', 't3'], 't3')]
    const snapshot = structuredClone(spaces)
    reorderInSpace(spaces, 'a', 2, 0)
    expect(spaces).toEqual(snapshot)
  })
})

describe('exactly-one-space invariant sweep', () => {
  // Deterministic PRNG (mulberry32) so the sweep is reproducible, not flaky.
  function mulberry32(seed: number) {
    let a = seed
    return () => {
      a |= 0
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  it('every known tab stays in exactly one space through any operation sequence', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rand = mulberry32(seed * 7919)
      const pick = <X>(xs: readonly X[]): X => xs[Math.floor(rand() * xs.length)]

      // Starts CLEAN, because that is now the real precondition: sanitize()
      // (test/workspace.test.ts) is what turns a hand-edited file into this,
      // and these mutators are only ever handed its output. The dirt the sweep
      // still throws at them is ids that name nothing — ghost spaces, ghost
      // tabs, a ghost activeSpaceId — which no sanitizer can rule out because
      // they come from the UI, not from disk.
      let known = ['t1', 't2', 't3', 't4', 't5', 't6']
      let spaces: S[] = [space('s0', ['t1', 't2', 't3'], 't2'), space('s1', ['t4', 't5', 't6'])]
      let activeSpaceId = 's0'

      for (let step = 0; step < 60; step++) {
        const op = Math.floor(rand() * 8)
        const spaceId = pick([...spaces.map((s) => s.id), 'ghostspace'])
        const tabId = pick([...known, 'ghosttab'])

        if (op === 0) {
          ;({ spaces } = createSpace(spaces, `space-${step}`))
        } else if (op === 1) {
          spaces = renameSpace(spaces, spaceId, `renamed-${step}`)
        } else if (op === 2) {
          // Sometimes hand it an activeSpaceId that names nothing. A caller
          // CAN hold a stale one (a space deleted in another code path, a
          // restore race), and passing it back out untouched would leave the
          // switcher pointing at nothing — the invariant assertion below is
          // what catches that.
          const activeArg = rand() < 0.25 ? 'ghostactive' : activeSpaceId
          const result = deleteSpace(spaces, activeArg, spaceId)
          if (result.ok) {
            spaces = result.spaces
            activeSpaceId = result.activeSpaceId
            // Deleting a space closes its tabs: they leave the known set, which
            // is the ONLY legal way for a tab to stop having an owner.
            known = known.filter((id) => !result.closedTabIds.includes(id))
          } else {
            // The refusal must be honest: a real id is only ever refused
            // because it is the last space standing.
            const exists = spaces.some((s) => s.id === spaceId)
            expect(result.reason).toBe(exists ? 'LAST_SPACE' : 'NO_SUCH_SPACE')
            if (result.reason === 'LAST_SPACE') expect(spaces).toHaveLength(1)
          }
        } else if (op === 3) {
          const switched = switchSpace(spaces, activeSpaceId, spaceId)
          activeSpaceId = switched.activeSpaceId
          expect(spaces.some((s) => s.id === activeSpaceId)).toBe(true)
          const owner = spaces.find((s) => s.id === activeSpaceId)!
          expect(switched.tabIds).toEqual(owner.tabIds)
          expect(switched.activeTabId).toBe(owner.activeTabId)
        } else if (op === 4) {
          spaces = setActiveTab(spaces, spaceId, tabId)
        } else if (op === 5) {
          // Both real uses go through this: move an existing tab into this
          // space, or open a brand-new tab in it. The id always names a real
          // tab, because that is the caller's contract — feeding it an id that
          // names nothing is garbage the second sweep (normalizeSpaces) owns.
          const opened = pick([...known, `new-${seed}-${step}`])
          const before = spaces
          spaces = addTabToSpace(spaces, spaceId, opened)
          if (spaces !== before && !known.includes(opened)) known = [...known, opened]
        } else if (op === 6) {
          // Removing membership without a destination is only correct when the
          // tab is being closed, so model exactly that: the tab leaves `known`.
          const before = spaces
          spaces = removeTabFromSpace(spaces, spaceId, tabId)
          if (spaces !== before) known = known.filter((id) => id !== tabId)
        } else {
          // Reorder is order-only. `from`/`insert` deliberately run one past the
          // end so out-of-range indices — which a drag from a strip that just
          // lost a tab really does produce — are swept too.
          const len = spaces.find((s) => s.id === spaceId)?.tabIds.length ?? 0
          const before = spaces.map((s) => [s.id, [...s.tabIds].sort().join(',')] as const)
          spaces = reorderInSpace(
            spaces,
            spaceId,
            Math.floor(rand() * (len + 2)) - 1,
            Math.floor(rand() * (len + 2)) - 1,
          )
          // Every space keeps exactly the members it had: a reorder that edited
          // the wrong space, or dropped/duplicated a tab, changes one of these
          // signatures. (The global assertions below would miss a swap between
          // two spaces of equal size.)
          for (const [id, signature] of before) {
            expect([...spaces.find((s) => s.id === id)!.tabIds].sort().join(',')).toBe(signature)
          }
        }

        // --- the invariants, after EVERY single operation ---
        expect(spaces.length).toBeGreaterThan(0)
        expect(ownedExactlyOnce(spaces, known)).toBe(true)
        expect(activeTabsAreMembers(spaces)).toBe(true)
        expect(spaces.some((s) => s.id === activeSpaceId)).toBe(true)
        // No operation may drop or duplicate a tab.
        expect(spaces.flatMap((s) => s.tabIds).sort()).toEqual([...known].sort())
        // Space ids stay unique, or every lookup in the module is ambiguous.
        expect(new Set(spaces.map((s) => s.id)).size).toBe(spaces.length)
      }
    }
  })

})
