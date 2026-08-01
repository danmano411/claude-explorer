/**
 * KAN-73 — the Claude session-state signal, main-side, end to end minus the
 * socket: a REAL hook payload -> the real state machine -> the real
 * session->pty correlation -> the event the renderer would receive.
 *
 * WHY THIS SHAPE. The trap named in the ticket is that asserting the app SENDS
 * `--settings` proves nothing about whether a state ever arrives. So the flag
 * is asserted in exactly one place (pty.test.ts, where the cmd.exe quoting that
 * decides whether claude launches at all already lives) and everything here
 * asserts a TRANSITION: a payload goes in, a `(ptyId, state)` comes out or does
 * not. `deliverClaudeState` and `PtyManager` are the real ones; only electron
 * and node-pty are faked, because neither can run under vitest.
 *
 * THE PAYLOADS ARE REAL. The three fixtures below were captured verbatim off
 * the wire from claude.exe v2.1.220 running with the very settings blob
 * hookSettings() produces — not written from the documentation. That matters
 * twice over: it is how `permission_mode: "default"` on PreToolUse got into the
 * file (proving the "PreToolUse is not a permission prompt" rule is measuring
 * something real), and it means a field this code depends on cannot have been
 * invented here.
 *
 * The Notification fixture is the one that could not be captured: it needs an
 * interactive TUI, and `-p` never raises a permission dialog. It is built from
 * Claude Code's own emitter, read out of the binary:
 *   `{...Kf(void 0), hook_event_name:"Notification", message, title,
 *     notification_type}`, dispatched with `matchQuery: notification_type`.
 * The harness (test/harness/claudestate.mjs) is where a real permission_prompt
 * is exercised against a real session.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HOOK_PATH, hookSettings, stateFromHook } from '../src/main/claudestate'
import type { ClaudeState } from '../src/shared/types'

// --- fakes -----------------------------------------------------------------

const spawned: { opts: any }[] = []
const exitCbs: ((e: { exitCode: number }) => void)[] = []
vi.mock('node-pty', () => ({
  spawn: (_file: string, _args: unknown, opts: any) => {
    spawned.push({ opts })
    return {
      onData: () => {},
      onExit: (cb: (e: { exitCode: number }) => void) => { exitCbs.push(cb) },
      write: () => {}, resize: () => {}, kill: () => {},
    }
  },
}))

/** Everything webContents.send was handed, so a test can assert on the event a
 *  renderer would actually receive rather than on a mock's call count. */
const sent: unknown[][] = []
const ipcHandlers = new Map<string, (...a: any[]) => any>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: any) => ipcHandlers.set(ch, fn),
    on: (ch: string, fn: any) => ipcHandlers.set(ch, fn),
  },
  app: { getPath: () => 'C:\\fake\\userData', getAppPath: () => 'C:\\fake\\app', isPackaged: false },
  BrowserWindow: class {},
}))

import { CH } from '../src/shared/ipc'
import { PtyManager } from '../src/main/pty'
import { deliverClaudeState, registerPtyHandlers } from '../src/main/pty.handlers'

const fakeWindow = { webContents: { send: (...a: unknown[]) => { sent.push(a) } } }
registerPtyHandlers(() => fakeWindow as never)
/** Spawn through the SAME ipcMain.handle callback the renderer calls, because
 *  that is the only route to pty.handlers' module-level PtyManager — the one
 *  deliverClaudeState resolves against. A local `new PtyManager()` would be a
 *  different map and would prove nothing about delivery. */
const live: string[] = []
const spawnViaIpc = (opts: Record<string, unknown>): string => {
  const id: string = ipcHandlers.get(CH.ptySpawn)!(null, opts)
  live.push(id)
  return id
}

const UUID = '77777777-1111-4111-8111-777777777777'
const OTHER = '11111111-2222-4333-8444-555555555555'
const CWD = 'C:\\Users\\danma\\Documents\\Dan\\Projects\\ce-wt\\kan-73-state-signal'

beforeEach(() => { spawned.length = 0; exitCbs.length = 0; sent.length = 0 })
// pty.handlers' PtyManager is module scope and outlives an `it` — a session id
// left registered by one case would answer for the next, which is precisely
// what the "never spawned" case has to prove impossible.
afterEach(() => { while (live.length) ipcHandlers.get(CH.ptyKill)!(null, live.pop()) })

