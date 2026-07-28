import { describe, it, expect } from 'vitest'
import { driveKey, sameDrive, uniqueName, winBasename, winDirname } from '../src/shared/pathutil'

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
describe('winBasename/winDirname', () => {
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
