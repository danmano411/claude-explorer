import { describe, it, expect, vi } from 'vitest'
import { posix } from 'node:path'
import { driveKey, isWindows, sameDrive, uniqueName, winBasename, winDirname } from '../src/shared/pathutil'

describe('sameDrive', () => {
  it('compares drive letters case-insensitively', () => {
    expect(sameDrive('C:\\a\\b', 'c:\\x\\y')).toBe(true)
    expect(sameDrive('C:\\a', 'D:\\a')).toBe(false)
  })
})
describe('uniqueName', () => {
  it('returns name unchanged when free', () => {
    expect(uniqueName(['a.txt'], 'b.txt')).toBe('b.txt')
  })
  it('suffixes " (2)" before the extension on collision', () => {
    expect(uniqueName(['report.txt'], 'report.txt')).toBe('report (2).txt')
    expect(uniqueName(['report.txt', 'report (2).txt'], 'report.txt')).toBe('report (3).txt')
  })
  it('suffixes folders (no extension)', () => {
    expect(uniqueName(['src'], 'src')).toBe('src (2)')
  })
})
describe.skipIf(!isWindows)('winBasename/winDirname', () => {
  it('splits on backslash', () => {
    expect(winBasename('C:\\a\\b\\c.txt')).toBe('c.txt')
    expect(winDirname('C:\\a\\b\\c.txt')).toBe('C:\\a\\b')
  })
})

describe('driveKey', () => {
  it('reduces a local path to its drive letter', () => {
    expect(driveKey('C:\\Users\\dan')).toBe('c:')
  })
  it('reduces a UNC path to \\\\server\\share, not a bare backslash', () => {
    expect(driveKey('\\\\server\\share\\proj')).toBe('\\\\server\\share')
  })
  it('strips the \\\\?\\ long-path prefix', () => {
    expect(driveKey('\\\\?\\C:\\very\\long')).toBe('c:')
  })
})

describe('sameDrive (UNC)', () => {
  it('matches same local drive regardless of case', () => {
    expect(sameDrive('C:\\a', 'c:\\b')).toBe(true)
  })
  it('does NOT treat two different UNC shares as the same drive', () => {
    expect(sameDrive('\\\\alpha\\one\\x', '\\\\beta\\two\\y')).toBe(false)
  })
  it('matches the same UNC share', () => {
    expect(sameDrive('\\\\alpha\\one\\x', '\\\\alpha\\one\\y')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// KAN-89. Two independent checks, deliberately NOT "the new code agrees with
// itself" — CLAUDE.md's blind-parity trap is exactly this refactor's shape, and
// a shared helper would move both sides of such an assertion together.
//
//   1. The Windows arm is diffed against a VERBATIM COPY of the pre-refactor
//      implementation, frozen below. Nothing is shared between them.
//   2. The POSIX arm is diffed against node's real path.posix, which this file
//      can import and src/shared cannot (it is bundled into the renderer).
//
// Both run against one corpus of real inputs rather than hand-picked cases.
// ---------------------------------------------------------------------------

/** src/shared/pathutil.ts at 33f73e0, copied byte-for-byte. Do not "fix" or
 *  refactor these: they are the shipped 0.9.0 behaviour, and their whole job is
 *  to be an implementation the current one cannot accidentally share. */
const shipped = {
  winBasename(p: string): string {
    const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
    return parts[parts.length - 1] ?? p
  },
  winDirname(p: string): string {
    const trimmed = p.replace(/[\\/]+$/, '')
    const i = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
    return i <= 0 ? trimmed : trimmed.slice(0, i)
  },
  driveKey(p: string): string {
    const s = p.replace(/^\\\\\?\\/, '')
    const unc = /^\\\\([^\\]+)\\([^\\]+)/.exec(s)
    if (unc) return `\\\\${unc[1]}\\${unc[2]}`.toLowerCase()
    return s.slice(0, 2).toLowerCase()
  },
}

// Real shapes the app actually handles, plus the edges each implementation has
// a different opinion about (bare roots, doubled separators, trailing
// separators, and a backslash inside a POSIX filename — legal there, a
// separator on Windows).
const CORPUS = [
  // Windows
  'C:\\Users\\dan\\Documents\\proj\\file.txt',
  'C:\\Users\\dan',
  'C:\\a',
  'C:\\',
  'C:',
  'c:',
  'D:\\',
  '\\\\server\\share\\proj\\f.txt',
  '\\\\server\\share\\',
  '\\\\server\\share',
  '\\\\?\\C:\\very\\long\\path\\f.txt',
  'C:/Users/dan/mixed/f.txt',
  'C:\\a\\b\\',
  'C:\\a\\b\\\\',
  'C:\\Program Files\\App\\x.exe',
  'C:\\a\\.hidden',
  // POSIX
  '/home/dan/proj/file.txt',
  '/home/dan',
  '/home',
  '/',
  '//',
  '///',
  '//a',
  '//a/b',
  '/a',
  '/a/b/',
  '////a////b////',
  'a/b',
  'a//b',
  'a/b/',
  '/mnt/data/x',
  '/Users/dan/Library/Application Support/x',
  '/home/dan/weird\\name.txt', // a backslash is an ordinary character here
  '/.hidden',
  'relative\\path',
  // shapeless
  'file.txt',
  'a',
  '',
  '.',
  '..',
]

describe.skipIf(!isWindows)('KAN-89 — the Windows arm is the shipped 0.9.0 implementation', () => {
  for (const p of CORPUS) {
    it(`winBasename(${JSON.stringify(p)})`, () => {
      expect(winBasename(p)).toBe(shipped.winBasename(p))
    })
    it(`winDirname(${JSON.stringify(p)})`, () => {
      expect(winDirname(p)).toBe(shipped.winDirname(p))
    })
  }
  it('driveKey is untouched across the whole corpus', () => {
    expect(CORPUS.map(driveKey)).toEqual(CORPUS.map(shipped.driveKey))
  })
})

// The POSIX arm cannot be reached by calling the exports on a Windows box, so
// re-import the module with process.platform forced. Nothing is mocked: this is
// the real file, evaluated the way it will be evaluated on mac and Linux.
const asPosix = await (async () => {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  vi.resetModules()
  const mod = await import('../src/shared/pathutil')
  Object.defineProperty(process, 'platform', real)
  vi.resetModules()
  return mod
})()

describe('KAN-89 — the POSIX arm is path.posix', () => {
  it('the forced re-import really took the POSIX arm', () => {
    expect(asPosix.isWindows).toBe(false)
    expect(isWindows).toBe(process.platform === 'win32') // the static import is untouched
  })
  for (const p of CORPUS) {
    it(`basename(${JSON.stringify(p)})`, () => {
      expect(asPosix.winBasename(p)).toBe(posix.basename(p))
    })
    it(`dirname(${JSON.stringify(p)})`, () => {
      expect(asPosix.winDirname(p)).toBe(posix.dirname(p))
    })
  }
})
