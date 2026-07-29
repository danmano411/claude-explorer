import { describe, it, expect } from 'vitest'
import {
  newViewerTab, newFilesTab, newTerminalTab, toPersisted, fromPersisted, needsSpawn,
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
