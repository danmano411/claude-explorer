import { describe, it, expect } from 'vitest'
import { applyClaudeEvent } from '../src/renderer/claudestate'

// Deliberately parallel to test/ptystatus.test.ts, the file this one is
// modeled on (see the module doc in src/renderer/claudestate.ts).
describe('applyClaudeEvent', () => {
  it('records a reported state', () => {
    const m = applyClaudeEvent(new Map(), { id: 'a', kind: 'state', state: 'working' })
    expect(m.get('a')).toBe('working')
  })

  it('every reported state overwrites the previous one', () => {
    let m = applyClaudeEvent(new Map(), { id: 'a', kind: 'state', state: 'working' })
    m = applyClaudeEvent(m, { id: 'a', kind: 'state', state: 'awaiting-input' })
    expect(m.get('a')).toBe('awaiting-input')
    m = applyClaudeEvent(m, { id: 'a', kind: 'state', state: 'idle' })
    expect(m.get('a')).toBe('idle')
  })

  // The fold-in this whole module exists for: `CH.claudeState` never carries
  // 'stopped' (a dead process cannot POST its own death — see the CH.claudeState
  // comment in shared/ipc.ts), so this is the ONLY path that ever reaches it.
  it('an exit reaches stopped even with no prior state at all', () => {
    // The agentSpawned / no-hooks / disableAllHooks case (design doc §2.7): a
    // Claude tab that never got a single hook event still has to become
    // 'stopped' the moment its process actually exits, or it sits on "unknown"
    // forever instead of "definitely dead".
    const m = applyClaudeEvent(new Map(), { id: 'a', kind: 'exit' })
    expect(m.get('a')).toBe('stopped')
  })

  it('marks stopped on exit and a later state cannot revive it', () => {
    let m = applyClaudeEvent(new Map(), { id: 'a', kind: 'state', state: 'working' })
    m = applyClaudeEvent(m, { id: 'a', kind: 'exit' })
    expect(m.get('a')).toBe('stopped')
    // A late hook racing the exit (or replaying) must not un-kill the tab.
    m = applyClaudeEvent(m, { id: 'a', kind: 'state', state: 'idle' })
    expect(m.get('a')).toBe('stopped')
  })

  it('returns the same Map reference when nothing changes, so a consumer skips re-render', () => {
    const m1 = applyClaudeEvent(new Map(), { id: 'a', kind: 'state', state: 'working' })
    const m2 = applyClaudeEvent(m1, { id: 'a', kind: 'state', state: 'working' })
    expect(m2).toBe(m1)
  })

  it('a second pty is unaffected by the first', () => {
    let m = applyClaudeEvent(new Map(), { id: 'a', kind: 'state', state: 'awaiting-input' })
    m = applyClaudeEvent(m, { id: 'b', kind: 'exit' })
    expect(m.get('a')).toBe('awaiting-input')
    expect(m.get('b')).toBe('stopped')
  })
})
