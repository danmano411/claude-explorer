import { describe, it, expect } from 'vitest'
import type { Space } from '../src/shared/types'
import {
  addTabToSpace,
  createSpace,
  deleteSpace,
  normalizeSpaces,
  removeTabFromSpace,
  renameSpace,
  setActiveTab,
  switchSpace,
} from '../src/renderer/spaces'

/**
 * The real persisted type, widened with the field KAN-43 is adding to it right
 * now (`Space.activeTabId?: string`). Once that lands this alias collapses to
 * `Space` with no other change — which is the point of writing the module over
 * a structural type.
 */
type S = Space & { activeTabId?: string }

const space = (id: string, tabIds: string[] = [], activeTabId?: string): S => ({
  id,
  name: id,
  tabIds,
  layout: null,
  ...(activeTabId === undefined ? {} : { activeTabId }),
})

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
  it('does not mutate its input', () => {
    const spaces = [space('a', ['t1']), space('b')]
    const snapshot = structuredClone(spaces)
    deleteSpace(spaces, 'a', 'a')
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
    // an id that names no tab is accepted and left for normalizeSpaces to sweep
    // up. Callers pass live tab ids; see the module doc comment.
    const result = addTabToSpace([space('a')], 'a', 'nosuchtab')
    expect(result[0].tabIds).toEqual(['nosuchtab'])
    expect(normalizeSpaces(result, [], 'a').spaces[0].tabIds).toEqual([])
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

describe('normalizeSpaces', () => {
  it('leaves an already-consistent list untouched (same reference)', () => {
    const spaces = [space('a', ['t1'], 't1'), space('b', ['t2'])]
    const result = normalizeSpaces(spaces, ['t1', 't2'], 'a')
    expect(result.spaces).toBe(spaces)
    expect(result.activeSpaceId).toBe('a')
  })
  it('drops tab ids with no tab', () => {
    const result = normalizeSpaces([space('a', ['t1', 'ghost', 't2'])], ['t1', 't2'], 'a')
    expect(result.spaces[0].tabIds).toEqual(['t1', 't2'])
  })
  it('keeps a tab claimed by two spaces at its first occurrence only', () => {
    const spaces = [space('a', ['t1', 't2']), space('b', ['t2', 't3'])]
    const result = normalizeSpaces(spaces, ['t1', 't2', 't3'], 'a')
    expect(result.spaces[0].tabIds).toEqual(['t1', 't2'])
    expect(result.spaces[1].tabIds).toEqual(['t3'])
    expect(ownedExactlyOnce(result.spaces, ['t1', 't2', 't3'])).toBe(true)
  })
  it('de-duplicates a tab listed twice within one space', () => {
    const result = normalizeSpaces([space('a', ['t1', 't1'])], ['t1'], 'a')
    expect(result.spaces[0].tabIds).toEqual(['t1'])
  })
  it('adopts an orphan tab into the active space — never zero owners', () => {
    const spaces = [space('a', ['t1']), space('b', ['t2'])]
    const result = normalizeSpaces(spaces, ['t1', 't2', 'orphan'], 'b')
    expect(result.spaces[1].tabIds).toEqual(['t2', 'orphan'])
    expect(ownedExactlyOnce(result.spaces, ['t1', 't2', 'orphan'])).toBe(true)
  })
  it('adopts orphans into the first space when the active id does not resolve', () => {
    const spaces = [space('a', []), space('b', [])]
    const result = normalizeSpaces(spaces, ['orphan'], 'ghost')
    expect(result.activeSpaceId).toBe('a')
    expect(result.spaces[0].tabIds).toEqual(['orphan'])
  })
  it('adopts a duplicated knownTabIds entry exactly once', () => {
    const result = normalizeSpaces([space('a', [])], ['t1', 't1'], 'a')
    expect(result.spaces[0].tabIds).toEqual(['t1'])
  })
  it('drops an activeTabId that is not in its own space', () => {
    const spaces = [space('a', ['t1'], 't2'), space('b', ['t2'], 't2')]
    const result = normalizeSpaces(spaces, ['t1', 't2'], 'a')
    expect(result.spaces[0].activeTabId).toBeUndefined()
    expect(result.spaces[1].activeTabId).toBe('t2')
  })
  it('drops an activeTabId whose tab was stolen by an earlier space', () => {
    const spaces = [space('a', ['t1']), space('b', ['t1'], 't1')]
    const result = normalizeSpaces(spaces, ['t1'], 'a')
    expect(result.spaces[1].tabIds).toEqual([])
    expect(result.spaces[1].activeTabId).toBeUndefined()
    expect(activeTabsAreMembers(result.spaces)).toBe(true)
  })
  it('does not invent an activeTabId for a space that has tabs but remembers none', () => {
    const result = normalizeSpaces([space('a', ['t1', 't2'])], ['t1', 't2'], 'a')
    expect(result.spaces[0].activeTabId).toBeUndefined()
  })
  it('collapses two spaces sharing an id', () => {
    const spaces = [space('a', ['t1']), space('a', ['t2'])]
    const result = normalizeSpaces(spaces, ['t1', 't2'], 'a')
    expect(result.spaces).toHaveLength(1)
    expect(result.spaces[0].tabIds).toEqual(['t1', 't2']) // t2 re-adopted as an orphan
    expect(ownedExactlyOnce(result.spaces, ['t1', 't2'])).toBe(true)
  })
  it('invents a space when there are none, and every tab lands in it', () => {
    const result = normalizeSpaces<S>([], ['t1', 't2'], 'ghost')
    expect(result.spaces).toHaveLength(1)
    expect(result.spaces[0].tabIds).toEqual(['t1', 't2'])
    expect(result.activeSpaceId).toBe(result.spaces[0].id)
    expect(result.spaces[0].layout).toBeNull()
  })
  it('repoints an activeSpaceId that names nothing', () => {
    const spaces = [space('a'), space('b')]
    expect(normalizeSpaces(spaces, [], 'ghost').activeSpaceId).toBe('a')
  })
  it('preserves fields it knows nothing about, like layout', () => {
    const withLayout: S = {
      id: 'a',
      name: 'a',
      tabIds: ['t1', 'ghost'],
      layout: { cols: 2, rows: 1, cells: [{ tabId: 't1', col: 0, row: 0, colSpan: 1, rowSpan: 1 }] },
    }
    const result = normalizeSpaces([withLayout], ['t1'], 'a')
    expect(result.spaces[0].layout).toEqual(withLayout.layout)
  })
  it('does not mutate its input', () => {
    const spaces = [space('a', ['t1', 'ghost'], 'ghost'), space('b', ['t1'])]
    const snapshot = structuredClone(spaces)
    normalizeSpaces(spaces, ['t1'], 'nope')
    expect(spaces).toEqual(snapshot)
  })
  it('is idempotent', () => {
    const spaces = [space('a', ['t1', 't2', 'ghost'], 'ghost'), space('b', ['t2'], 't2')]
    const once = normalizeSpaces(spaces, ['t1', 't2', 't3'], 'ghost')
    const twice = normalizeSpaces(once.spaces, ['t1', 't2', 't3'], once.activeSpaceId)
    expect(twice.spaces).toBe(once.spaces)
    expect(twice.activeSpaceId).toBe(once.activeSpaceId)
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

      // Start deliberately dirty, so the sweep also exercises the repair path.
      let known = ['t1', 't2', 't3', 't4', 't5', 't6']
      let spaces: S[] = [space('s0', ['t1', 't2', 't2', 'ghost'], 'ghost'), space('s1', ['t2', 't3'])]
      let activeSpaceId = 'nosuchspace'
      ;({ spaces, activeSpaceId } = normalizeSpaces(spaces, known, activeSpaceId))

      for (let step = 0; step < 60; step++) {
        const op = Math.floor(rand() * 7)
        const spaceId = pick([...spaces.map((s) => s.id), 'ghostspace'])
        const tabId = pick([...known, 'ghosttab'])

        if (op === 0) {
          ;({ spaces } = createSpace(spaces, `space-${step}`))
        } else if (op === 1) {
          spaces = renameSpace(spaces, spaceId, `renamed-${step}`)
        } else if (op === 2) {
          const result = deleteSpace(spaces, activeSpaceId, spaceId)
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
        } else {
          // Removing membership without a destination is only correct when the
          // tab is being closed, so model exactly that: the tab leaves `known`.
          const before = spaces
          spaces = removeTabFromSpace(spaces, spaceId, tabId)
          if (spaces !== before) known = known.filter((id) => id !== tabId)
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

  it('normalizeSpaces restores the invariant from arbitrary garbage', () => {
    const tabPool = ['t1', 't2', 't3', 't4', 'ghost1', 'ghost2']
    for (let seed = 1; seed <= 60; seed++) {
      const rand = mulberry32(seed * 104729)
      const pick = <X>(xs: readonly X[]): X => xs[Math.floor(rand() * xs.length)]

      // Random, deliberately broken input: repeated space ids, tabs claimed by
      // several spaces, ids of tabs that do not exist, bogus activeTabIds.
      const known = tabPool.filter((id) => !id.startsWith('ghost') || rand() < 0.2)
      const spaces: S[] = []
      const spaceCount = Math.floor(rand() * 4) // 0..3, including the empty list
      for (let i = 0; i < spaceCount; i++) {
        const tabIds: string[] = []
        for (let k = 0; k < Math.floor(rand() * 5); k++) tabIds.push(pick(tabPool))
        const activeTabId = rand() < 0.7 ? pick([...tabPool, 'nothing']) : undefined
        spaces.push(space(pick(['sA', 'sB', 'sC']), tabIds, activeTabId))
      }
      const activeSpaceId = pick(['sA', 'sB', 'sC', 'sZ'])

      const result = normalizeSpaces(spaces, known, activeSpaceId)

      expect(result.spaces.length).toBeGreaterThan(0)
      expect(ownedExactlyOnce(result.spaces, known)).toBe(true)
      expect(activeTabsAreMembers(result.spaces)).toBe(true)
      expect(result.spaces.some((s) => s.id === result.activeSpaceId)).toBe(true)
      expect(new Set(result.spaces.map((s) => s.id)).size).toBe(result.spaces.length)
      // Idempotent: a second pass has nothing left to fix.
      const again = normalizeSpaces(result.spaces, known, result.activeSpaceId)
      expect(again.spaces).toBe(result.spaces)
    }
  })
})
