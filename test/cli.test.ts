// KAN-4 — the argv reader for `--open` / `--new-session`.
//
// Only parseCliArgs is tested here: it is pure, so it needs no electron mock,
// no fs and no fixtures. The shapes below are the three real ones this has to
// survive — electron-vite's dev spawn, the Playwright harness, and a packaged
// launch — because every one of them puts junk in argv and none of them may
// produce a tab.
//
// resolveCliIntent is deliberately absent: asserting on it means a real
// canonicalize() + statSync() against real paths, which test/harness/cli.mjs
// already does end to end against a live app.
import { describe, it, expect } from 'vitest'
import { parseCliArgs } from '../src/main/cli'

const EXE = 'C:\\Program Files\\Claude Explorer\\Claude Explorer.exe'
const CWD = 'C:\\base'

describe('parseCliArgs: shapes that must produce nothing', () => {
  it('the electron-vite dev shape', () => {
    expect(parseCliArgs(
      ['C:\\repo\\node_modules\\electron\\dist\\electron.exe', '.', '--inspect=9229'], CWD,
    )).toBeNull()
  })

  it('the Playwright harness shape', () => {
    expect(parseCliArgs(
      [EXE, '--user-data-dir=C:\\tmp\\p', 'C:\\repo\\out\\main\\index.js'], CWD,
    )).toBeNull()
  })

  it('the argv Chromium hands to second-instance, which is why we do not use it', () => {
    // Captured from a real forwarded launch of `electron.exe
    // --user-data-dir=... out/main/index.js --open <path>`: Chromium regroups
    // the line into [program, ...switches, ...loose args] and injects switches
    // of its own, so `--open` and its path are no longer adjacent. This row is
    // here to pin WHY main/index.ts forwards the verbatim argv through
    // requestSingleInstanceLock's additionalData instead: no parser can
    // recover the pairing from this, and guessing (e.g. "take the last loose
    // arg") would open out/main/index.js when the flag was dangling.
    expect(parseCliArgs([
      'C:\\repo\\node_modules\\electron\\dist\\electron.exe',
      '--user-data-dir=C:\\tmp\\p',
      '--open',
      '--allow-file-access-from-files',
      'C:\\repo\\out\\main\\index.js',
      'C:\\repo\\src',
    ], CWD)).toBeNull()
  })

  it('a bare positional path is ignored by design', () => {
    // Accepting one would be indistinguishable from dev's '.' and the harness's
    // out/main/index.js — i.e. a stray tab on every `npm run dev`.
    expect(parseCliArgs([EXE, 'C:\\repo'], CWD)).toBeNull()
  })

  it('a flag with no value at all', () => {
    expect(parseCliArgs([EXE, '--open'], CWD)).toBeNull()
  })

  it('a flag whose value is another flag', () => {
    expect(parseCliArgs([EXE, '--open', '--new-session', 'C:\\r'], CWD)).toBeNull()
  })

  it('a flag whose value is empty', () => {
    expect(parseCliArgs([EXE, '--open', ''], CWD)).toBeNull()
  })
})

describe('parseCliArgs: the two flags', () => {
  it('--open <folder>', () => {
    expect(parseCliArgs([EXE, '--open', 'C:\\repo'], CWD))
      .toEqual({ cmd: 'open', path: 'C:\\repo' })
  })

  it('--new-session <folder>', () => {
    expect(parseCliArgs([EXE, '--new-session', 'C:\\repo'], CWD))
      .toEqual({ cmd: 'new-session', path: 'C:\\repo' })
  })

  it('is found after junk earlier in argv', () => {
    expect(parseCliArgs([EXE, '.', '--no-sandbox', '--open', 'C:\\repo'], CWD))
      .toEqual({ cmd: 'open', path: 'C:\\repo' })
  })

  it('first flag wins; the rest of argv is ignored', () => {
    expect(parseCliArgs([EXE, '--new-session', 'C:\\a', '--open', 'C:\\b'], CWD))
      .toEqual({ cmd: 'new-session', path: 'C:\\a' })
  })
})

describe('parseCliArgs: path resolution', () => {
  it('resolves a relative path against the CALLER cwd', () => {
    // second-instance hands us the other process's workingDirectory; resolving
    // against ours would silently open the wrong folder.
    expect(parseCliArgs([EXE, '--open', 'sub\\dir'], CWD)?.path)
      .toBe('C:\\base\\sub\\dir')
  })

  it('keeps a drive root intact', () => {
    // Explorer's %V on a drive root is exactly 'C:\' — resolve() must not eat
    // the trailing separator and hand the app 'C:' (a relative drive path).
    expect(parseCliArgs([EXE, '--open', 'C:\\'], CWD)?.path).toBe('C:\\')
  })
})

// There is deliberately no "quoted path with spaces" case: Windows strips the
// quotes before process.argv exists, so parseCliArgs can never observe them and
// the assertion would be vacuous. The drive-root case above is the one that
// actually needed covering, because %V produces it.