// --- fixtures: captured verbatim from claude.exe v2.1.220 -------------------

const USER_PROMPT_SUBMIT = {
  session_id: UUID,
  transcript_path: `C:\\Users\\danma\\.claude\\projects\\slug\\${UUID}.jsonl`,
  cwd: CWD,
  prompt_id: '33bd3a64-3aa3-4e78-a1ad-49ca52c25503',
  permission_mode: 'default',
  hook_event_name: 'UserPromptSubmit',
  prompt: 'Run the shell command `echo hookfixture` using your Bash tool, then reply OK.',
}

const PRE_TOOL_USE = {
  session_id: UUID,
  transcript_path: `C:\\Users\\danma\\.claude\\projects\\slug\\${UUID}.jsonl`,
  cwd: CWD,
  prompt_id: '33bd3a64-3aa3-4e78-a1ad-49ca52c25503',
  // The whole reason PreToolUse cannot be read as "permission needed": this
  // arrived on a session in DEFAULT mode that was never going to ask anybody.
  permission_mode: 'default',
  effort: { level: 'xhigh' },
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'echo hookfixture', description: 'Echo hookfixture' },
  tool_use_id: 'toolu_013scnRNLYGCNumDo1m1Va3R',
}

/** Same base, `tool_response` in place of the input — the event that says the
 *  approved tool has finished, i.e. the user is no longer being waited on. */
const POST_TOOL_USE = {
  ...{ session_id: UUID, cwd: CWD, permission_mode: 'default' },
  hook_event_name: 'PostToolUse',
  tool_name: 'Write',
  tool_input: { file_path: 'C:\\tmp\\kan73probe.txt', content: 'probe' },
  tool_response: { filePath: 'C:\\tmp\\kan73probe.txt' },
  tool_use_id: 'toolu_013scnRNLYGCNumDo1m1Va3R',
  duration_ms: 12,
}

const STOP = {
  session_id: UUID,
  transcript_path: `C:\\Users\\danma\\.claude\\projects\\slug\\${UUID}.jsonl`,
  cwd: CWD,
  prompt_id: '33bd3a64-3aa3-4e78-a1ad-49ca52c25503',
  permission_mode: 'default',
  effort: { level: 'xhigh' },
  hook_event_name: 'Stop',
  stop_hook_active: false,
  last_assistant_message: 'OK',
  background_tasks: [],
  session_crons: [],
}

/** Built from the binary's own emitter — see the file header. */
const notification = (notification_type: string) => ({
  session_id: UUID,
  transcript_path: `C:\\Users\\danma\\.claude\\projects\\slug\\${UUID}.jsonl`,
  cwd: CWD,
  permission_mode: 'default',
  hook_event_name: 'Notification',
  message: 'Claude needs your permission to use Bash',
  title: 'Claude Code',
  notification_type,
})

// --- the state machine ------------------------------------------------------

