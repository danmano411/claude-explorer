import { describe, it, expect, vi } from 'vitest'
import type { Workspace } from '../src/shared/types'

vi.mock('electron', () => ({ app: { getPath: () => 'C:\\userData' } }))

const { sanitize, emptyWorkspace } = await import('../src/main/workspace')

const base = (): Workspace => ({
  version: 1 as const,
  groups: [{ id: 'g1', name: 'Repo', color: '#C15F3C', collapsed: false }],
  tabs: [
    { id: 't1', view: 'files' as const, cwd: 'C:\\a', title: 'a', groupId: 'g1' },
    { id: 't2', view: 'files' as const, cwd: 'C:\\b', title: 'b' },
  ],
  spaces: [{ id: 's1', name: 'Space', tabIds: ['t1', 't2'], layout: null }],
  activeSpaceId: 's1',
})

describe('sanitize', () => {
  it('passes a well-formed workspace through intact', () => {
    const w = base()
    expect(sanitize(w)).toEqual(w)
  })

  it('falls back to empty on junk, null, or a future version', () => {
    expect(sanitize(null)).toEqual(emptyWorkspace())
    expect(sanitize('nope')).toEqual(emptyWorkspace())
    expect(sanitize({ ...base(), version: 2 })).toEqual(emptyWorkspace())
  })

  // A space listing a tab that no longer exists would render a blank pane the
  // user cannot explain or close.
  it('drops space members that are not real tabs', () => {
    const w = base()
    w.spaces[0].tabIds = ['t1', 'ghost', 't2']
    expect(sanitize(w).spaces[0].tabIds).toEqual(['t1', 't2'])
  })

  // The tab is real; only the grouping is dangling. Keep the tab.
  it('keeps a tab whose group vanished, but clears the reference', () => {
    const w = { ...base(), groups: [] }
    const out = sanitize(w)
    expect(out.tabs.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(out.tabs[0].groupId).toBeUndefined()
  })

  it('drops grid cells pointing at tabs that are gone', () => {
    const w = base()
    w.spaces[0].layout = {
      cols: 2, rows: 1,
      cells: [
        { tabId: 't1', col: 0, row: 0, colSpan: 1, rowSpan: 1 },
        { tabId: 'ghost', col: 1, row: 0, colSpan: 1, rowSpan: 1 },
      ],
    }
    expect(sanitize(w).spaces[0].layout!.cells.map((c) => c.tabId)).toEqual(['t1'])
  })

  it('repairs an activeSpaceId that names no space', () => {
    expect(sanitize({ ...base(), activeSpaceId: 'gone' }).activeSpaceId).toBe('s1')
  })

  it('drops malformed tabs rather than trusting them', () => {
    const w = base()
    // @ts-expect-error deliberately malformed, as a hand-edited file would be
    w.tabs.push({ id: 42, cwd: null })
    expect(sanitize(w).tabs).toHaveLength(2)
  })

  it('never returns a workspace with zero spaces', () => {
    expect(sanitize({ ...base(), spaces: [] }).spaces.length).toBeGreaterThan(0)
  })

  // KAN-43: activeTabId is what makes a restart land on the tab you left.
  describe('activeTabId', () => {
    it('keeps one that names a member of the space', () => {
      const w = base()
      w.spaces[0].activeTabId = 't2'
      expect(sanitize(w).spaces[0].activeTabId).toBe('t2')
    })

    // Focusing a tab the space does not contain would leave a blank pane.
    it('drops one that is not in the space', () => {
      const w = base()
      w.spaces[0].activeTabId = 'ghost'
      expect(sanitize(w).spaces[0].activeTabId).toBeUndefined()
    })

    it('drops one whose tab was itself dropped as malformed', () => {
      const w = base()
      w.spaces[0].tabIds = ['t1', 't2', 'bad']
      w.spaces[0].activeTabId = 'bad'
      // @ts-expect-error deliberately malformed, as a hand-edited file would be
      w.tabs.push({ id: 'bad', cwd: null })
      expect(sanitize(w).spaces[0].activeTabId).toBeUndefined()
    })

    // A workspace.json written by v0.4.0 has no such field at all.
    it('loads a workspace that has none', () => {
      const out = sanitize(base())
      expect(out.spaces[0].activeTabId).toBeUndefined()
      expect(out.tabs).toHaveLength(2)
    })
  })

  // The full hand-edited-file case: a dead group reference AND a stray
  // activeTabId in one document. Neither may throw, and neither may leave a
  // phantom behind for the renderer to draw chrome for.
  it('repairs a dead groupId and a stray activeTabId together', () => {
    const w = { ...base(), groups: [] }
    w.spaces[0].activeTabId = 'ghost'
    const out = sanitize(w)
    expect(out.groups).toEqual([])
    expect(out.tabs.map((t) => t.groupId)).toEqual([undefined, undefined])
    expect(out.spaces[0].activeTabId).toBeUndefined()
    expect(out.spaces[0].tabIds).toEqual(['t1', 't2'])
  })

  // normalize() also gives sanitize() contiguity repair for free: a hand-edited
  // file that interleaves a group's members must not reach the TabBar, which
  // renders one strip per contiguous run and would otherwise shred the group.
  it('pulls a scattered group back into one contiguous run', () => {
    const w = base()
    w.tabs = [
      { id: 't1', view: 'files', cwd: 'C:\\a', title: 'a', groupId: 'g1' },
      { id: 't2', view: 'files', cwd: 'C:\\b', title: 'b' },
      { id: 't3', view: 'files', cwd: 'C:\\c', title: 'c', groupId: 'g1' },
    ]
    expect(sanitize(w).tabs.map((t) => t.id)).toEqual(['t1', 't3', 't2'])
  })

  // KAN-43 review D-2: normalize() above can reorder `tabs`, but a space's
  // membership list used to keep the PRE-normalize order from the raw file —
  // one document, two disagreeing orders. Invisible today (App.tsx renders
  // `tabs`, not `tabIds`), but KAN-45's switcher reads `tabIds` directly, so it
  // must agree with the order `tabs` actually ends up in.
  it('orders a space members to match the post-normalize tabs list', () => {
    const w = base()
    w.tabs = [
      { id: 't1', view: 'files', cwd: 'C:\\a', title: 'a', groupId: 'g1' },
      { id: 't2', view: 'files', cwd: 'C:\\b', title: 'b' },
      { id: 't3', view: 'files', cwd: 'C:\\c', title: 'c', groupId: 'g1' },
    ]
    w.spaces[0].tabIds = ['t1', 't2', 't3'] // pre-normalize order, as the raw file would have it
    const out = sanitize(w)
    expect(out.tabs.map((t) => t.id)).toEqual(['t1', 't3', 't2'])
    expect(out.spaces[0].tabIds).toEqual(out.tabs.map((t) => t.id))
  })

  // Same normalize() dedupe as groups.test.ts's D-3 case, exercised through the
  // main sanitize() entry point: a hand-edited file listing one tab id twice in
  // `tabIds` must not reach the renderer as two tabs sharing a React key.
  it('dedupes a space that lists the same tab id twice', () => {
    const w = base()
    w.spaces[0].tabIds = ['t1', 't2', 't2']
    expect(sanitize(w).spaces[0].tabIds).toEqual(['t1', 't2'])
  })
})

/**
 * KAN-45 review D-4: these four repairs used to live in a second normalizer in
 * src/renderer/spaces.ts, re-implementing what sanitize() already did and
 * disagreeing with it. They live here now, and only here.
 */
describe('sanitize — the spaces invariants', () => {
  const plain = (): Workspace => ({
    version: 1 as const,
    groups: [],
    tabs: [
      { id: 't1', view: 'files' as const, cwd: 'C:\\a', title: 'a' },
      { id: 't2', view: 'files' as const, cwd: 'C:\\b', title: 'b' },
      { id: 't3', view: 'files' as const, cwd: 'C:\\c', title: 'c' },
    ],
    spaces: [
      { id: 's1', name: 'One', tabIds: ['t1'], layout: null },
      { id: 's2', name: 'Two', tabIds: ['t2'], layout: null },
    ],
    activeSpaceId: 's1',
  })

  // Two owners means it renders in both spaces and PTY ownership is ambiguous:
  // closing the space that "has" it kills a process the other is still showing.
  it('gives a tab claimed by two spaces to the first one only', () => {
    const w = plain()
    w.spaces[0].tabIds = ['t1', 't2']
    w.spaces[1].tabIds = ['t2', 't3']
    const out = sanitize(w)
    expect(out.spaces[0].tabIds).toEqual(['t1', 't2'])
    expect(out.spaces[1].tabIds).toEqual(['t3'])
  })

  it('collapses two spaces sharing an id, keeping the first', () => {
    const w = plain()
    w.spaces[1].id = 's1'
    const out = sanitize(w)
    expect(out.spaces).toHaveLength(1)
    expect(out.spaces[0].name).toBe('One')
  })

  // Zero owners is the worst outcome in the feature: no UI can show the tab, so
  // a live Claude session keeps running with no way back to it and no way to
  // close it. Adoption lands it in the space the user is looking at.
  it('adopts a tab no space claims into the ACTIVE space', () => {
    const out = sanitize({ ...plain(), activeSpaceId: 's2' })
    expect(out.spaces[1].tabIds).toEqual(['t2', 't3'])
    expect(out.spaces[0].tabIds).toEqual(['t1'])
  })

  it('adopts into the first space when activeSpaceId names nothing', () => {
    const out = sanitize({ ...plain(), activeSpaceId: 'gone' })
    expect(out.activeSpaceId).toBe('s1')
    expect(out.spaces[0].tabIds).toEqual(['t1', 't3'])
  })

  it('invents a space when there are none, and every tab lands in it', () => {
    const out = sanitize({ ...plain(), spaces: [] })
    expect(out.spaces).toHaveLength(1)
    expect(out.spaces[0].tabIds).toEqual(['t1', 't2', 't3'])
    expect(out.activeSpaceId).toBe(out.spaces[0].id)
  })

  // An adopted tab may belong to a group that already has a run in that space;
  // appending it blind would split the run the TabBar draws as one strip.
  it('keeps a group contiguous after adopting an orphan into its space', () => {
    const w = plain()
    w.groups = [{ id: 'g1', name: 'Repo', color: '#C15F3C', collapsed: false }]
    w.tabs[0].groupId = 'g1'
    w.tabs[2].groupId = 'g1'
    w.spaces[0].tabIds = ['t1', 't2'] // t3 orphaned, and it is in t1's group
    w.spaces[1].tabIds = []
    expect(sanitize(w).spaces[0].tabIds).toEqual(['t1', 't3', 't2'])
  })

  // THE authority rule (see the module doc in src/renderer/spaces.ts): `tabIds`
  // defines order, `tabs` is an unordered store. Deriving membership order from
  // `tabs` instead silently undoes every reorderInSpace on the next save.
  it('believes tabIds order over the order of the global tabs array', () => {
    const w = plain()
    w.spaces[0].tabIds = ['t3', 't1']
    w.spaces[1].tabIds = ['t2']
    const out = sanitize(w)
    expect(out.spaces[0].tabIds).toEqual(['t3', 't1'])
    expect(out.tabs.map((t) => t.id)).toEqual(['t1', 't2', 't3']) // untouched, and irrelevant
  })

  it('survives a reorder round-trip, which is the point of the rule above', () => {
    const w = plain()
    w.spaces[0].tabIds = ['t1', 't3']
    w.spaces[1].tabIds = ['t2']
    const saved = sanitize(w)
    saved.spaces[0].tabIds = ['t3', 't1'] // the user dragged t3 left
    expect(sanitize(saved).spaces[0].tabIds).toEqual(['t3', 't1'])
  })

  // A cell naming a tab another space owns would paint that space's tab into
  // this one's pane — the same phantom the one-owner rule exists to prevent.
  it('drops a grid cell pointing at a tab this space does not own', () => {
    const w = plain()
    w.spaces[0].layout = {
      cols: 2, rows: 1,
      cells: [
        { tabId: 't1', col: 0, row: 0, colSpan: 1, rowSpan: 1 },
        { tabId: 't2', col: 1, row: 0, colSpan: 1, rowSpan: 1 }, // s2 owns t2
      ],
    }
    expect(sanitize(w).spaces[0].layout!.cells.map((c) => c.tabId)).toEqual(['t1'])
  })

  // The converse is NOT a defect (review finding 4): the tab strip is what makes
  // a tab reachable; the grid is placement only.
  it('leaves an adopted tab with no grid cell alone', () => {
    const w = plain()
    w.spaces[0].layout = {
      cols: 1, rows: 1,
      cells: [{ tabId: 't1', col: 0, row: 0, colSpan: 1, rowSpan: 1 }],
    }
    const out = sanitize(w)
    expect(out.spaces[0].tabIds).toEqual(['t1', 't3'])
    expect(out.spaces[0].layout!.cells.map((c) => c.tabId)).toEqual(['t1'])
  })

  // An empty space is legal — createSpace makes one, and you look at it before
  // you open anything in it. Dropping it on save loses the space outright.
  it('keeps a space with no tabs at all', () => {
    const w = plain()
    w.spaces[1].tabIds = []
    w.spaces[0].tabIds = ['t1', 't2', 't3']
    expect(sanitize(w).spaces.map((s) => s.id)).toEqual(['s1', 's2'])
  })

  // Review finding 5: the old renderer-side normalizer threw on any of these.
  // sanitize() is the guard that made that survivable, so it must really hold.
  it('is total on garbage inside the spaces array', () => {
    const w = { ...plain(), spaces: [null, { name: 'no id' }, { id: 7 }, { id: 's1', tabIds: null }] }
    expect(() => sanitize(w)).not.toThrow()
    const out = sanitize(w)
    expect(out.spaces).toHaveLength(1)
    expect(out.spaces[0].id).toBe('s1')
    expect(out.spaces[0].tabIds).toEqual(['t1', 't2', 't3']) // all adopted
  })
})

describe('sanitize — randomised garbage sweep', () => {
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

  it('restores every spaces invariant from arbitrary garbage', () => {
    const tabPool = ['t1', 't2', 't3', 't4', 'ghost1', 'ghost2']
    for (let seed = 1; seed <= 60; seed++) {
      const rand = mulberry32(seed * 104729)
      const pick = <X>(xs: readonly X[]): X => xs[Math.floor(rand() * xs.length)]

      // Deliberately broken, and broken BELOW the type level too — nulls, wrong
      // types, missing fields. That is the whole reason this sweep moved here:
      // sanitize() takes `unknown` and is the app's only guard, so "total on
      // arbitrary garbage" has to be true of THIS function, not merely of a
      // renderer helper that never saw a raw file.
      const tabs: unknown[] = []
      for (const id of tabPool) {
        if (id.startsWith('ghost') && rand() < 0.8) continue
        tabs.push(rand() < 0.15 ? { id, cwd: null } : { id, view: 'files', cwd: 'C:\\x', title: id })
      }
      if (rand() < 0.3) tabs.push(null)

      const spaces: unknown[] = []
      for (let i = 0; i < Math.floor(rand() * 5); i++) {
        const roll = rand()
        if (roll < 0.1) { spaces.push(null); continue }
        if (roll < 0.18) { spaces.push({ name: 'no id at all' }); continue }
        const tabIds: string[] = []
        for (let k = 0; k < Math.floor(rand() * 5); k++) tabIds.push(pick(tabPool))
        spaces.push({
          id: pick(['sA', 'sB', 'sC']),
          name: `space-${i}`,
          tabIds: rand() < 0.15 ? null : tabIds,
          activeTabId: rand() < 0.7 ? pick([...tabPool, 'nothing']) : undefined,
          layout:
            rand() < 0.4
              ? { cols: 2, rows: 1, cells: [{ tabId: pick(tabPool), col: 0, row: 0, colSpan: 1, rowSpan: 1 }] }
              : null,
        })
      }

      const raw = { version: 1, tabs, spaces, groups: [], activeSpaceId: pick(['sA', 'sB', 'sC', 'sZ']) }
      const out = sanitize(raw)
      const known = out.tabs.map((t) => t.id)

      expect(out.spaces.length).toBeGreaterThan(0)
      // Exactly one owner per tab: never zero (unreachable live session), never
      // two (ambiguous PTY ownership).
      const counts = new Map<string, number>()
      for (const s of out.spaces) for (const id of s.tabIds) counts.set(id, (counts.get(id) ?? 0) + 1)
      expect(counts.size).toBe(new Set(known).size)
      for (const id of known) expect(counts.get(id)).toBe(1)
      // No space remembers an active tab it does not own.
      for (const s of out.spaces) {
        if (s.activeTabId !== undefined) expect(s.tabIds).toContain(s.activeTabId)
        // No pane may show a tab this space does not own.
        for (const c of s.layout?.cells ?? []) expect(s.tabIds).toContain(c.tabId)
      }
      expect(out.spaces.some((s) => s.id === out.activeSpaceId)).toBe(true)
      expect(new Set(out.spaces.map((s) => s.id)).size).toBe(out.spaces.length)
      // Idempotent: a second pass has nothing left to fix. Also what makes the
      // read/write symmetry safe — sanitize() runs on both.
      expect(sanitize(out)).toEqual(out)
    }
  })
})
