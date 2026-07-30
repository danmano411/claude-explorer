import { describe, it, expect } from 'vitest'
import {
  newViewerTab, newFilesTab, newTerminalTab, toPersisted, fromPersisted, needsSpawn,
  closeTabList, openViewerTabList, type Tab,
} from '../src/renderer/tabs'
import type { PersistedTab } from '../src/shared/types'

describe('newViewerTab', () => {
  it('carries the file path and derives title + containing folder', () => {
    const t = newViewerTab('C:\\repo\\src\\main\\pty.ts')
    expect(t.view).toBe('viewer')
    expect(t.filePath).toBe('C:\\repo\\src\\main\\pty.ts')
    expect(t.title).toBe('pty.ts')
    expect(t.cwd).toBe('C:\\repo\\src\\main') // tab menu (Explorer/Terminal/IDE) acts here
  })

  it('defaults to file mode and accepts diff mode', () => {
    expect(newViewerTab('C:\\repo\\a.ts').viewerMode).toBe('file')
    expect(newViewerTab('C:\\repo\\a.ts', 'diff').viewerMode).toBe('diff')
  })

  it('gives every tab a distinct id', () => {
    expect(newViewerTab('C:\\a.ts').id).not.toBe(newFilesTab('C:\\').id)
  })
})

describe('persistence round trip', () => {
  it('brings a Claude terminal back, carrying the session it owns', () => {
    const t = newTerminalTab('C:\\repo', 'claude', 'pty-1', 'repo', 'sess-abc')
    const back = fromPersisted(toPersisted(t))
    expect(back).not.toBeNull()
    expect(back!.view).toBe('terminal')
    expect(back!.terminalKind).toBe('claude')
    expect(back!.sessionId).toBe('sess-abc') // the whole point: --resume this one
    expect(back!.cwd).toBe('C:\\repo')
    expect(back!.id).toBe(t.id) // ids are referenced by spaces/groups, must be stable
  })

  it('never persists ptyId, and comes back needing a process', () => {
    const t = newTerminalTab('C:\\repo', 'claude', 'pty-1', 'repo', 'sess-abc')
    // A ptyId is a handle to a process that dies with the run. Persisting one
    // would restore a pane pointing at nothing.
    expect('ptyId' in toPersisted(t)).toBe(false)
    const back = fromPersisted(toPersisted(t))!
    expect(back.ptyId).toBeUndefined()
    expect(needsSpawn(back)).toBe(true)
  })

  it('a shell terminal comes back as a shell, not as Claude', () => {
    const t = newTerminalTab('C:\\repo', 'shell', 'pty-2', 'Terminal')
    const back = fromPersisted(toPersisted(t))!
    expect(back.terminalKind).toBe('shell')
    expect(back.sessionId).toBeUndefined() // a shell has no conversation
  })

  it('keeps a custom title from being overwritten on restore', () => {
    const t = { ...newFilesTab('C:\\repo'), title: 'my notes', renamed: true }
    expect(fromPersisted(toPersisted(t))!.renamed).toBe(true)
  })

  // KAN-43: groups.ts shipped with no call sites because `Tab` had nowhere to
  // hold a groupId, so a group survived exactly until the next restart. Both
  // fromPersisted branches (terminal / everything else) build their result
  // field-by-field, which is why both are exercised here.
  it('carries groupId through persist -> restore, on a files tab', () => {
    const t = { ...newFilesTab('C:\\repo'), groupId: 'g1' }
    expect(toPersisted(t).groupId).toBe('g1')
    expect(fromPersisted(toPersisted(t))!.groupId).toBe('g1')
  })

  it('carries groupId through persist -> restore, on a terminal tab', () => {
    const t = { ...newTerminalTab('C:\\repo', 'claude', 'pty-1', 'repo', 'sess-abc'), groupId: 'g1' }
    expect(fromPersisted(toPersisted(t))!.groupId).toBe('g1')
  })

  it('leaves an ungrouped tab ungrouped', () => {
    expect(fromPersisted(toPersisted(newFilesTab('C:\\repo')))!.groupId).toBeUndefined()
  })

  // KAN-53, same failure mode as the groupId cases above: both fromPersisted
  // branches build their result field-by-field, so a pin would survive until
  // the next restart and no further if either one forgot the field.
  it('carries pinned through persist -> restore, on a files tab', () => {
    const t = { ...newFilesTab('C:\\repo'), pinned: true }
    expect(toPersisted(t).pinned).toBe(true)
    expect(fromPersisted(toPersisted(t))!.pinned).toBe(true)
  })

  it('carries pinned through persist -> restore, on a terminal tab', () => {
    const t = { ...newTerminalTab('C:\\repo', 'claude', 'pty-1', 'repo', 'sess-abc'), pinned: true }
    expect(fromPersisted(toPersisted(t))!.pinned).toBe(true)
  })

  it('leaves an unpinned tab unpinned', () => {
    expect(fromPersisted(toPersisted(newFilesTab('C:\\repo')))!.pinned).toBeUndefined()
  })

  it('round-trips a viewer tab with its mode', () => {
    const back = fromPersisted(toPersisted(newViewerTab('C:\\repo\\a.ts', 'diff')))!
    expect(back.view).toBe('viewer')
    expect(back.filePath).toBe('C:\\repo\\a.ts')
    expect(back.viewerMode).toBe('diff')
  })
})

