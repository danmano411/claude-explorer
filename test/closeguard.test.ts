import { describe, it, expect } from 'vitest'
import { closeRisk, closeReason, deleteSpaceReason, moveTabReason, type Closeable, type CloseRisk } from '../src/renderer/closeguard'
import type { ClaudeState, PtyStatus } from '../src/shared/types'

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

// KAN-75. A Claude session that finished its turn and is sitting idle at the
// prompt reports 'waiting' on `status` (bytes cannot tell idle from mid-turn),
// which is exactly the false positive the ticket names: closing it warned
// "still running" when there was no turn. `claudeState`, sourced from Claude
// Code's own hooks, is what actually answers the question.
describe('closeRisk: an idle Claude session is not "still running" (KAN-75)', () => {
  const claudeMap = (entries: Array<[string, ClaudeState]> = []) => new Map(entries)

  it('clears a Claude tab whose session is idle at the prompt, even though the pty is still alive', () => {
    // The pty is 'waiting' (bytes went quiet), which is precisely the signal
    // the old code could not tell apart from a live turn.
    const status = statusMap([['p1', 'waiting']])
    expect(closeRisk(terminal('claude', 'p1'), status, claudeMap([['p1', 'idle']]))).toBe('none')
  })

  it('still flags a Claude tab mid-turn, whether working or blocked on a permission prompt', () => {
    const status = statusMap([['p1', 'running']])
    expect(closeRisk(terminal('claude', 'p1'), status, claudeMap([['p1', 'working']]))).toBe('claude')
    expect(closeRisk(terminal('claude', 'p1'), status, claudeMap([['p1', 'awaiting-input']]))).toBe('claude')
  })

  it('keeps today\'s behaviour for a Claude tab with no hook state at all — unknown is not idle', () => {
    // Covers agentSpawned workers, sessions this app did not launch, and
    // agentControl:false — none of them ever report, and none may be treated
    // as safe to close just because nothing is known.
    const status = statusMap([['p1', 'running']])
    expect(closeRisk(terminal('claude', 'p1'), status)).toBe('claude')
    expect(closeRisk(terminal('claude', 'p1'), status, claudeMap())).toBe('claude')
  })

  it('never lets claudeState leak into a shell tab\'s risk', () => {
    const status = statusMap([['p1', 'running']])
    expect(closeRisk(terminal('shell', 'p1'), status, claudeMap([['p1', 'idle']]))).toBe('shell')
  })

  it('a restored tab with no ptyId still never prompts, claudeState notwithstanding', () => {
    expect(closeRisk(terminal('claude'), statusMap(), claudeMap([['p1', 'working']]))).toBe('none')
  })

  it('a batch of only idle Claude sessions needs no confirm at all', () => {
    const risks: CloseRisk[] = [
      closeRisk(terminal('claude', 'p1'), statusMap([['p1', 'waiting']]), claudeMap([['p1', 'idle']])),
      closeRisk(terminal('claude', 'p2'), statusMap([['p2', 'waiting']]), claudeMap([['p2', 'idle']])),
    ]
    expect(risks).toEqual(['none', 'none'])
    expect(closeReason(risks)).toBeNull()
  })

  // The ticket's own acceptance criterion: deleteSpaceReason consumes the same
  // CloseRisk[], so a space full of idle sessions must stop over-warning too —
  // proof that the fix lives in closeRisk and not at a call site.
  it('a space full of idle Claude sessions gets the pre-KAN-57 wording, not a live clause', () => {
    const risks: CloseRisk[] = [
      closeRisk(terminal('claude', 'p1'), statusMap([['p1', 'waiting']]), claudeMap([['p1', 'idle']])),
      closeRisk(terminal('claude', 'p2'), statusMap([['p2', 'waiting']]), claudeMap([['p2', 'idle']])),
    ]
    expect(deleteSpaceReason('Research', 2, risks, 0)).toBe('Delete «Research» and close its 2 tabs?')
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

// KAN-66. The selectivity rule for moving a tab between spaces, in the one
// place it can be tested without a renderer. Only ONE move is questioned, and
// `null` is what makes every other one a single click.
describe('moveTabReason', () => {
  it('returns null for an ungrouped tab — no modal at all', () => {
    expect(moveTabReason(false)).toBeNull()
  })

  it('names exactly what moving a grouped tab on its own changes', () => {
    expect(moveTabReason(true)).toBe(
      'This tab will be removed from the current group and will be moved to that space.')
  })
})

describe('deleteSpaceReason', () => {
  it('matches the pre-KAN-57 wording exactly when nothing in the space is live', () => {
    expect(deleteSpaceReason('Research', 3, [], 0)).toBe('Delete «Research» and close its 3 tabs?')
    expect(deleteSpaceReason('Research', 3, ['none', 'none'], 0)).toBe('Delete «Research» and close its 3 tabs?')
  })

  it('appends the live clause when the space holds a running session', () => {
    const reason = deleteSpaceReason('Research', 2, ['claude', 'none'], 0)
    expect(reason.startsWith('Delete «Research» and close its 2 tabs?')).toBe(true)
    expect(reason).toContain('running Claude session')
  })

  // KAN-57 review (D-4). Deleting a space closes its PINNED tabs — every other
  // close route in the app refuses them, so the one route that does not has to
  // say so, in the dialog, before the click.
  it('admits that the delete will close the space\'s pinned tabs', () => {
    const reason = deleteSpaceReason('Research', 3, ['none', 'none', 'none'], 1)
    expect(reason).toBe(
      'Delete «Research» and close its 3 tabs? 1 is pinned — deleting the space closes it anyway.')
  })

  it('pluralises the pinned clause, and states it alongside the live clause', () => {
    expect(deleteSpaceReason('R', 4, [], 2)).toContain('2 are pinned — deleting the space closes them anyway.')
    const both = deleteSpaceReason('R', 2, ['claude', 'none'], 1)
    expect(both).toContain('running Claude session')
    expect(both).toContain('1 is pinned')
  })

  it('says nothing about pinning when the space holds no pinned tab', () => {
    expect(deleteSpaceReason('R', 2, ['claude', 'none'], 0)).not.toContain('pinned')
  })
})
