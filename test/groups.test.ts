import { describe, it, expect } from 'vitest'
import type { TabGroup } from '../src/shared/types'
import {
  GROUP_COLORS,
  addToGroup,
  deleteGroup,
  groupRun,
  moveGroupRun,
  newGroup,
  normalize,
  recolorGroup,
  removeFromGroup,
  renameGroup,
  reorderWithGroups,
  segments,
  setCollapsed,
  setPinned,
  type Grouped,
} from '../src/shared/groups'

const tab = (id: string, groupId?: string): Grouped => (groupId ? { id, groupId } : { id })
const pinned = (id: string): Grouped => ({ id, pinned: true })

const group = (id: string, name = id, color = GROUP_COLORS[0], collapsed = false): TabGroup => ({
  id,
  name,
  color,
  collapsed,
})

/** Every group's members occupy one unbroken block of indices — the
 *  invariant the whole module exists to protect. */
function isContiguous(tabs: Grouped[]): boolean {
  const spans = new Map<string, { first: number; last: number; count: number }>()
  tabs.forEach((t, i) => {
    if (t.groupId === undefined) return
    const s = spans.get(t.groupId) ?? { first: i, last: i, count: 0 }
    s.last = i
    s.count += 1
    spans.set(t.groupId, s)
  })
  return [...spans.values()].every((s) => s.last - s.first + 1 === s.count)
}

/** KAN-53: every pinned tab sits left of every unpinned one. The second
 *  ordering invariant of the rendered strip, enforced beside contiguity. */
function isPinnedFirst(tabs: Grouped[]): boolean {
  const lastPinned = tabs.map((t) => !!t.pinned).lastIndexOf(true)
  const firstLoose = tabs.findIndex((t) => !t.pinned)
  return lastPinned === -1 || firstLoose === -1 || lastPinned < firstLoose
}

/** Pinning and grouping are mutually exclusive: a pinned tab is forced left of
 *  the strip, so it could only ever break its group's contiguous run. */
function noPinnedMembers(tabs: Grouped[]): boolean {
  return tabs.every((t) => !(t.pinned && t.groupId !== undefined))
}

describe('GROUP_COLORS', () => {
  it('is a non-empty palette of real Retro Claude custom properties, not invented hex', () => {
    expect(GROUP_COLORS.length).toBeGreaterThan(0)
    for (const c of GROUP_COLORS) expect(c).toMatch(/^var\(--[a-z-]+\)$/)
  })
})

describe('newGroup', () => {
  it('creates a collapsed:false group with a fresh id', () => {
    const g = newGroup('Work')
    expect(g.collapsed).toBe(false)
    expect(g.name).toBe('Work')
    expect(typeof g.id).toBe('string')
    expect(g.id.length).toBeGreaterThan(0)
  })
  it('gives two groups created back to back different ids', () => {
    const a = newGroup('A')
    const b = newGroup('B')
    expect(a.id).not.toBe(b.id)
  })
  it('round-robins the color by how many groups already exist', () => {
    const g0 = newGroup('g0', [])
    expect(g0.color).toBe(GROUP_COLORS[0])
    const existing: TabGroup[] = [g0]
    const g1 = newGroup('g1', existing)
    expect(g1.color).toBe(GROUP_COLORS[1 % GROUP_COLORS.length])
    const g2 = newGroup('g2', [...existing, g1])
    expect(g2.color).toBe(GROUP_COLORS[2 % GROUP_COLORS.length])
  })
  it('wraps back to the first color once the palette is exhausted', () => {
    const existing = GROUP_COLORS.map((_, i) => group(`g${i}`))
    const wrapped = newGroup('wrapped', existing)
    expect(wrapped.color).toBe(GROUP_COLORS[0])
  })
  it('an explicit color overrides the round-robin', () => {
    const g = newGroup('Work', [], 'var(--diff-add)')
    expect(g.color).toBe('var(--diff-add)')
  })
})

