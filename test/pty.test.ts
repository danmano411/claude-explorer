import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// node-pty ships a native binary and actually launches processes; the point here
// is what we *ask* it for, so record the calls instead. `args` is an argv ARRAY
// on the .exe branch and a single cmd.exe command-line STRING on the .cmd
// branch — claudeArgv() below normalises the two.
const spawned: { file: string; args: string[] | string; opts: any }[] = []
// The exit listener spawn() registers, kept rather than dropped: a process
// ending on its own is the OTHER site that has to forget a session (kill() is
// the tab-closing one), and a test cannot fire an exit it was never handed.
const exitCbs: ((e: { exitCode: number }) => void)[] = []
// KAN-70. Real node-pty THROWS from resize() once the native ConPTY callback
// has set its exit code — which is ~1s BEFORE it fires the JS onExit that
// removes our handle. This flag models that gap, and nothing else can: the
// handle has to still be in the map, so firing exitCbs would measure the wrong
// thing (once the handle is gone, `?.` already makes resize a no-op).
// `resizes` records the ones that got through, so the guard can be shown to be
// a guard and not a blanket no-op — an assertion that only checks "did not
// throw" passes just as happily against a resize() that does nothing at all.
const ptyFake = { resizeThrows: false, resizes: [] as [number, number][] }
vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[] | string, opts: any) => {
    spawned.push({ file, args, opts })
    return {
      onData: () => {},
      onExit: (cb: (e: { exitCode: number }) => void) => { exitCbs.push(cb) },
      write: () => {},
      resize: (cols: number, rows: number) => {
        // Real node-pty throws instead of resizing, so record nothing here.
        if (ptyFake.resizeThrows) throw new Error('Cannot resize a pty that has already exited')
        ptyFake.resizes.push([cols, rows])
      },
      kill: () => {},
    }
  },
}))

/**
 * WHICH BRANCH RUNS IS THE TEST'S DECISION, NOT THE MACHINE'S.
 *
 * resolveClaude() picks between two very different spawns by scanning PATH with
 * existsSync: a real `claude.exe` (the installer) is spawned directly with an
 * argv array, while a `claude.cmd` shim (an npm-global `npm i -g
 * @anthropic-ai/claude-code` install) has to go through COMSPEC and is handed
 * ONE command-line string that cmd.exe parses by its own rules. Before this
 * mock, the branch was whatever the developer happened to have installed — so
 * these tests passed on an .exe machine and failed on a .cmd one, which is
 * precisely the machine the .cmd branch exists for.
 *
 * Stub existsSync instead, and load the module twice: every block below names
 * the branch it measures, and the flag assertions run against BOTH.
 */
const fake = vi.hoisted(() => ({ ext: '.exe' as '.exe' | '.cmd' }))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  const existsSync = (p: unknown) => String(p).endsWith(`claude${fake.ext}`)
  return { ...real, existsSync, default: { ...real, existsSync } }
})

// resolveClaude() returns a bare `claude` off win32, which would collapse both
// branches into one. This app is Windows-only; pin it so the file measures the
// same thing wherever it is run.
Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

// A space in the directory, because that is the shape that matters: an
// npm-global shim lands under `C:\Users\First Last\AppData\Roaming\npm`.
const BIN = 'C:\\fake bin'
const REAL_PATH = process.env.PATH

async function loadPty(ext: '.exe' | '.cmd') {
  fake.ext = ext
  process.env.PATH = BIN
  vi.resetModules() // resolveClaude() runs once, at import time
  return await import('../src/main/pty')
}

const EXE = await loadPty('.exe')
const CMD = await loadPty('.cmd')
process.env.PATH = REAL_PATH

const BRANCHES = [
  { kind: 'claude.exe', mod: EXE, file: /claude\.exe$/, batch: false },
  { kind: 'claude.cmd shim', mod: CMD, file: /cmd\.exe$/i, batch: true },
]

const noop = () => {}
// A real Claude session id — the shape of a `<uuid>.jsonl` transcript name.
const UUID = '11111111-2222-4333-8444-555555555555'
beforeEach(() => {
  spawned.length = 0; exitCbs.length = 0
  ptyFake.resizeThrows = false; ptyFake.resizes.length = 0
})

