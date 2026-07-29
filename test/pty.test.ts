import { describe, it, expect, vi, beforeEach } from 'vitest'

// node-pty ships a native binary and actually launches processes; the point here
// is what we *ask* it for, so record the calls instead.
const spawned: { file: string; args: string[]; opts: any }[] = []
vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[], opts: any) => {
    spawned.push({ file, args, opts })
    return {
      onData: () => {},
      onExit: () => {},
      write: () => {},
      resize: () => {},
      kill: () => {},
    }
  },
}))

const { PtyManager, launchEnv } = await import('../src/main/pty')

const noop = () => {}
beforeEach(() => { spawned.length = 0 })

describe('launchEnv', () => {
  it('drops the marker that makes a spawned Claude a non-persisting child session', () => {
    // The bug this exists for: Claude Explorer launched from inside a Claude
    // session inherits CLAUDE_CODE_CHILD_SESSION, and every session it spawns
    // then silently saves no transcript — so Open Recent and restore-on-restart
    // both find nothing, with only a one-line in-pane warning to explain it.
    const env = launchEnv({
      PATH: 'C:\\Windows',
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'abc',
      CLAUDE_CODE_BRIDGE_SESSION_ID: 'session_x',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_PID: '1234',
    })
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined()
    expect(env.CLAUDECODE).toBeUndefined()
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined()
    expect(env.CLAUDE_CODE_BRIDGE_SESSION_ID).toBeUndefined()
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
    expect(env.CLAUDE_PID).toBeUndefined()
    expect(env.PATH).toBe('C:\\Windows') // everything else is untouched
  })

  it('keeps deliberate Claude Code configuration', () => {
    // Why the strip list is named rather than a CLAUDE_CODE_* prefix sweep:
    // these are the user's settings, not the parent session's identity.
    const env = launchEnv({
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192',
      ANTHROPIC_MODEL: 'claude-opus-5',
      CLAUDE_CODE_CHILD_SESSION: '1',
    })
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1')
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('8192')
    expect(env.ANTHROPIC_MODEL).toBe('claude-opus-5')
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined()
  })

  it('omits unset variables rather than passing undefined through', () => {
    expect('NOPE' in launchEnv({ NOPE: undefined, YES: 'y' })).toBe(false)
  })
})

describe('PtyManager.spawn env', () => {
  it('scrubs the inherited session marker for a Claude session', () => {
    process.env.CLAUDE_CODE_CHILD_SESSION = '1'
    new PtyManager().spawn({ path: 'C:\\repo' }, noop, noop)
    expect(spawned).toHaveLength(1)
    expect(spawned[0].opts.env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined()
    delete process.env.CLAUDE_CODE_CHILD_SESSION
  })

  it('scrubs it for a shell tab too — the user may type `claude` in there', () => {
    process.env.CLAUDE_CODE_CHILD_SESSION = '1'
    new PtyManager().spawn({ path: 'C:\\repo', shell: true }, noop, noop)
    expect(spawned[0].opts.env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined()
    delete process.env.CLAUDE_CODE_CHILD_SESSION
  })
})

describe('PtyManager.spawn flags', () => {
  const argsOf = (i = 0) => spawned[i].args

  it('names a new conversation with --session-id so it can be resumed later', () => {
    new PtyManager().spawn({ path: 'C:\\repo', sessionId: 'sess-1' }, noop, noop)
    expect(argsOf()).toContain('--session-id')
    expect(argsOf()[argsOf().indexOf('--session-id') + 1]).toBe('sess-1')
  })

  it('resumes an existing conversation with --resume', () => {
    new PtyManager().spawn({ path: 'C:\\repo', resumeId: 'sess-1' }, noop, noop)
    expect(argsOf()).toContain('--resume')
    expect(argsOf()).not.toContain('--session-id')
  })

  it('prefers --resume when both are given: the transcript already exists', () => {
    // claude rejects --session-id for an id that already has a transcript, so
    // these two can never be passed together.
    new PtyManager().spawn({ path: 'C:\\repo', resumeId: 'a', sessionId: 'a' }, noop, noop)
    expect(argsOf()).toContain('--resume')
    expect(argsOf()).not.toContain('--session-id')
  })

  it('passes no session flags at all when neither is given', () => {
    new PtyManager().spawn({ path: 'C:\\repo' }, noop, noop)
    expect(argsOf().filter((a) => a.startsWith('--session') || a === '--resume')).toEqual([])
  })

  it('spawns the folder as cwd', () => {
    new PtyManager().spawn({ path: 'C:\\repo\\sub' }, noop, noop)
    expect(spawned[0].opts.cwd).toBe('C:\\repo\\sub')
  })
})
