import { describe, it, expect, vi, beforeEach } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * KAN-90. resolveIde() carried the same never-exercised escape hatch
 * resolveClaude() did — `if (process.platform !== 'win32') return cmd` — and it
 * is wrong for the same reason and for the DEFAULT setting. `code` is what
 * ideCommand defaults to; VS Code's "Install 'code' command in PATH" puts it in
 * /usr/local/bin, which is not on the PATH a Dock-launched macOS app inherits
 * from launchd, so libuv's own search would have found nothing and Open in IDE
 * would have failed with ENOENT for an ordinary install.
 *
 * ide.test.ts runs real child processes and is Windows-gated for that reason;
 * this file mocks the spawn and measures what was ASKED for, which is the only
 * thing observable about the POSIX arm on a Windows runner.
 */

const calls: { file: string; args: string[]; opts: any }[] = []
vi.mock('node:child_process', () => ({
  spawn: (file: string, args: string[], opts: any) => {
    calls.push({ file, args, opts })
    return { on: () => {}, unref: () => {} }
  },
}))

const fake = vi.hoisted(() => ({ exists: (_p: string) => false, ideCommand: 'code' }))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  const existsSync = (p: unknown) => fake.exists(String(p))
  return { ...real, existsSync, default: { ...real, existsSync } }
})
vi.mock('../src/main/settings', () => ({
  getSettings: () => ({ ideCommand: fake.ideCommand, mode: 'explorer' }),
}))

const BIN = '/fake/bin'

/** Force the platform, load a fresh ide.ts under it, open a folder, restore.
 *  resolveIde() branches on a module-load-time constant, so the module has to
 *  be re-imported rather than merely called with the platform moved. */
async function openOn(
  platform: 'darwin' | 'linux',
  opts: { ideCommand?: string; path?: string; exists?: (p: string) => boolean },
): Promise<{ file: string; args: string[]; opts: any }> {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const realPath = process.env.PATH
  process.env.PATH = opts.path ?? BIN
  fake.ideCommand = opts.ideCommand ?? 'code'
  fake.exists = opts.exists ?? (() => false)
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  vi.resetModules()
  try {
    const mod = await import('../src/main/ide')
    mod.openInIde('/home/dan/repo')
    return calls[0]
  } finally {
    Object.defineProperty(process, 'platform', realPlatform)
    if (realPath === undefined) delete process.env.PATH
    else process.env.PATH = realPath
    fake.exists = () => false
    vi.resetModules()
  }
}

beforeEach(() => {
  calls.length = 0
})

describe('resolveIde() on POSIX', () => {
  it('resolves a bare command to an absolute path found on PATH', async () => {
    const target = join(BIN, 'code')
    expect((await openOn('linux', { exists: (p) => p === target })).file).toBe(target)
  })

  it('finds /usr/local/bin — where VS Code installs `code`, and where launchd\'s PATH does not look', async () => {
    const target = join('/usr/local/bin', 'code')
    expect((await openOn('darwin', { exists: (p) => p === target })).file).toBe(target)
  })

  it('finds a Homebrew-installed editor', async () => {
    const target = join('/opt/homebrew/bin', 'nvim')
    const rec = await openOn('darwin', { ideCommand: 'nvim', exists: (p) => p === target })
    expect(rec.file).toBe(target)
  })

  it('finds ~/.local/bin', async () => {
    const target = join(homedir(), '.local', 'bin', 'code')
    expect((await openOn('linux', { exists: (p) => p === target })).file).toBe(target)
  })

  it('leaves an absolute command alone', async () => {
    const abs = '/opt/sublime/bin/subl'
    expect((await openOn('linux', { ideCommand: abs, exists: (p) => p === abs })).file).toBe(abs)
  })

  it('falls back to the bare name when nothing is found — libuv still surfaces ENOENT', async () => {
    expect((await openOn('linux', {})).file).toBe('code')
  })
})

describe('the folder never reaches a command line, on POSIX either', () => {
  it('passes the folder as cwd plus a literal "." — no shell, no interpretation', async () => {
    const rec = await openOn('linux', { exists: (p) => p === join(BIN, 'code') })
    expect(rec.args).toEqual(['.'])
    expect(rec.opts.cwd).toBe('/home/dan/repo')
    expect(rec.opts.shell).toBeUndefined()
  })

  it('still honours flags configured alongside the command', async () => {
    const rec = await openOn('linux', { ideCommand: 'code -n', exists: (p) => p === join(BIN, 'code') })
    expect(rec.args).toEqual(['-n', '.'])
  })

  it('never routes through COMSPEC, even if something called code.cmd is on PATH', async () => {
    const rec = await openOn('linux', { exists: (p) => p.endsWith('code.cmd') })
    expect(rec.file).toBe('code')
    expect(rec.file).not.toMatch(/cmd\.exe$/i)
    expect(rec.args[0]).not.toBe('/c')
  })
})
