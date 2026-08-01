import { describe, it, expect, vi, afterEach } from 'vitest'

/**
 * KAN-67 referee finding: external.ts's "Open in Terminal" spawns wt.exe (and,
 * on fallback, a persistent -NoExit powershell) with no `env` option at all —
 * so it inherits process.env verbatim. Under the ticket's nested-launch
 * precondition (Claude Explorer itself started from inside one of its own
 * Claude terminals) that hands an interactive, persistent shell this app's own
 * MCP bearer token, which is exactly what pty.ts's shell-tab comment says must
 * never happen ("a shell hands its whole environment to everything the user
 * runs") — just via a spawn site pty.ts's launchEnv() never touches.
 *
 * The actual fix lives at the root (stripInheritedAppSecrets(), called once
 * from src/main/index.ts at startup) rather than here, so this file does not
 * spawn a real wt.exe/powershell (that would pop an actual terminal window in
 * CI) — it mocks node:child_process, the same technique pty.test.ts uses for
 * node-pty, and proves the two halves of the fix: (1) external.ts really does
 * pass no `env` override, so process.env is what the child gets, and (2) once
 * stripInheritedAppSecrets() has run, process.env no longer carries this app's
 * token — so there is nothing left for that verbatim inheritance to hand over.
 * ide.test.ts's real-process test proves the underlying Node inheritance
 * mechanism end-to-end with an actual child process; duplicating that here
 * would only re-prove Node's own documented spawn(..., {env: undefined})
 * contract.
 */
const calls: { file: string; args: unknown; opts: any }[] = []
vi.mock('node:child_process', () => ({
  spawn: (file: string, args: unknown, opts: any) => {
    calls.push({ file, args, opts })
    return { on: () => {}, unref: () => {} }
  },
}))
// KAN-90: external.ts now imports electron's dialog, for the POSIX arms that can
// genuinely have nowhere to open a terminal. Never reached on the Windows path
// these tests measure — external.posix.test.ts is where it is exercised.
vi.mock('electron', () => ({
  dialog: { showMessageBox: () => Promise.resolve({ response: 0 }) },
}))

const { openExternalTerminal } = await import('../src/main/external')
const { stripInheritedAppSecrets } = await import('../src/main/pty')

afterEach(() => {
  calls.length = 0
  delete process.env.CLAUDE_EXPLORER_MCP_TOKEN
  delete process.env.CLAUDE_EXPLORER_PTY_ID
})

// KAN-90 made openExternalTerminal() branch on the platform, so the branch under
// test is named rather than inherited from whatever runner this lands on.
function openOnWindows(path: string): void {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  try {
    openExternalTerminal(path)
  } finally {
    Object.defineProperty(process, 'platform', real)
  }
}

describe('KAN-67: openExternalTerminal and the root-cause scrub', () => {
  it('spawns wt.exe with no env option — the exact "inherits everything" channel the scrub closes', () => {
    openOnWindows('C:\\repo')
    expect(calls[0].file).toBe('wt.exe')
    expect('env' in calls[0].opts).toBe(false)
  })

  it('after stripInheritedAppSecrets() runs, process.env — what wt.exe actually inherits — no longer carries this app\'s token', () => {
    process.env.CLAUDE_EXPLORER_MCP_TOKEN = 'STALE-EXTERNAL-TOKEN'
    process.env.CLAUDE_EXPLORER_PTY_ID = 'STALE-EXTERNAL-PTY'

    stripInheritedAppSecrets()
    openOnWindows('C:\\repo')

    // Unchanged by design: external.ts still passes no env override...
    expect('env' in calls[0].opts).toBe(false)
    // ...but there is nothing left in process.env for that inheritance to hand over.
    expect(process.env.CLAUDE_EXPLORER_MCP_TOKEN).toBeUndefined()
    expect(process.env.CLAUDE_EXPLORER_PTY_ID).toBeUndefined()
  })
})