describe('stateFromHook: what Claude Code says it is doing', () => {
  const cases: [string, unknown, ClaudeState][] = [
    ['a submitted prompt is work starting', USER_PROMPT_SUBMIT, 'working'],
    ['a tool about to run is work in progress', PRE_TOOL_USE, 'working'],
    ['a tool having run is work in progress', POST_TOOL_USE, 'working'],
    ['the turn ending is idle', STOP, 'idle'],
    ['a permission prompt is blocked on the user', notification('permission_prompt'), 'awaiting-input'],
    ['the idle notification is idle', notification('idle_prompt'), 'idle'],
  ]
  for (const [what, payload, state] of cases) {
    it(what, () => {
      expect(stateFromHook(payload)).toEqual({ sessionId: UUID, state })
    })
  }

  it('never reports awaiting-input for a tool call, whatever the permission mode', () => {
    // The single most damaging mis-read available here: the tool events fire
    // around EVERY tool call in EVERY mode, so treating either as "permission
    // needed" paints the blocked state — and, downstream, rings the bell — on a
    // session running in bypass that will never ask anybody anything.
    for (const mode of ['default', 'acceptEdits', 'bypassPermissions', 'plan']) {
      expect(stateFromHook({ ...PRE_TOOL_USE, permission_mode: mode })?.state).toBe('working')
      expect(stateFromHook({ ...POST_TOOL_USE, permission_mode: mode })?.state).toBe('working')
    }
  })

  it('clears a permission prompt on PostToolUse, which is the only event that can', () => {
    // Measured against a live dialog, the order is PreToolUse, THEN the prompt —
    // so the leave-transition the design expected from PreToolUse has already
    // fired before anyone is blocked. Nothing fires on the approval itself.
    // Without PostToolUse a tab stays "needs you" for the whole duration of a
    // tool the user already approved.
    const seq = [PRE_TOOL_USE, notification('permission_prompt'), POST_TOOL_USE]
      .map((p) => stateFromHook(p)?.state)
    expect(seq).toEqual(['working', 'awaiting-input', 'working'])
  })

  it('says nothing for the Notification types that are not about being blocked', () => {
    // They all arrive — there is no matcher — and must produce no transition.
    // `agent_completed` reaching 'idle' would report the SESSION finished when a
    // subagent did; `auth_success` reaching anything at all would move a
    // session that is not running.
    for (const t of ['auth_success', 'elicitation_dialog', 'elicitation_complete',
      'elicitation_response', 'agent_needs_input', 'agent_completed']) {
      expect(stateFromHook(notification(t))).toBeNull()
    }
  })

  it('says nothing for a subagent finishing', () => {
    // SubagentStop is a DIFFERENT event from Stop and is deliberately not
    // registered. If it were ever mapped, a Task finishing would report the
    // whole session idle while the main agent is still working.
    expect(stateFromHook({ ...STOP, hook_event_name: 'SubagentStop' })).toBeNull()
  })

  it('refuses a payload with no usable session id, rather than inventing one', () => {
    for (const bad of [
      null, undefined, 'Stop', 42, [],
      { hook_event_name: 'Stop' },
      { hook_event_name: 'Stop', session_id: '' },
      { hook_event_name: 'Stop', session_id: 123 },
      { hook_event_name: 'Stop', session_id: { toString: () => UUID } },
    ]) {
      expect(stateFromHook(bad)).toBeNull()
    }
  })
})

// --- the injected settings blob ---------------------------------------------

describe('hookSettings: the blob that has to make a state arrive', () => {
  type Hook = { type: string; url: string; headers: Record<string, string>; allowedEnvVars: string[] }
  const blob = hookSettings(54321) as { hooks: Record<string, { hooks: Hook[] }[]> }
  const registered = Object.keys(blob.hooks).sort()
  // Off whichever event is registered first rather than a named one, so
  // dropping an event from the blob fails the closure assertion below as an
  // ASSERTION — a fixture indexed by name would crash the whole file at
  // collection instead, which reads as a broken test rather than a caught bug.
  const hook: Hook = blob.hooks[registered[0]]?.[0]?.hooks?.[0] ?? ({} as Hook)

  it('interpolates a header naming a variable it also allowlists', () => {
    // The measured silent-failure mode, and why this is a transition assertion
    // and not a shape one: Claude Code interpolates `${VAR}` in a hook header
    // ONLY for variables listed in allowedEnvVars ("Required for env var
    // interpolation to work" — verbatim in the binary). Name them differently
    // and the header goes out as the LITERAL `Bearer ${...}`, which mcpauth.ts
    // 401s by design. Every hook then fires, every request is refused, and NO
    // STATE EVER ARRIVES — with a perfectly correct-looking settings file.
    const named = /\$\{?([A-Z_]+)\}?/.exec(hook.headers.Authorization)?.[1]
    expect(named).toBeTruthy()
    expect(hook.allowedEnvVars).toContain(named)
  })

  it('points at loopback, on the port it was given, at the route the server serves', () => {
    expect(hook.url).toBe(`http://127.0.0.1:54321${HOOK_PATH}`)
    expect(hook.type).toBe('http')
  })

  it('registers exactly the events the state machine can act on, and all of them', () => {
    // Two-way closure, because both halves fail silently and neither is visible
    // in a running app: an event registered with no transition is a POST on
    // every turn that changes nothing, and a transition whose event is not
    // registered is a state that can never be reached — the `idle` arm of
    // `Stop` would simply never fire and a finished session would sit on
    // `working` forever.
    const reachable = registered.filter((event) =>
      stateFromHook({ session_id: UUID, hook_event_name: event }) !== null ||
      // Notification carries its state in notification_type, not the event name.
      event === 'Notification')
    expect(reachable).toEqual(registered)
    expect(registered).toEqual([
      'Notification', 'PostToolUse', 'PreToolUse', 'Stop', 'UserPromptSubmit',
    ])
  })
})

