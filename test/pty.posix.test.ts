import { describe, it, expect, vi, beforeEach } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * KAN-90. Two things in pty.ts were Windows-only through 0.9.0:
 *
 *  - a shell tab spawned `powershell.exe -NoLogo` unconditionally, so on macOS
 *    or Linux the feature could not work at all;
 *  - resolveClaude() returned a bare `claude` off win32 and left the lookup to
 *    execvp. That arm had NEVER been exercised, and it is wrong on the most
 *    ordinary macOS install there is: a Dock-launched app inherits launchd's
 *    PATH (/usr/bin:/bin:/usr/sbin:/sbin), so ~/.local/bin — where the official
 *    installer puts claude — is invisible and every launch fails with ENOENT.
 *
 * Neither arm is reachable by calling the exports on Windows, and pty.test.ts
 * deliberately pins process.platform to win32 for its whole file (both of its
 * branches collapse into one otherwise), so the POSIX arms live here.
 *
 * node:path is NOT reset by vi.resetModules, so join() and PATH's delimiter are
 * still the host's. That is why every PATH below is a SINGLE directory — no
 * delimiter is involved — and why expectations are built with the same join()
 * the module uses rather than written out as literals.
 */

const spawned: { file: string; args: string[] | string; opts: any }[] = []
vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[] | string, opts: any) => {
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

// resolveClaude() runs at import time and decides everything below by scanning
// with existsSync. Which file "exists" is the test's decision, never the
// machine's — that is the trap pty.test.ts documents for the .exe/.cmd split.
const fake = vi.hoisted(() => ({ exists: (_p: string): boolean => false }))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  const existsSync = (p: unknown) => fake.exists(String(p))
  return { ...real, existsSync, default: { ...real, existsSync } }
})

const noop = () => {}
const BIN = '/fake/bin'
const LOCAL_BIN = join(homedir(), '.local', 'bin')

/** Force the platform and environment, load a FRESH pty.ts under it, run the
 *  body, and put everything back — the body runs while the platform is still
 *  forced, because shellCommand() reads process.platform at spawn time. */
async function on<T>(
  platform: 'darwin' | 'linux',
  env: { PATH?: string; SHELL?: string | undefined },
  exists: (p: string) => boolean,
  body: (mod: typeof import('../src/main/pty')) => T | Promise<T>,
): Promise<T> {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const saved: Record<string, string | undefined> = { PATH: process.env.PATH, SHELL: process.env.SHELL }
  const apply = (k: 'PATH' | 'SHELL', v: string | undefined) => {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  apply('PATH', 'PATH' in env ? env.PATH : BIN)
  apply('SHELL', 'SHELL' in env ? env.SHELL : undefined)
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  fake.exists = exists
  vi.resetModules()
  try {
    return await body(await import('../src/main/pty'))
  } finally {
    Object.defineProperty(process, 'platform', realPlatform)
    apply('PATH', saved.PATH)
    apply('SHELL', saved.SHELL)
    fake.exists = () => false
    vi.resetModules()
  }
}

const shellTab = (mod: typeof import('../src/main/pty')) => {
  new mod.PtyManager().spawn({ path: '/repo', shell: true }, noop, noop)
  return spawned[0]
}
const claudeTab = (mod: typeof import('../src/main/pty')) => {
  new mod.PtyManager().spawn({ path: '/repo' }, noop, noop)
  return spawned[0]
}

beforeEach(() => {
  spawned.length = 0
})

describe('a shell tab runs the platform\'s actual shell', () => {
  it('macOS: the user\'s $SHELL, as a LOGIN shell', async () => {
    const rec = await on('darwin', { SHELL: '/bin/zsh' }, () => false, shellTab)
    expect(rec.file).toBe('/bin/zsh')
    // -l is not cosmetic: without it the tab inherits launchd's four-entry PATH
    // and the user cannot run the very tool this app exists to launch.
    expect(rec.args).toEqual(['-l'])
  })

  it('Linux: the user\'s $SHELL, non-login, matching what every emulator there does', async () => {
    const rec = await on('linux', { SHELL: '/usr/bin/fish' }, () => false, shellTab)
    expect(rec.file).toBe('/usr/bin/fish')
    expect(rec.args).toEqual([])
  })

  it('falls back to /bin/bash when $SHELL is unset, not to a Windows shell', async () => {
    const rec = await on('linux', { SHELL: undefined }, () => false, shellTab)
    expect(rec.file).toBe('/bin/bash')
  })

  it('still scrubs the inherited session identity, exactly as the Windows arm does', async () => {
    process.env.CLAUDE_CODE_CHILD_SESSION = '1'
    process.env.CLAUDE_EXPLORER_MCP_TOKEN = 'STALE'
    try {
      const rec = await on('darwin', { SHELL: '/bin/zsh' }, () => false, shellTab)
      expect(rec.opts.env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined()
      expect(rec.opts.env.CLAUDE_EXPLORER_MCP_TOKEN).toBeUndefined()
    } finally {
      delete process.env.CLAUDE_CODE_CHILD_SESSION
      delete process.env.CLAUDE_EXPLORER_MCP_TOKEN
    }
  })
})

describe('resolveClaude() on POSIX resolves instead of hoping execvp will', () => {
  it('finds an absolute claude on PATH', async () => {
    const target = join(BIN, 'claude')
    const rec = await on('linux', {}, (p) => p === target, claudeTab)
    expect(rec.file).toBe(target)
  })

  it('finds the official installer location, ~/.local/bin, which is NOT on a Dock-launched app\'s PATH', async () => {
    const target = join(LOCAL_BIN, 'claude')
    const rec = await on('darwin', {}, (p) => p === target, claudeTab)
    expect(rec.file).toBe(target)
  })

  it('finds a Homebrew install, likewise invisible to launchd\'s PATH', async () => {
    const target = join('/opt/homebrew/bin', 'claude')
    const rec = await on('darwin', {}, (p) => p === target, claudeTab)
    expect(rec.file).toBe(target)
  })

  it('still falls back to a bare `claude` when nothing is found anywhere', async () => {
    const rec = await on('linux', {}, () => false, claudeTab)
    expect(rec.file).toBe('claude')
  })
})

describe('the cmd.exe machinery is INERT on POSIX, not ported', () => {
  it('never probes for .cmd/.bat, so COMSPEC and batchCommandLine stay unreachable', async () => {
    // A file called claude.cmd sitting on PATH is the trap: probing the Windows
    // extension list here would resolve to it, the /\.(cmd|bat)$/ test would
    // pass, and a POSIX spawn would be handed a cmd.exe command LINE.
    const rec = await on('linux', {}, (p) => p.endsWith('claude.cmd'), claudeTab)
    expect(rec.file).toBe('claude')
    expect(Array.isArray(rec.args)).toBe(true)
    expect(rec.file).not.toMatch(/cmd\.exe$/i)
  })

  it('hands node-pty an argv ARRAY, never a command-line string', async () => {
    const rec = await on('darwin', {}, (p) => p === join(BIN, 'claude'), claudeTab)
    expect(Array.isArray(rec.args)).toBe(true)
  })
})
