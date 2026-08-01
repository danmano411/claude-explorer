import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * KAN-90. "Open in Terminal" was 100% Windows with NO fallback: wt.exe, then a
 * persistent powershell. On macOS or Linux it spawned wt.exe, got ENOENT, spawned
 * powershell, got ENOENT, and the button silently did nothing forever.
 *
 * openExternalTerminal() reads process.platform at call time, so the arms are
 * reachable by moving the platform around the call — no module reload needed.
 */

type Rec = { file: string; args: string[]; opts: any; onError?: (e: Error) => void }
const calls: Rec[] = []
vi.mock('node:child_process', () => ({
  spawn: (file: string, args: string[], opts: any) => {
    const rec: Rec = { file, args, opts }
    calls.push(rec)
    return {
      on: (ev: string, cb: (e: Error) => void) => {
        if (ev === 'error') rec.onError = cb
      },
      unref: () => {},
    }
  },
}))

const shown: { message: string }[] = []
vi.mock('electron', () => ({
  dialog: {
    showMessageBox: (o: { message: string }) => {
      shown.push(o)
      return Promise.resolve({ response: 0 })
    },
  },
}))

const { openExternalTerminal, appleScriptLiteral } = await import('../src/main/external')

function on(platform: string, path: string): void {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    openExternalTerminal(path)
  } finally {
    Object.defineProperty(process, 'platform', real)
  }
}

/** Walk an AppleScript string literal the way the parser does and report where
 *  it ENDS. If escaping is wrong, that is before the last character — which is
 *  how a folder name would stop being data and start being script. */
function literalEndsAt(lit: string): number {
  for (let i = 1; i < lit.length; i++) {
    if (lit[i] === '\\') {
      i++
      continue
    }
    if (lit[i] === '"') return i
  }
  return -1
}

beforeEach(() => {
  calls.length = 0
  shown.length = 0
})

describe('macOS', () => {
  it('drives Terminal.app instead of looking for wt.exe', () => {
    on('darwin', '/Users/dan/repo')
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('osascript')
    expect(calls[0].args[0]).toBe('-e')
    const script = calls[0].args[1]
    expect(script).toContain('tell application "Terminal"')
    expect(script).toContain('/Users/dan/repo')
    expect(script).toContain('&& claude')
  })

  it('quotes the folder for the shell with AppleScript\'s own primitive, not by hand', () => {
    on('darwin', '/Users/dan/My Projects/app')
    // `quoted form of` is what makes the path ONE shell argument. Interpolating
    // it into the `do script` string without this is the injection.
    expect(calls[0].args[1]).toContain('quoted form of')
  })

  it('detaches, so quitting the app does not take the terminal with it', () => {
    on('darwin', '/Users/dan/repo')
    expect(calls[0].opts.detached).toBe(true)
    expect(calls[0].opts.stdio).toBe('ignore')
    expect(calls[0].opts.shell).toBeUndefined()
  })
})

describe('the AppleScript literal cannot be ended early by a folder name', () => {
  // Both characters are legal in a macOS filename, so these are honest-user
  // names as much as they are attacks.
  const hostile = [
    '/Users/dan/a"; do shell script "open -a Calculator',
    '/Users/dan/back\\slash',
    '/Users/dan/both"\\mixed',
    '/Users/dan/trailing\\',
  ]

  it('every escaped literal runs to its final character', () => {
    for (const raw of hostile) {
      const lit = appleScriptLiteral(raw)
      expect(literalEndsAt(lit)).toBe(lit.length - 1)
    }
  })

  it('and decodes back to exactly the original path', () => {
    for (const raw of hostile) {
      const inner = appleScriptLiteral(raw).slice(1, -1)
      expect(inner.replace(/\\(.)/g, '$1')).toBe(raw)
    }
  })

  it('escapes backslashes BEFORE quotes, or the escape characters escape each other', () => {
    // '"' -> '\"' first, then doubling backslashes would turn that into '\\"'
    // — an escaped backslash followed by a bare quote, which ends the literal.
    const lit = appleScriptLiteral('a"b')
    expect(lit).toBe('"a' + '\\' + '"b"')
    expect(literalEndsAt(lit)).toBe(lit.length - 1)
  })
})

describe('Linux tries the terminals that exist', () => {
  it('starts with gnome-terminal, in the folder', () => {
    on('linux', '/home/dan/repo')
    expect(calls[0].file).toBe('gnome-terminal')
    expect(calls[0].args).toContain('--working-directory=/home/dan/repo')
    // gnome-terminal is a client to an already-running server, so the window
    // inherits the SERVER's cwd — the flag is what actually places it. cwd is
    // set as well for xterm, which has no flag.
    expect(calls[0].opts.cwd).toBe('/home/dan/repo')
  })

  it('walks the chain when one is not installed', () => {
    on('linux', '/home/dan/repo')
    calls[0].onError!(new Error('spawn gnome-terminal ENOENT'))
    expect(calls[1].file).toBe('konsole')
    calls[1].onError!(new Error('spawn konsole ENOENT'))
    expect(calls[2].file).toBe('xfce4-terminal')
    calls[2].onError!(new Error('spawn xfce4-terminal ENOENT'))
    expect(calls[3].file).toBe('xterm')
    expect(calls[3].opts.cwd).toBe('/home/dan/repo')
  })

  it('explains itself when NONE of them is installed, instead of doing nothing', () => {
    on('linux', '/home/dan/repo')
    // Each failure spawns the next, so the list grows underneath this loop; the
    // bound is what proves the chain terminates rather than looping.
    for (let i = 0; i < 10 && calls[i]; i++) calls[i].onError!(new Error('ENOENT'))
    expect(calls).toHaveLength(4) // it stops, rather than looping
    expect(shown).toHaveLength(1)
    for (const name of ['gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm']) {
      expect(shown[0].message).toContain(name)
    }
    expect(shown[0].message).toContain('claude')
  })

  it('says nothing when a terminal DID launch — the message is a failure, not a log', () => {
    on('linux', '/home/dan/repo')
    expect(shown).toHaveLength(0)
  })

  it('passes the folder as one argv entry, so nothing in it can be a command', () => {
    // '&', ';' and spaces are all legal in a POSIX directory name.
    const nasty = '/home/dan/a; rm -rf ~ & echo'
    on('linux', nasty)
    expect(calls[0].args.filter((a) => a.includes('rm -rf'))).toEqual([`--working-directory=${nasty}`])
    expect(calls[0].opts.shell).toBeUndefined()
    // The command run inside the terminal is a constant, never assembled from
    // the path.
    expect(calls[0].args).toContain('claude; exec bash')
  })
})

describe('Windows is untouched', () => {
  it('still asks for wt.exe with the arguments it always did', () => {
    on('win32', 'C:\\repo')
    expect(calls[0].file).toBe('wt.exe')
    expect(calls[0].args).toEqual(['-d', 'C:\\repo', 'powershell', '-NoExit', '-Command', 'claude'])
    expect('env' in calls[0].opts).toBe(false) // KAN-67: inherits the scrubbed process.env
  })

  it('still falls back to a persistent powershell, with the path single-quote-doubled', () => {
    on('win32', "C:\\it's here")
    calls[0].onError!(new Error('spawn wt.exe ENOENT'))
    expect(calls[1].file).toBe('powershell')
    expect(calls[1].args[2]).toBe("Set-Location -LiteralPath 'C:\\it''s here'; claude")
  })

  it('never shows the POSIX failure dialog', () => {
    on('win32', 'C:\\repo')
    calls[0].onError!(new Error('ENOENT'))
    expect(shown).toHaveLength(0)
  })
})