describe('fromPersisted refuses tabs it cannot rebuild', () => {
  // workspace.json is a plain file a user can hand-edit, and sanitize() in main
  // only guarantees structural sanity — not that a tab is renderable.
  it('drops a terminal tab with no cwd (it could only spawn somewhere arbitrary)', () => {
    expect(fromPersisted({
      id: 'a', view: 'terminal', cwd: '', title: 't', terminalKind: 'claude',
    })).toBeNull()
  })

  it('drops a viewer tab with no file to show', () => {
    expect(fromPersisted({ id: 'a', view: 'viewer', cwd: 'C:\\repo', title: 't' })).toBeNull()
  })

  it('assumes Claude for a terminal written before terminalKind existed', () => {
    // Forward compatibility with a workspace.json from an earlier build: a
    // terminal tab with no kind was a Claude tab, because shells came later.
    const old = { id: 'a', view: 'terminal', cwd: 'C:\\repo', title: 'repo' } as PersistedTab
    expect(fromPersisted(old)!.terminalKind).toBe('claude')
  })

  it('survives a session id that is simply absent', () => {
    const back = fromPersisted({
      id: 'a', view: 'terminal', cwd: 'C:\\repo', title: 'repo', terminalKind: 'claude',
    })!
    expect(back.sessionId).toBeUndefined()
    expect(needsSpawn(back)).toBe(true) // still gets a fresh Claude, just not resumed
  })
})

describe('needsSpawn', () => {
  it('is false once the tab has a process', () => {
    expect(needsSpawn(newTerminalTab('C:\\r', 'claude', 'pty-1', 'r'))).toBe(false)
  })

  it('is false for panes that never had one', () => {
    expect(needsSpawn(newFilesTab('C:\\r'))).toBe(false)
    expect(needsSpawn(newViewerTab('C:\\r\\a.ts'))).toBe(false)
  })
})

