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
})