/**
 * The claude argv spawn() asked for, whichever branch built it: the array as
 * given on the .exe branch, and the cmd.exe tail parsed back into argv on the
 * .cmd branch. So one assertion measures one behaviour on both.
 *
 * Parsing is the cmd.exe rule batchCommandLine targets — strip the outer pair,
 * then split on whitespace outside quotes — so a tail that would reach claude
 * as the wrong number of arguments cannot round-trip through here intact.
 */
function claudeArgv(rec = spawned[0]): string[] {
  if (Array.isArray(rec.args)) return rec.args
  const m = /^\/c "([\s\S]+)"$/.exec(rec.args)
  if (!m) throw new Error(`not a cmd.exe command line: ${rec.args}`)
  const toks = m[1].match(/"[^"]*"|\S+/g) ?? []
  return toks.slice(1).map((t) => t.replace(/^"([\s\S]*)"$/, '$1')) // [0] is the shim
}

describe('launchEnv', () => {
  it('drops the marker that makes a spawned Claude a non-persisting child session', () => {
    // The bug this exists for: Claude Explorer launched from inside a Claude
    // session inherits CLAUDE_CODE_CHILD_SESSION, and every session it spawns
    // then silently saves no transcript — so Open Recent and restore-on-restart
    // both find nothing, with only a one-line in-pane warning to explain it.
    const env = EXE.launchEnv({
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
    const env = EXE.launchEnv({
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
    expect('NOPE' in EXE.launchEnv({ NOPE: undefined, YES: 'y' })).toBe(false)
  })
})

describe('PtyManager.spawn env', () => {
  it('scrubs the inherited session marker for a Claude session', () => {
    process.env.CLAUDE_CODE_CHILD_SESSION = '1'
    new EXE.PtyManager().spawn({ path: 'C:\\repo' }, noop, noop)
    expect(spawned).toHaveLength(1)
    expect(spawned[0].opts.env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined()
    delete process.env.CLAUDE_CODE_CHILD_SESSION
  })

  it('scrubs it for a shell tab too — the user may type `claude` in there', () => {
    process.env.CLAUDE_CODE_CHILD_SESSION = '1'
    new EXE.PtyManager().spawn({ path: 'C:\\repo', shell: true }, noop, noop)
    expect(spawned[0].opts.env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined()
    delete process.env.CLAUDE_CODE_CHILD_SESSION
  })
})

describe.each(BRANCHES)('PtyManager.spawn flags ($kind)', ({ mod, file, batch }) => {
  it('takes the branch this block names, whatever is installed on this machine', () => {
    // The block below is worthless if both copies resolved to the same install:
    // that is how the .cmd branch went untested until it broke the suite.
    new mod.PtyManager().spawn({ path: 'C:\\repo' }, noop, noop)
    expect(spawned[0].file).toMatch(file)
    expect(typeof spawned[0].args === 'string').toBe(batch)
  })

  it('names a new conversation with --session-id so it can be resumed later', () => {
    new mod.PtyManager().spawn({ path: 'C:\\repo', sessionId: UUID }, noop, noop)
    const argv = claudeArgv()
    expect(argv).toContain('--session-id')
    expect(argv[argv.indexOf('--session-id') + 1]).toBe(UUID)
  })

  it('resumes an existing conversation with --resume', () => {
    new mod.PtyManager().spawn({ path: 'C:\\repo', resumeId: UUID }, noop, noop)
    const argv = claudeArgv()
    expect(argv).toContain('--resume')
    expect(argv[argv.indexOf('--resume') + 1]).toBe(UUID)
    expect(argv).not.toContain('--session-id')
  })

  it('prefers --resume when both are given: the transcript already exists', () => {
    // claude rejects --session-id for an id that already has a transcript, so
    // these two can never be passed together.
    new mod.PtyManager().spawn({ path: 'C:\\repo', resumeId: UUID, sessionId: UUID }, noop, noop)
    expect(claudeArgv()).toContain('--resume')
    expect(claudeArgv()).not.toContain('--session-id')
  })

  it('passes no session flags at all when neither is given', () => {
    new mod.PtyManager().spawn({ path: 'C:\\repo' }, noop, noop)
    expect(claudeArgv().filter((a) => a.startsWith('--session') || a === '--resume')).toEqual([])
  })

  it('spawns the folder as cwd', () => {
    new mod.PtyManager().spawn({ path: 'C:\\repo\\sub' }, noop, noop)
    expect(spawned[0].opts.cwd).toBe('C:\\repo\\sub')
  })
})

/**
 * KAN-40. The .cmd branch is no longer "the array, via cmd" — it builds a
 * command line by hand (batchCommandLine), because cmd.exe /c does NOT re-parse
 * its tail by CreateProcess rules: unless the tail holds EXACTLY two quotes
 * around an executable, cmd strips the FIRST and LAST quote on the line and runs
 * what is left. `--mcp-config "<userData>\…json"` put a third and fourth quote
 * on that line, so the quoting below is what makes the shim branch launch at
 * all. That is real logic with real rules, so it gets its own measurements.
 */
describe('the claude.cmd command line', () => {
  // Both come from the Windows account name, which is the whole trigger: it is
  // in the userData path AND in an npm-global shim path. Deliberately separate
  // cases — the space one is quoted by any rule (node-pty's own included), so
  // only the metacharacter one can tell a correct rule from a lax one.
  const SPACED = 'C:\\Users\\First Last\\AppData\\Roaming\\Claude Explorer\\mcp-agent-control.json'
  const AMPED = 'C:\\Users\\Dan&Sam\\AppData\\Roaming\\claude-explorer\\mcp-agent-control.json'
  afterEach(() => { EXE.setMcpInjection(null); CMD.setMcpInjection(null) })

  const line = () => spawned[0].args as string

  /** What cmd.exe is left reading as SYNTAX: its documented "strip the first and
   *  last quote on the line" rule applied, then every quoted span removed. Any
   *  operator character surviving in here is one cmd.exe will act on. */
  const unquotedTail = (cl: string) =>
    cl.replace(/^\/c "/, '').replace(/"$/, '').replace(/"[^"]*"/g, '')

  it('wraps the whole tail in the extra quote pair cmd.exe strips', () => {
    new CMD.PtyManager().spawn({ path: 'C:\\repo', resumeId: UUID }, noop, noop)
    // /c ""C:\fake bin\claude.cmd" --resume <uuid>"  — the outer pair is what
    // cmd removes, leaving a correctly quoted shim path behind.
    expect(line()).toMatch(/^\/c ""[^"]+claude\.cmd"/)
    expect(line().endsWith('"')).toBe(true)
  })

  it('quotes a --mcp-config path containing a space, so claude sees one argument', () => {
    CMD.setMcpInjection({ configPath: SPACED, token: 't' })
    new CMD.PtyManager().spawn({ path: 'C:\\repo', resumeId: UUID }, noop, noop)
    expect(line()).toContain(`"${SPACED}"`)
    expect(claudeArgv()).toEqual(['--resume', UUID, '--mcp-config', SPACED])
  })

  it('leaves cmd.exe no `&` to read as a second command', () => {
    // node-pty's own argsToCommandLine quotes only on a space/tab, so a
    // "let node-pty do the quoting" regression loses exactly this path: cmd
    // truncates the line at the & and runs the remainder as a command.
    CMD.setMcpInjection({ configPath: AMPED, token: 't' })
    new CMD.PtyManager().spawn({ path: 'C:\\repo', resumeId: UUID }, noop, noop)
    expect(line()).toContain(`"${AMPED}"`)
    expect(unquotedTail(line())).not.toMatch(/[&|^<>]/)
    expect(claudeArgv()).toEqual(['--resume', UUID, '--mcp-config', AMPED])
  })

  it('asks for exactly the argv the .exe branch asks for', () => {
    for (const m of [EXE, CMD]) m.setMcpInjection({ configPath: SPACED, token: 't' })
    new EXE.PtyManager().spawn({ path: 'C:\\repo', sessionId: UUID }, noop, noop)
    new CMD.PtyManager().spawn({ path: 'C:\\repo', sessionId: UUID }, noop, noop)
    expect(claudeArgv(spawned[1])).toEqual(claudeArgv(spawned[0]))
    expect(claudeArgv(spawned[0])).toEqual(['--session-id', UUID, '--mcp-config', SPACED])
  })

  it('runs the shim through COMSPEC and passes claude nothing extra of its own', () => {
    new CMD.PtyManager().spawn({ path: 'C:\\repo' }, noop, noop)
    expect(spawned[0].file).toBe(process.env.COMSPEC || 'cmd.exe')
    expect(line()).toMatch(/^\/c ""[^"]+claude\.cmd""$/) // no args, still wrapped
  })
})

/**
 * KAN-41's recursion guard: a session the MCP tool asked for gets NO
 * --mcp-config and NO bearer token — otherwise the child inherits the same
 * tool and the same credential, and fan-out is unbounded. ONE local
 * (`agentControl`) feeds both the argv site and the env site in pty.ts, so the
 * risk this covers is gating one and leaving the other — the token surviving
 * in `opts.env` while the flag is merely missing from argv.
 */
describe.each(BRANCHES)('KAN-41 recursion guard ($kind)', ({ mod }) => {
  const CONFIG = 'C:\\Users\\x\\AppData\\Roaming\\claude-explorer\\mcp-agent-control.json'
  const TOKEN = 'SECRET-BEARER-TOKEN-abc123'
  afterEach(() => mod.setMcpInjection(null))

  it('gives an agentSpawned session --strict-mcp-config and neither --mcp-config nor the token', () => {
    mod.setMcpInjection({ configPath: CONFIG, token: TOKEN })
    new mod.PtyManager().spawn({ path: 'C:\\repo', agentSpawned: true }, noop, noop)
    const argv = claudeArgv()
    expect(argv).toContain('--strict-mcp-config')
    expect(argv).not.toContain('--mcp-config')
    expect(argv).not.toContain(CONFIG)
    // Scan the WHOLE env object, not just the two known keys — a leak under a
    // different name would otherwise pass silently.
    expect(JSON.stringify(spawned[0].opts.env)).not.toContain(TOKEN)
    expect(spawned[0].opts.env.CLAUDE_EXPLORER_MCP_TOKEN).toBeUndefined()
    expect(spawned[0].opts.env.CLAUDE_EXPLORER_PTY_ID).toBeUndefined()
  })

  it('still gives a normal (non-agent) spawn --mcp-config and the token, and no --strict-mcp-config', () => {
    mod.setMcpInjection({ configPath: CONFIG, token: TOKEN })
    new mod.PtyManager().spawn({ path: 'C:\\repo' }, noop, noop)
    const argv = claudeArgv()
    expect(argv).toContain('--mcp-config')
    expect(argv).toContain(CONFIG)
    expect(argv).not.toContain('--strict-mcp-config')
    expect(spawned[0].opts.env.CLAUDE_EXPLORER_MCP_TOKEN).toBe(TOKEN)
  })

  it('counts an agentSpawned session in agentSessions(), and drops it on kill()', () => {
    const mgr = new mod.PtyManager()
    const agentId = mgr.spawn({ path: 'C:\\repo', agentSpawned: true }, noop, noop)
    mgr.spawn({ path: 'C:\\repo' }, noop, noop) // a normal session must not count
    expect(mgr.agentSessions()).toBe(1)
    mgr.kill(agentId)
    expect(mgr.agentSessions()).toBe(0)
  })

  // The cap's other decrement site. kill() is what closing a tab does and is
  // covered above; this is Claude ending BY ITSELF — /exit, a crash, the model
  // finishing — with no kill() anywhere. Nothing else in the tree decrements,
  // so if the handle survives its own process the cap creeps up until the tool
  // is permanently refusing, and the user's only cure is restarting the app.
  it('drops an agentSpawned session from the cap when its PROCESS exits, with no kill()', () => {
    const mgr = new mod.PtyManager()
    mgr.spawn({ path: 'C:\\repo', agentSpawned: true }, noop, noop)
    expect(mgr.agentSessions()).toBe(1)
    exitCbs.at(-1)!({ exitCode: 0 })
    expect(mgr.agentSessions()).toBe(0)
  })

  it('never counts a shell tab toward the cap, even when asked for agentSpawned', () => {
    const mgr = new mod.PtyManager()
    mgr.spawn({ path: 'C:\\repo', shell: true, agentSpawned: true }, noop, noop)
    expect(mgr.agentSessions()).toBe(0)
  })
})

/**
 * KAN-67. launchEnv() copied the whole parent environment and filtered only
 * INHERITED_SESSION_VARS, which did not include CLAUDE_EXPLORER_MCP_TOKEN or
 * CLAUDE_EXPLORER_PTY_ID — Claude Explorer's OWN bearer token and pty id. So
 * launching the app from inside one of its own Claude terminals (`npm run dev`
 * in a Claude tab, the CLI invoked from a Claude session, a shell tab
 * launching the packaged app) put that token in process.env for the whole
 * process, and every pty it then spawned inherited it: a shell tab (which is
 * documented to get neither var) and an agentSpawned worker (KAN-41's
 * recursion guard withholds --mcp-config, but inheritance handed the token
 * back regardless).
 *
 * These set the two vars directly in process.env rather than relying on
 * whatever the test RUNNER's own parent env happens to hold, so the case is
 * exercised deterministically no matter who launched `npm test`. The value
 * is deliberately different from any legitimately-injected token, so a normal
 * session receiving the STALE value instead of its own would still fail.
 */
describe('KAN-67: launchEnv strips this app’s own session identity', () => {
  const STALE_TOKEN = 'STALE-INHERITED-TOKEN-xyz'
  const STALE_PTY_ID = 'stale-inherited-pty-id'
  const CONFIG = 'C:\\Users\\x\\AppData\\Roaming\\claude-explorer\\mcp-agent-control.json'
  const REAL_TOKEN = 'REAL-BEARER-TOKEN-abc123'

  beforeEach(() => {
    process.env.CLAUDE_EXPLORER_MCP_TOKEN = STALE_TOKEN
    process.env.CLAUDE_EXPLORER_PTY_ID = STALE_PTY_ID
  })
  afterEach(() => {
    delete process.env.CLAUDE_EXPLORER_MCP_TOKEN
    delete process.env.CLAUDE_EXPLORER_PTY_ID
    EXE.setMcpInjection(null)
  })

  it('a shell tab spawned from a nested launch has neither var', () => {
    new EXE.PtyManager().spawn({ path: 'C:\\repo', shell: true }, noop, noop)
    expect(spawned[0].opts.env.CLAUDE_EXPLORER_MCP_TOKEN).toBeUndefined()
    expect(spawned[0].opts.env.CLAUDE_EXPLORER_PTY_ID).toBeUndefined()
  })

  it('an agentSpawned session from a nested launch still has no token', () => {
    EXE.setMcpInjection({ configPath: CONFIG, token: REAL_TOKEN })
    new EXE.PtyManager().spawn({ path: 'C:\\repo', agentSpawned: true }, noop, noop)
    expect(spawned[0].opts.env.CLAUDE_EXPLORER_MCP_TOKEN).toBeUndefined()
    expect(spawned[0].opts.env.CLAUDE_EXPLORER_PTY_ID).toBeUndefined()
  })

  it('a normal (non-agent) session from a nested launch still receives ITS OWN token, not the stale inherited one', () => {
    EXE.setMcpInjection({ configPath: CONFIG, token: REAL_TOKEN })
    const id = new EXE.PtyManager().spawn({ path: 'C:\\repo' }, noop, noop)
    expect(spawned[0].opts.env.CLAUDE_EXPLORER_MCP_TOKEN).toBe(REAL_TOKEN)
    expect(spawned[0].opts.env.CLAUDE_EXPLORER_MCP_TOKEN).not.toBe(STALE_TOKEN)
    expect(spawned[0].opts.env.CLAUDE_EXPLORER_PTY_ID).toBe(id)
    expect(spawned[0].opts.env.CLAUDE_EXPLORER_PTY_ID).not.toBe(STALE_PTY_ID)
  })
})

// KAN-39: the two ids are the only caller-influenced values that reach ARGV, and
// a control-channel caller (KAN-40's MCP server) picks them. node-pty builds the
// Win32 command line itself and quotes narrowly: `argsToCommandLine`
// (node_modules/node-pty/lib/windowsPtyAgent.js) quotes an argument only when it
// is EMPTY or contains a space/tab, so `&`, `|`, `^`, `>` go out BARE — and when
// resolveClaude() lands on a .cmd shim (an npm-global install of Claude Code is
// one) that line runs through COMSPEC, where cmd.exe reads them as operators.
// `--resume abc&calc` then launches calc.
//
// So what is asserted is the REFUSAL: a typed throw and an empty `spawned`, i.e.
// nothing reached node-pty and therefore nothing reached the command line.
// Asserting that a regex answered false would prove nothing about that.
describe.each(BRANCHES)('spawn refuses an id that is not a Claude session id ($kind)', ({ mod }) => {
  // Two explicit literals rather than a computed key, so this stays type-checked
  // against the real spawn signature.
  const spawnWith = (key: 'resumeId' | 'sessionId', v: string) =>
    new mod.PtyManager().spawn(
      key === 'resumeId' ? { path: 'C:\\repo', resumeId: v } : { path: 'C:\\repo', sessionId: v },
      noop,
      noop,
    )

  const PAYLOADS: [string, string][] = [
    ['a cmd.exe command separator', 'abc&calc'],
    ['a pipe', 'x|whoami'],
    ["cmd.exe's escape character", 'a^b'],
    ['a redirect', 'a>C:\\Windows\\Temp\\pwned.txt'],
    // node-pty DOES quote this one, so cmd would see a single argument: it is
    // refused for naming no transcript, not for its quoting.
    ['a space', 'sess 1'],
    ['the empty string', ''],
    ['a real uuid with a payload welded on', `${UUID}&calc`],
    ['something absurdly long', 'a'.repeat(64 * 1024)],
  ]

  for (const [what, payload] of PAYLOADS) {
    it(`refuses ${what} on both id flags, spawning nothing`, () => {
      for (const key of ['resumeId', 'sessionId'] as const) {
        expect(() => spawnWith(key, payload)).toThrow(mod.PtyArgError)
        expect(spawned).toEqual([]) // never reached node-pty, so never reached argv
      }
    })
  }

  it('accepts a well-formed session id, in either case', () => {
    const upper = UUID.toUpperCase()
    new mod.PtyManager().spawn({ path: 'C:\\repo', resumeId: upper }, noop, noop)
    expect(spawned).toHaveLength(1)
    expect(claudeArgv()).toContain(upper)
  })

  it('refuses ahead of the shell branch, which returns before argv is built today', () => {
    // The guard sits above that early return on purpose: a value that cannot
    // reach argv today must not become reachable by a later edit down there.
    expect(() => new mod.PtyManager().spawn(
      { path: 'C:\\repo', shell: true, resumeId: 'abc&calc' }, noop, noop,
    )).toThrow(mod.PtyArgError)
    expect(spawned).toEqual([])
  })
})

/**
 * KAN-70. A resize landing in the ~1 second after a child died froze the WHOLE
 * app: node-pty throws, ptyResize is a synchronous `ipcMain.on` with nothing
 * above it, and Electron's default handler for an uncaught main-process
 * exception is a MODAL dialog whose nested message loop stops the event loop
 * dead. Measured on the unfixed build: a tab whose child exits at spawn left
 * main refusing HTTP for 77s+, and dragging the window across a real `/exit`
 * left DOM and IPC calls in flight for 514s.
 *
 * Two ordinary ways in, so this is not a corner: resizing a pane while a
 * session ends, and any Claude that dies within ~1s of its tab opening —
 * deterministic, because Terminal.tsx fits on mount and again at +60ms.
 */
describe('KAN-70: a resize that lands after the child has exited', () => {
  for (const { kind, mod } of BRANCHES) {
    it(`does not throw out of PtyManager.resize — ${kind}`, () => {
      const mgr = new mod.PtyManager()
      const id = mgr.spawn({ path: 'C:\repo' }, noop, noop)

      // The gap: node-pty's exit code is set, so resize throws, but its
      // deferred onExit has NOT run, so the handle is still in our map.
      ptyFake.resizeThrows = true
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        expect(() => mgr.resize(id, 80, 24)).not.toThrow()
        // Anti-vacuity, and the reason this assertion cannot go quietly fake:
        // without it the test would still pass if the fake never threw at all.
        // The warn proves a throw really happened and the guard swallowed it.
        expect(warn).toHaveBeenCalled()
      } finally {
        warn.mockRestore()
      }
    })

    it(`still resizes a LIVE pty — the guard is not a blanket no-op — ${kind}`, () => {
      // The over-broad fix this exists to catch: emptying resize() out, or
      // returning early for every handle, satisfies "does not throw" perfectly.
      // So assert the dimensions REACHED node-pty, not merely that nothing blew
      // up — otherwise the pane silently stops tracking the window and KAN-50
      // (xterm's grid must match what the pty was last told) breaks instead.
      const mgr = new mod.PtyManager()
      const id = mgr.spawn({ path: 'C:\repo' }, noop, noop)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        expect(() => mgr.resize(id, 120, 40)).not.toThrow()
        expect(ptyFake.resizes).toEqual([[120, 40]])
        expect(warn).not.toHaveBeenCalled() // nothing threw, so nothing to report
      } finally {
        warn.mockRestore()
      }
    })
  }
})
