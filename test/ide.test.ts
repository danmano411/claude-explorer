import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const settings = vi.hoisted(() => ({ ideCommand: 'code' }))
vi.mock('../src/main/settings', () => ({
  getSettings: () => ({ ideCommand: settings.ideCommand, mode: 'explorer' }),
}))

const { openInIde } = await import('../src/main/ide')

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
