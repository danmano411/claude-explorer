import { describe, it, expect } from 'vitest'
import { closeRisk, closeReason, deleteSpaceReason, type Closeable } from '../src/renderer/closeguard'
import type { PtyStatus } from '../src/shared/types'

const statusMap = (entries: Array<[string, PtyStatus]> = []) => new Map(entries)

const terminal = (
  terminalKind: 'claude' | 'shell',
  ptyId?: string,
): Closeable => ({ view: 'terminal', terminalKind, ptyId })

describe('closeRisk', () => {
  it('flags a Claude tab whose pty is running or waiting', () => {
    expect(closeRisk(terminal('claude', 'p1'), statusMap([['p1', 'running']]))).toBe('claude')
    expect(closeRisk(terminal('claude', 'p1'), statusMap([['p1', 'waiting']]))).toBe('claude')
  })

  it('clears a Claude tab once its pty has exited — the transcript is on disk', () => {
    expect(closeRisk(terminal('claude', 'p1'), statusMap([['p1', 'stopped']]))).toBe('none')
  })

  it('treats a ptyId with no status entry yet as live, not as absent', () => {
    // usePtyStatus only ever writes an entry once the pty has spoken. A pty
    // that exists and has said nothing is still a live process.
    expect(closeRisk(terminal('claude', 'p1'), statusMap())).toBe('claude')
    expect(closeRisk(terminal('shell', 'p1'), statusMap())).toBe('shell')
  })

  it('never flags a terminal tab with no ptyId at all — nothing has spawned', () => {
    // This is deliberately NOT TabBar's `status.get(t.ptyId!) ?? 'running'`
    // default: applied here it would nag on every restored, never-activated tab.
    expect(closeRisk(terminal('claude'), statusMap([['p1', 'running']]))).toBe('none')
    expect(closeRisk(terminal('shell'), statusMap([['p1', 'running']]))).toBe('none')
  })

  it('flags a live shell and clears a stopped one', () => {
    expect(closeRisk(terminal('shell', 'p1'), statusMap([['p1', 'running']]))).toBe('shell')
    expect(closeRisk(terminal('shell', 'p1'), statusMap([['p1', 'stopped']]))).toBe('none')
  })

  it('never flags files or viewer tabs, whatever the status map says', () => {
    const hot = statusMap([['p1', 'running']])
    expect(closeRisk({ view: 'files', ptyId: 'p1' }, hot)).toBe('none')
    expect(closeRisk({ view: 'viewer', ptyId: 'p1' }, hot)).toBe('none')
  })
})

describe('closeReason', () => {
  it('returns null for an empty batch or an all-safe batch — no modal at all', () => {
    expect(closeReason([])).toBeNull()
    expect(closeReason(['none', 'none'])).toBeNull()
  })

  it('names the live count in a mixed batch, not the size of the whole selection', () => {
    // 2 tabs total, only 1 of them live — the sentence must call out the 1
    // that is actually at risk, not silently reuse the batch size of 2.
    const reason = closeReason(['none', 'claude'])
    expect(reason).not.toBeNull()
    expect(reason).toMatch(/1 has a running Claude session/)
  })

  it('gives a single-tab Claude close its own sentence naming the turn and scrollback', () => {
    expect(closeReason(['claude'])).toMatch(/current turn/)
  })

  it('gives a single-tab shell close its own sentence, distinct from the Claude one', () => {
    expect(closeReason(['shell'])).toMatch(/nothing about this shell/)
  })
})

describe('deleteSpaceReason', () => {
  it('matches the pre-KAN-57 wording exactly when nothing in the space is live', () => {
    expect(deleteSpaceReason('Research', 3, [])).toBe('Delete «Research» and close its 3 tabs?')
    expect(deleteSpaceReason('Research', 3, ['none', 'none'])).toBe('Delete «Research» and close its 3 tabs?')
  })

  it('appends the live clause when the space holds a running session', () => {
    const reason = deleteSpaceReason('Research', 2, ['claude', 'none'])
    expect(reason.startsWith('Delete «Research» and close its 2 tabs?')).toBe(true)
    expect(reason).toContain('running Claude session')
  })
})