// --- correlation and delivery ----------------------------------------------

describe('a hook payload reaches the renderer as (ptyId, state)', () => {
  it('delivers to the pty that owns the session named in the payload', () => {
    const ptyId = spawnViaIpc({ path: CWD, sessionId: UUID })
    const t = stateFromHook(PRE_TOOL_USE)!
    expect(deliverClaudeState(t.sessionId, t.state)).toBe(true)
    expect(sent).toEqual([[CH.claudeState, ptyId, 'working']])
  })

  it('delivers to the RIGHT pty when several sessions are open', () => {
    // The failure this exists for is a correlation that happens to work with
    // one tab open — "send it to the only pty" passes every single-session
    // test and puts every state on the wrong tab the moment there are two.
    const first = spawnViaIpc({ path: CWD, sessionId: OTHER })
    const second = spawnViaIpc({ path: CWD, sessionId: UUID })
    expect(first).not.toBe(second)
    deliverClaudeState(UUID, 'awaiting-input')
    deliverClaudeState(OTHER, 'idle')
    expect(sent).toEqual([
      [CH.claudeState, second, 'awaiting-input'],
      [CH.claudeState, first, 'idle'],
    ])
  })

  it('correlates a RESUMED conversation by the id it was resumed with', () => {
    // A restored tab spawns with --resume, not --session-id, and Claude Code
    // keeps reporting that same id (measured against v2.1.220). Correlating
    // only the --session-id spelling would silently lose every tab that
    // survived a restart — i.e. exactly the long-lived sessions this feature is
    // for.
    const ptyId = spawnViaIpc({ path: CWD, resumeId: UUID })
    expect(deliverClaudeState(UUID, 'working')).toBe(true)
    expect(sent).toEqual([[CH.claudeState, ptyId, 'working']])
  })

  it('drops a state for a session this app never spawned, sending nothing', () => {
    spawnViaIpc({ path: CWD, sessionId: UUID })
    expect(deliverClaudeState(OTHER, 'working')).toBe(false)
    expect(sent).toEqual([])
  })

  it('drops a state for a session whose process has exited', () => {
    // The handle map already forgets on exit; the session map has to as well,
    // or a late hook — or a caller replaying an old id — paints a state onto a
    // ptyId the renderer has already torn down.
    spawnViaIpc({ path: CWD, sessionId: UUID })
    exitCbs.at(-1)!({ exitCode: 0 })
    expect(deliverClaudeState(UUID, 'idle')).toBe(false)
    expect(sent.filter((s) => s[0] === CH.claudeState)).toEqual([])
  })

  it('drops a state for a session whose tab was closed', () => {
    const ptyId = spawnViaIpc({ path: CWD, sessionId: UUID })
    ipcHandlers.get(CH.ptyKill)!(null, ptyId)
    expect(deliverClaudeState(UUID, 'idle')).toBe(false)
    expect(sent.filter((s) => s[0] === CH.claudeState)).toEqual([])
  })
})

describe('PtyManager.ptyForSession', () => {
  it('knows nothing about a shell tab, which has no Claude session at all', () => {
    const mgr = new PtyManager()
    mgr.spawn({ path: CWD, shell: true }, () => {}, () => {})
    expect(mgr.ptyForSession(UUID)).toBeUndefined()
  })

  it('records the id claude was actually given when both are passed', () => {
    // spawn() prefers --resume when both arrive, so --resume is the id Claude
    // Code will report; recording the other one would correlate nothing.
    const mgr = new PtyManager()
    const id = mgr.spawn({ path: CWD, resumeId: UUID, sessionId: OTHER }, () => {}, () => {})
    expect(mgr.ptyForSession(UUID)).toBe(id)
    expect(mgr.ptyForSession(OTHER)).toBeUndefined()
  })
})
