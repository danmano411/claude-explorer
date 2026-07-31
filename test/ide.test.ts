import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const settings = vi.hoisted(() => ({ ideCommand: 'code' }))
vi.mock('../src/main/settings', () => ({
  getSettings: () => ({ ideCommand: settings.ideCommand, mode: 'explorer' }),
}))

const { openInIde } = await import('../src/main/ide')
const { stripInheritedAppSecrets } = await import('../src/main/pty')

// '&' is a legal Windows filename character, so this is an honest-user folder name,
// not just an attack. Under shell:true everything after '&' ran as a command.
const HOSTILE = 'research & mkdir PWNED'

let work: string
let log: string
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'ce-ide-'))
  log = join(work, 'log.txt')
})
afterEach(() => {
  rmSync(work, { recursive: true, force: true })
  // shell:true runs the injected `mkdir` in the *parent's* cwd — clean up after a red run.
  rmSync(join(process.cwd(), 'PWNED'), { recursive: true, force: true })
})

function writeShim(dir: string): string {
  // A .cmd shim standing in for VS Code's `code` — the case shell:true existed for.
  // `cd` with no args prints the working directory (no %VAR% expansion hazards).
  mkdirSync(dir, { recursive: true })
  const shim = join(dir, 'myide.cmd')
  writeFileSync(shim, `@echo off\r\n>"${log}" echo args=[%*]\r\n>>"${log}" cd\r\n`)
  return shim
}

// KAN-67: a shim that echoes this app's own env vars back, to prove — with a
// REAL child process, not a mock — whether the IDE actually received them.
// Inside a .cmd script cmd.exe expands an unset %VAR% to nothing (empirically
// verified here, unlike the interactive-prompt case where it stays literal),
// so the baseline test's non-empty value is what distinguishes "received the
// token" from "did not."
function writeEnvProbeShim(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const shim = join(dir, 'envprobe.cmd')
  writeFileSync(
    shim,
    `@echo off\r\n>"${log}" echo TOKEN=%CLAUDE_EXPLORER_MCP_TOKEN%\r\n>>"${log}" echo PTYID=%CLAUDE_EXPLORER_PTY_ID%\r\n`,
  )
  return shim
}

async function waitForLog(): Promise<string> {
  for (let i = 0; i < 200; i++) {
    if (existsSync(log)) {
      const text = readFileSync(log, 'utf8')
      if (text.trim().split('\n').length >= 2) return text
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('IDE shim never ran (no log written)')
}

describe.skipIf(process.platform !== 'win32')('openInIde', () => {
  it('does not execute shell metacharacters in a folder name', async () => {
    settings.ideCommand = writeShim(work)

    const folder = join(work, HOSTILE)
    mkdirSync(folder)

    openInIde(folder)
    const text = await waitForLog()

    // The IDE was handed the folder intact — metacharacters and all.
    expect(text).toContain(folder)
    // And nothing after the '&' ran, anywhere it could have landed.
    for (const dir of [folder, work, process.cwd()]) {
      expect(existsSync(join(dir, 'PWNED'))).toBe(false)
    }
  }, 20000)

  it('still launches a .cmd shim installed under a path with spaces', async () => {
    // The real one is "C:\Program Files\Microsoft VS Code\bin\code.cmd", and
    // `cmd /c "<quoted exe>" .` only works because of cmd's quote-preserving rule.
    settings.ideCommand = writeShim(join(work, 'Program Files', 'My IDE', 'bin'))
    const folder = join(work, 'plain')
    mkdirSync(folder)

    openInIde(folder)
    expect(await waitForLog()).toContain(folder)
  }, 20000)
})

/**
 * KAN-67 referee finding: openInIde() never routed through pty.ts's
 * launchEnv(), so a nested launch (Claude Explorer started from inside one of
 * its own Claude terminals) handed this app's own MCP bearer token to
 * whatever IDE the user configured — VS Code's integrated terminal then holds
 * it for every terminal the user opens inside it. The fix is at the root
 * (stripInheritedAppSecrets(), called once from src/main/index.ts at
 * startup), not in ide.ts, so this proves the root fix actually closes this
 * call site: a REAL child process (not a mock) either does or does not
 * receive the token.
 */
describe.skipIf(process.platform !== 'win32')('KAN-67: openInIde and the root-cause scrub', () => {
  const STALE_TOKEN = 'STALE-TOKEN-kan67-ide-probe'
  const STALE_PTY = 'stale-pty-kan67-ide-probe'

  afterEach(() => {
    delete process.env.CLAUDE_EXPLORER_MCP_TOKEN
    delete process.env.CLAUDE_EXPLORER_PTY_ID
  })

  it('BASELINE: without the root-cause scrub, the IDE process really does receive this app\'s token', async () => {
    settings.ideCommand = writeEnvProbeShim(work)
    process.env.CLAUDE_EXPLORER_MCP_TOKEN = STALE_TOKEN
    process.env.CLAUDE_EXPLORER_PTY_ID = STALE_PTY

    openInIde(work)
    const text = await waitForLog()

    expect(text).toContain(`TOKEN=${STALE_TOKEN}`)
    expect(text).toContain(`PTYID=${STALE_PTY}`)
  }, 20000)

  it('after stripInheritedAppSecrets() runs (as index.ts does at startup), the IDE process no longer receives the token', async () => {
    settings.ideCommand = writeEnvProbeShim(work)
    process.env.CLAUDE_EXPLORER_MCP_TOKEN = STALE_TOKEN
    process.env.CLAUDE_EXPLORER_PTY_ID = STALE_PTY

    stripInheritedAppSecrets()
    openInIde(work)
    const text = await waitForLog()

    expect(text).not.toContain(STALE_TOKEN)
    expect(text).not.toContain(STALE_PTY)
    // Unset expands to nothing inside a .cmd script — see writeEnvProbeShim.
    expect(text).toContain('TOKEN=\r\n')
    expect(text).toContain('PTYID=\r\n')
  }, 20000)
})