describe('groupRun', () => {
  it('finds the range of a contiguous run', () => {
    const tabs = [tab('a'), tab('b', 'g1'), tab('c', 'g1'), tab('d')]
    expect(groupRun(tabs, 'g1')).toEqual({ start: 1, end: 3 })
  })
  it('returns the bounding span for a non-contiguous group, not just the literal indices', () => {
    const tabs = [tab('a', 'g1'), tab('b'), tab('c', 'g1')]
    expect(groupRun(tabs, 'g1')).toEqual({ start: 0, end: 3 })
  })
  it('is null when the group has no members', () => {
    expect(groupRun([tab('a'), tab('b')], 'g1')).toBeNull()
  })
  it('a single member is a run of length one', () => {
    expect(groupRun([tab('a'), tab('b', 'g1')], 'g1')).toEqual({ start: 1, end: 2 })
  })
})

describe('addToGroup', () => {
  it('tags the first member in place — a run of one needs no move', () => {
    const tabs = [tab('a'), tab('b'), tab('c'), tab('d')]
    const result = addToGroup(tabs, 'b', 'g1')
    expect(result.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(result.find((t) => t.id === 'b')?.groupId).toBe('g1')
  })
  it('moves a second member to the end of the existing run', () => {
    const tabs = [tab('a'), tab('b'), tab('c', 'g1'), tab('d')]
    const result = addToGroup(tabs, 'a', 'g1')
    expect(result.map((t) => t.id)).toEqual(['b', 'c', 'a', 'd'])
    expect(isContiguous(result)).toBe(true)
  })
  it('appends a third member after the run, not at the array end by accident', () => {
    const tabs = [tab('b'), tab('c', 'g1'), tab('a', 'g1'), tab('d')]
    const result = addToGroup(tabs, 'd', 'g1')
    expect(result.map((t) => t.id)).toEqual(['b', 'c', 'a', 'd'])
    expect(isContiguous(result)).toBe(true)
  })
  it('is a no-op for an unknown tabId', () => {
    const tabs = [tab('a'), tab('b')]
    expect(addToGroup(tabs, 'nope', 'g1')).toBe(tabs)
  })
  it('refuses a PINNED tab — it would have to be dragged out of the pinned block to join a run', () => {
    const tabs = [pinned('p1'), tab('a', 'g1'), tab('b', 'g1')]
    expect(addToGroup(tabs, 'p1', 'g1')).toBe(tabs)
  })
  it('does not mutate its input', () => {
    const tabs = [tab('a'), tab('b'), tab('c', 'g1')]
    const snapshot = structuredClone(tabs)
    addToGroup(tabs, 'a', 'g1')
    expect(tabs).toEqual(snapshot)
  })
  it('regression: moving an INTERIOR member of one group straight into a second, empty group must not split the first group', () => {
    // d,g,a,f are all g1, with a sandwiched in the middle. Re-tagging a to a
    // brand-new g2 (no run to join yet) must not just relabel it in place —
    // that would leave g1 as [d,g] ... [f], split by the newly-tagged a.
    const tabs = [tab('d', 'g1'), tab('g', 'g1'), tab('a', 'g1'), tab('f', 'g1')]
    const result = addToGroup(tabs, 'a', 'g2')
    expect(isContiguous(result)).toBe(true)
    expect(result.map((t) => t.id)).toEqual(['d', 'g', 'f', 'a'])
    expect(result.find((t) => t.id === 'a')?.groupId).toBe('g2')
  })
})

describe('removeFromGroup', () => {
  it('untags and relocates the tab to just after the group run', () => {
    const tabs = [tab('b'), tab('c', 'g1'), tab('a', 'g1'), tab('d')]
    const result = removeFromGroup(tabs, 'c')
    expect(result.map((t) => t.id)).toEqual(['b', 'a', 'c', 'd'])
    expect(result.find((t) => t.id === 'c')?.groupId).toBeUndefined()
  })
  it('a sole member just gets untagged in place', () => {
    const tabs = [tab('a'), tab('b', 'g1'), tab('c')]
    const result = removeFromGroup(tabs, 'b')
    expect(result.map((t) => t.id)).toEqual(['a', 'b', 'c'])
    expect(result[1].groupId).toBeUndefined()
  })
  it('is a no-op for an unknown tabId', () => {
    const tabs = [tab('a'), tab('b', 'g1')]
    expect(removeFromGroup(tabs, 'nope')).toBe(tabs)
  })
  it('is a no-op for a tab that is already ungrouped', () => {
    const tabs = [tab('a'), tab('b', 'g1')]
    expect(removeFromGroup(tabs, 'a')).toBe(tabs)
  })
  it('does not mutate its input', () => {
    const tabs = [tab('b'), tab('c', 'g1'), tab('a', 'g1'), tab('d')]
    const snapshot = structuredClone(tabs)
    removeFromGroup(tabs, 'c')
    expect(tabs).toEqual(snapshot)
  })
})

describe('setPinned', () => {
  it('pinning moves the tab to the END of the pinned block, not to wherever it already sat', () => {
    const tabs = [pinned('p1'), tab('a'), tab('b'), tab('c')]
    const result = setPinned(tabs, 'c', true)
    expect(result.map((t) => t.id)).toEqual(['p1', 'c', 'a', 'b'])
    expect(isPinnedFirst(result)).toBe(true)
  })
  it('pinning the only tab of an unpinned strip puts it first', () => {
    const tabs = [tab('a'), tab('b')]
    expect(setPinned(tabs, 'b', true).map((t) => t.id)).toEqual(['b', 'a'])
  })
  it('pinning a GROUPED tab removes it from the group and the rest stay one contiguous run', () => {
    const tabs = [tab('a'), tab('b', 'g1'), tab('c', 'g1'), tab('d', 'g1'), tab('e')]
    const result = setPinned(tabs, 'c', true) // the middle member
    expect(result.map((t) => t.id)).toEqual(['c', 'a', 'b', 'd', 'e'])
    expect(result.find((t) => t.id === 'c')?.groupId).toBeUndefined()
    expect(result.find((t) => t.id === 'c')?.pinned).toBe(true)
    expect(isContiguous(result)).toBe(true)
    expect(groupRun(result, 'g1')).toEqual({ start: 2, end: 4 })
  })
  it('unpinning drops the flag and lands the tab at the head of the unpinned region', () => {
    const tabs = [pinned('p1'), pinned('p2'), tab('a'), tab('b')]
    const result = setPinned(tabs, 'p1', false)
    expect(result.map((t) => t.id)).toEqual(['p2', 'p1', 'a', 'b'])
    expect(result.find((t) => t.id === 'p1')).toEqual({ id: 'p1' }) // no `pinned: false` residue
    expect(isPinnedFirst(result)).toBe(true)
  })
  it('unpinning in front of a group does not split that group', () => {
    const tabs = [pinned('p1'), tab('a', 'g1'), tab('b', 'g1')]
    const result = setPinned(tabs, 'p1', false)
    expect(result.map((t) => t.id)).toEqual(['p1', 'a', 'b'])
    expect(isContiguous(result)).toBe(true)
  })
  it('is a no-op (same reference) for an unknown tabId or a state that already holds', () => {
    const tabs = [pinned('p1'), tab('a')]
    expect(setPinned(tabs, 'nope', true)).toBe(tabs)
    expect(setPinned(tabs, 'p1', true)).toBe(tabs)
    expect(setPinned(tabs, 'a', false)).toBe(tabs)
  })
  it('does not mutate its input', () => {
    const tabs = [tab('a'), tab('b', 'g1'), tab('c', 'g1')]
    const snapshot = structuredClone(tabs)
    setPinned(tabs, 'b', true)
    expect(tabs).toEqual(snapshot)
  })
})

describe('renameGroup / setCollapsed / recolorGroup', () => {
  it('rename updates only the matching group', () => {
    const groups = [group('g1', 'old'), group('g2', 'other')]
    const result = renameGroup(groups, 'g1', 'new')
    expect(result[0].name).toBe('new')
    expect(result[1]).toBe(groups[1])
  })
  it('setCollapsed toggles only the matching group', () => {
    const groups = [group('g1')]
    expect(setCollapsed(groups, 'g1', true)[0].collapsed).toBe(true)
  })
  it('recolorGroup sets only the matching group', () => {
    const groups = [group('g1', 'g1', GROUP_COLORS[0])]
    expect(recolorGroup(groups, 'g1', GROUP_COLORS[1])[0].color).toBe(GROUP_COLORS[1])
  })
  it('each is a no-op (same reference) for an unknown groupId', () => {
    const groups = [group('g1')]
    expect(renameGroup(groups, 'nope', 'x')).toBe(groups)
    expect(setCollapsed(groups, 'nope', true)).toBe(groups)
    expect(recolorGroup(groups, 'nope', GROUP_COLORS[0])).toBe(groups)
  })
})

describe('deleteGroup', () => {
  it('removes the group and ungroups its tabs without closing them', () => {
    const groups = [group('g1'), group('g2')]
    const tabs = [tab('a', 'g1'), tab('b', 'g1'), tab('c', 'g2')]
    const result = deleteGroup(groups, tabs, 'g1')
    expect(result.groups.map((g) => g.id)).toEqual(['g2'])
    expect(result.tabs.map((t) => t.id)).toEqual(['a', 'b', 'c']) // still all present
    expect(result.tabs.filter((t) => t.groupId === 'g1')).toHaveLength(0)
    expect(result.tabs.find((t) => t.id === 'c')?.groupId).toBe('g2') // untouched
  })
  it('is a no-op (same references, both fields) for an unknown groupId', () => {
    const groups = [group('g1')]
    const tabs = [tab('a', 'g1')]
    const result = deleteGroup(groups, tabs, 'nope')
    expect(result.groups).toBe(groups)
    expect(result.tabs).toBe(tabs)
  })
  it('deleting a group with no members leaves the tabs array reference untouched', () => {
    const groups = [group('g1'), group('g2')]
    const tabs = [tab('a', 'g2')]
    const result = deleteGroup(groups, tabs, 'g1')
    expect(result.tabs).toBe(tabs)
  })
})

describe('segments', () => {
  it('chops the flat list into loose/grouped runs in order', () => {
    const groups = [group('g1'), group('g2')]
    const tabs = [tab('a'), tab('b', 'g1'), tab('c', 'g1'), tab('d'), tab('e', 'g2')]
    const result = segments(tabs, groups)
    expect(result).toHaveLength(4)
    expect(result[0]).toMatchObject({ group: null, tabs: [tab('a')] })
    expect(result[1].group?.id).toBe('g1')
    expect(result[1].tabs.map((t) => t.id)).toEqual(['b', 'c'])
    expect(result[2]).toMatchObject({ group: null, tabs: [tab('d')] })
    expect(result[3].group?.id).toBe('g2')
  })
  it('folds a groupId with no matching TabGroup into a loose segment instead of crashing', () => {
    const tabs = [tab('a', 'ghost'), tab('b')]
    const result = segments(tabs, [])
    expect(result).toEqual([{ group: null, tabs: [tab('a', 'ghost'), tab('b')] }])
  })
  it('is empty for an empty tab list', () => {
    expect(segments([], [group('g1')])).toEqual([])
  })
  it('every tab appears in the output exactly once, in order', () => {
    const groups = [group('g1')]
    const tabs = [tab('a', 'g1'), tab('b', 'g1'), tab('c')]
    const flat = segments(tabs, groups).flatMap((s) => s.tabs)
    expect(flat.map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('normalize', () => {
  it('leaves an already-contiguous, valid list untouched (same reference)', () => {
    const groups = [group('g1')]
    const tabs = [tab('a'), tab('b', 'g1'), tab('c', 'g1'), tab('d')]
    expect(normalize(tabs, groups)).toBe(tabs)
  })
  it('closes the gap in a scattered group, pulling members together at the first occurrence', () => {
    const groups = [group('g1')]
    const tabs = [tab('a', 'g1'), tab('b'), tab('c', 'g1')]
    const result = normalize(tabs, groups)
    expect(result.map((t) => t.id)).toEqual(['a', 'c', 'b'])
    expect(isContiguous(result)).toBe(true)
  })
  it('preserves relative order of two interleaved groups plus loose tabs', () => {
    const groups = [group('g1'), group('g2')]
    const tabs = [tab('a', 'g1'), tab('x'), tab('b', 'g2'), tab('c', 'g1'), tab('y'), tab('d', 'g2')]
    const result = normalize(tabs, groups)
    expect(result.map((t) => t.id)).toEqual(['a', 'c', 'x', 'b', 'd', 'y'])
    expect(isContiguous(result)).toBe(true)
  })
  it('clears a groupId that does not name a real group', () => {
    const tabs = [tab('a', 'ghost')]
    const result = normalize(tabs, [])
    expect(result[0].groupId).toBeUndefined()
  })
  it('does not mutate its input', () => {
    const groups = [group('g1')]
    const tabs = [tab('a', 'g1'), tab('b'), tab('c', 'g1')]
    const snapshot = structuredClone(tabs)
    normalize(tabs, groups)
    expect(tabs).toEqual(snapshot)
  })
  // KAN-43 review D-3: the no-op guard used to be `result.every((t,i) => t ===
  // tabs[i])`, which is true whenever `result` is a PREFIX of `tabs` — and a
  // trailing duplicate id always produces exactly that (the dedupe pass drops
  // the second occurrence, which was already at the end). So the duplicate
  // silently survived through the "nothing to repair, return original" branch.
  it('dedupes a trailing duplicate id', () => {
    const tabs = [tab('a'), tab('b'), tab('b')]
    expect(normalize(tabs, []).map((t) => t.id)).toEqual(['a', 'b'])
  })
  // KAN-53: the same single repair path also owns pinned-before-unpinned, so a
  // hand-edited workspace.json is fixed on read instead of in the renderer.
  it('hoists pinned tabs to the front, keeping their relative order', () => {
    const tabs = [tab('a'), pinned('p2'), tab('b'), pinned('p1')]
    const result = normalize(tabs, [])
    expect(result.map((t) => t.id)).toEqual(['p2', 'p1', 'a', 'b'])
    expect(isPinnedFirst(result)).toBe(true)
  })
  it('clears the groupId of a pinned tab and leaves the rest of that group contiguous', () => {
    const groups = [group('g1')]
    const tabs = [tab('a', 'g1'), { id: 'p', groupId: 'g1', pinned: true }, tab('b', 'g1')]
    const result = normalize(tabs, groups)
    expect(result.map((t) => t.id)).toEqual(['p', 'a', 'b'])
    expect(result[0].groupId).toBeUndefined()
    expect(isContiguous(result)).toBe(true)
  })
  it('leaves an already pinned-first list untouched (same reference)', () => {
    const tabs = [pinned('p1'), tab('a')]
    expect(normalize(tabs, [])).toBe(tabs)
  })
})

describe('reorderWithGroups', () => {
  it('joins a group when dropped strictly inside its run', () => {
    // [A, B(g1), C(g1), D(g1), E] -> drag E between B and C
    const tabs = [tab('a'), tab('b', 'g1'), tab('c', 'g1'), tab('d', 'g1'), tab('e')]
    const result = reorderWithGroups(tabs, 4, 2)
    expect(result.map((t) => t.id)).toEqual(['a', 'b', 'e', 'c', 'd'])
    expect(result.find((t) => t.id === 'e')?.groupId).toBe('g1')
    expect(isContiguous(result)).toBe(true)
  })
  it('joins a group when dropped exactly at the trailing edge of its run', () => {
    const tabs = [tab('a'), tab('b', 'g1'), tab('c', 'g1'), tab('d'), tab('e')]
    const result = reorderWithGroups(tabs, 4, 3) // right after c, right before d
    expect(result.map((t) => t.id)).toEqual(['a', 'b', 'c', 'e', 'd'])
    expect(result.find((t) => t.id === 'e')?.groupId).toBe('g1')
  })
  it('joins a group when dropped exactly at the leading edge of its run', () => {
    const tabs = [tab('a'), tab('b', 'g1'), tab('c', 'g1'), tab('d')]
    const result = reorderWithGroups(tabs, 3, 1) // right before b
    expect(result.map((t) => t.id)).toEqual(['a', 'd', 'b', 'c'])
    expect(result.find((t) => t.id === 'd')?.groupId).toBe('g1')
  })
  it('leaves the tab ungrouped when dropped in open space touching no group', () => {
    // [A(g1), B(g1), C, D, E] -> drag E between C and D, clear of g1's run
    const tabs = [tab('a', 'g1'), tab('b', 'g1'), tab('c'), tab('d'), tab('e')]
    const result = reorderWithGroups(tabs, 4, 3)
    expect(result.map((t) => t.id)).toEqual(['a', 'b', 'c', 'e', 'd'])
    expect(result.find((t) => t.id === 'e')?.groupId).toBeUndefined()
  })
  it('leaves the tab ungrouped when dropped exactly on the seam between two adjacent groups', () => {
    const tabs = [tab('a', 'g1'), tab('b', 'g1'), tab('c', 'g2'), tab('d', 'g2'), tab('e')]
    const result = reorderWithGroups(tabs, 4, 2) // between g1's run and g2's run
    expect(result.map((t) => t.id)).toEqual(['a', 'b', 'e', 'c', 'd'])
    expect(result.find((t) => t.id === 'e')?.groupId).toBeUndefined()
    expect(isContiguous(result)).toBe(true) // both groups still intact either side
  })
  it('lets a tab reorder within its own group without leaving it', () => {
    const tabs = [tab('a', 'g1'), tab('b', 'g1'), tab('c', 'g1'), tab('d')]
    const result = reorderWithGroups(tabs, 0, 2) // move a to the end of its own run
    expect(result.map((t) => t.id)).toEqual(['b', 'c', 'a', 'd'])
    expect(result.find((t) => t.id === 'a')?.groupId).toBe('g1')
  })
  it('clamps an out-of-range from/insert instead of throwing', () => {
    const tabs = [tab('a'), tab('b')]
    expect(() => reorderWithGroups(tabs, -1, 0)).not.toThrow()
    expect(reorderWithGroups(tabs, -1, 0)).toBe(tabs)
    expect(() => reorderWithGroups(tabs, 99, 0)).not.toThrow()
    expect(reorderWithGroups(tabs, 99, 0)).toBe(tabs)
    expect(() => reorderWithGroups(tabs, 0, 9999)).not.toThrow()
  })
  it('does not mutate its input', () => {
    const tabs = [tab('a'), tab('b', 'g1'), tab('c', 'g1'), tab('d')]
    const snapshot = structuredClone(tabs)
    reorderWithGroups(tabs, 3, 1)
    expect(tabs).toEqual(snapshot)
  })
  // KAN-53: pinning is a state change, not a position — a drag may reorder
  // WITHIN a region but never across the boundary between them.
  it('a pinned tab dragged far right stops at the end of the pinned block', () => {
    const tabs = [pinned('p1'), pinned('p2'), tab('a'), tab('b')]
    const result = reorderWithGroups(tabs, 0, 3)
    expect(result.map((t) => t.id)).toEqual(['p2', 'p1', 'a', 'b'])
    expect(isPinnedFirst(result)).toBe(true)
  })
  it('an unpinned tab dragged to index 0 stops at the head of the unpinned region', () => {
    const tabs = [pinned('p1'), pinned('p2'), tab('a'), tab('b')]
    const result = reorderWithGroups(tabs, 3, 0)
    expect(result.map((t) => t.id)).toEqual(['p1', 'p2', 'b', 'a'])
    expect(isPinnedFirst(result)).toBe(true)
  })
  it('never tags a pinned tab with a group, even dropped at the very edge of one', () => {
    const tabs = [pinned('p1'), tab('a', 'g1'), tab('b', 'g1')]
    const result = reorderWithGroups(tabs, 0, 2)
    expect(result.find((t) => t.id === 'p1')?.groupId).toBeUndefined()
    expect(isPinnedFirst(result)).toBe(true)
    expect(isContiguous(result)).toBe(true)
  })
  it('still reorders freely within the pinned block', () => {
    const tabs = [pinned('p1'), pinned('p2'), pinned('p3'), tab('a')]
    expect(reorderWithGroups(tabs, 2, 0).map((t) => t.id)).toEqual(['p3', 'p1', 'p2', 'a'])
  })
})

describe('moveGroupRun', () => {
  const ids = (ts: Grouped[]) => ts.map((t) => t.id).join('')

  it('moves every member together and keeps their internal order', () => {
    const tabs = [tab('a'), tab('b', 'g1'), tab('c', 'g1'), tab('d')]
    expect(ids(moveGroupRun(tabs, 'g1', 2))).toBe('adbc')
  })
  it('lands the run contiguous wherever it goes', () => {
    const tabs = [tab('a'), tab('b'), tab('c', 'g1'), tab('d', 'g1'), tab('e')]
    for (let insert = 0; insert <= 3; insert++) {
      expect(isContiguous(moveGroupRun(tabs, 'g1', insert))).toBe(true)
    }
  })
  it('keeps every member in the group', () => {
    const tabs = [tab('a'), tab('b', 'g1'), tab('c', 'g1')]
    expect(moveGroupRun(tabs, 'g1', 0).filter((t) => t.groupId === 'g1')).toHaveLength(2)
  })
  it('gathers a shredded run back into one block', () => {
    const tabs = [tab('a', 'g1'), tab('b'), tab('c', 'g1')]
    expect(ids(moveGroupRun(tabs, 'g1', 1))).toBe('bac')
    expect(isContiguous(moveGroupRun(tabs, 'g1', 1))).toBe(true)
  })
  it('cannot be dropped among the pinned tabs', () => {
    const tabs = [pinned('p1'), pinned('p2'), tab('a'), tab('b', 'g1'), tab('c', 'g1')]
    const result = moveGroupRun(tabs, 'g1', 0)
    expect(ids(result)).toBe('p1p2bca')
    expect(isPinnedFirst(result)).toBe(true)
  })
  it('clamps past the end rather than throwing', () => {
    const tabs = [tab('a', 'g1'), tab('b'), tab('c')]
    expect(ids(moveGroupRun(tabs, 'g1', 99))).toBe('bca')
  })
  it('snaps OUT of another group’s span rather than shredding it', () => {
    // insert 2 is strictly inside g2's run [1,3): nearer edge is 1 (distance 1)
    // vs 3 (distance 1) — tie goes to the far edge, and either way g2 survives.
    const tabs = [tab('a'), tab('b', 'g2'), tab('c', 'g2'), tab('d', 'g1')]
    const result = moveGroupRun(tabs, 'g1', 2)
    expect(isContiguous(result)).toBe(true)
    expect(groupRun(result, 'g2')!.end - groupRun(result, 'g2')!.start).toBe(2)
  })
  it('is a no-op (same reference) for a group with no members', () => {
    const tabs = [tab('a'), tab('b')]
    expect(moveGroupRun(tabs, 'nope', 1)).toBe(tabs)
  })
})

describe('strip ordering invariant sweep', () => {
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

  it('every group stays contiguous and every pinned tab stays left after any sequence of addToGroup/removeFromGroup/setPinned/reorderWithGroups/moveGroupRun', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    const groupIds = ['g1', 'g2', 'g3']

    for (let seed = 1; seed <= 25; seed++) {
      const rand = mulberry32(seed * 7919)
      let tabs: Grouped[] = ids.map((id) => tab(id))

      for (let step = 0; step < 40; step++) {
        const op = Math.floor(rand() * 5)
        if (op === 0) {
          const id = ids[Math.floor(rand() * ids.length)]
          const gid = groupIds[Math.floor(rand() * groupIds.length)]
          tabs = addToGroup(tabs, id, gid)
        } else if (op === 1) {
          const id = ids[Math.floor(rand() * ids.length)]
          tabs = removeFromGroup(tabs, id)
        } else if (op === 2) {
          const id = ids[Math.floor(rand() * ids.length)]
          tabs = setPinned(tabs, id, rand() < 0.5)
        } else if (op === 3) {
          const gid = groupIds[Math.floor(rand() * groupIds.length)]
          tabs = moveGroupRun(tabs, gid, Math.floor(rand() * (tabs.length + 1)))
        } else {
          const from = Math.floor(rand() * tabs.length)
          const insert = Math.floor(rand() * tabs.length)
          tabs = reorderWithGroups(tabs, from, insert)
        }

        expect(isContiguous(tabs)).toBe(true)
        expect(isPinnedFirst(tabs)).toBe(true)
        expect(noPinnedMembers(tabs)).toBe(true)
        // No operation may drop or duplicate a tab.
        expect(tabs.map((t) => t.id).sort()).toEqual([...ids].sort())
      }
    }
  })
})