// KAN-37: closeTab used to compute `remaining` from the enclosing closure's
// `tabs`, so several closeTab calls dispatched before React re-renders each
// filtered the *same* stale array — only the last call's write stuck, and
// every tab "closed" by an earlier call in the batch came back. closeTabList
// is what setTabs's functional form now calls: `setTabs((ts) =>
// closeTabList(ts, id))`. React threads a functional update's result into
// the next queued one, so the fix is proven by applying closeTabList
// straight to its own prior output — exactly what React does, and exactly
// what the old closure-capturing code did not.
describe('closeTabList', () => {
  it('threads five back-to-back closes against 8 tabs down to exactly 3', () => {
    const eight = Array.from({ length: 8 }, (_, i) => newFilesTab(`C:\\t${i}`))
    const closeIds = eight.slice(0, 5).map((t) => t.id)
    const result = closeIds.reduce((ts, id) => closeTabList(ts, id), eight)
    expect(result).toHaveLength(3)
    expect(result.map((t) => t.id)).toEqual(eight.slice(5).map((t) => t.id))
  })

  it('leaves the list untouched when the id is not present', () => {
    const three = Array.from({ length: 3 }, (_, i) => newFilesTab(`C:\\t${i}`))
    expect(closeTabList(three, 'no-such-id')).toHaveLength(3)
  })
})

// KAN-37: openViewerTab's "already open?" check had the same shape — it read
// `tabs` from the closure, so two openViewerTab calls for the same file
// issued back to back both missed each other's not-yet-committed tab and
// both appended, producing two viewer tabs for one file. openViewerTabList
// is what the functional setTabs updater now calls; feeding the second
// call's own prior output (its own output, same as React would) proves the
// dedupe now sees the first call's tab.
describe('openViewerTabList', () => {
  it('two back-to-back opens of the same file dedupe to a single viewer tab', () => {
    const first = openViewerTabList([], 'C:\\repo\\a.ts', 'file')
    const second = openViewerTabList(first.tabs, 'C:\\repo\\a.ts', 'file')
    const viewers = second.tabs.filter(
      (t) => t.view === 'viewer' && t.filePath === 'C:\\repo\\a.ts',
    )
    expect(viewers).toHaveLength(1)
    expect(second.id).toBe(first.id) // second call re-selects the same tab, doesn't create one
  })

  it('a different file, or a different mode on the same file, gets its own tab', () => {
    const a = openViewerTabList([], 'C:\\repo\\a.ts', 'file')
    const b = openViewerTabList(a.tabs, 'C:\\repo\\b.ts', 'file')
    expect(b.tabs).toHaveLength(2)
    const diff = openViewerTabList(b.tabs, 'C:\\repo\\a.ts', 'diff')
    expect(diff.tabs).toHaveLength(3)
  })

  // KAN-47: a viewer opened from a tab inside group G joins G, at G's right
  // edge — reusing addToGroup's "tag + relocate" rather than reimplementing
  // insertion here.
  describe('sourceGroupId (KAN-47 auto-link)', () => {
    it('a fresh viewer joins the source group at its right edge', () => {
      const grouped: Tab[] = [
        { ...newFilesTab('C:\\repo'), groupId: 'g1' },
        { ...newFilesTab('C:\\repo\\sub'), groupId: 'g1' },
        newFilesTab('C:\\other'), // loose, sits after the group
      ]
      const { tabs, id } = openViewerTabList(grouped, 'C:\\repo\\a.ts', 'file', 'g1')
      expect(tabs.map((t) => t.groupId)).toEqual(['g1', 'g1', 'g1', undefined])
      expect(tabs[2].id).toBe(id) // landed right after the run, still before the loose tab
    })

    it('no sourceGroupId leaves the new tab ungrouped at the far end (unchanged default)', () => {
      const grouped: Tab[] = [{ ...newFilesTab('C:\\repo'), groupId: 'g1' }]
      const { tabs } = openViewerTabList(grouped, 'C:\\repo\\a.ts', 'file')
      expect(tabs.at(-1)!.groupId).toBeUndefined()
    })

    it('re-focusing an already-open viewer never relocates it, even with a different sourceGroupId', () => {
      const first = openViewerTabList([{ ...newFilesTab('C:\\repo'), groupId: 'g1' }], 'C:\\repo\\a.ts', 'file')
      const before = first.tabs
      const second = openViewerTabList(before, 'C:\\repo\\a.ts', 'file', 'g1')
      expect(second.tabs).toBe(before) // same reference: the dedupe path, no move
      expect(second.id).toBe(first.id)
    })
  })
})
