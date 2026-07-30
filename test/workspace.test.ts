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
