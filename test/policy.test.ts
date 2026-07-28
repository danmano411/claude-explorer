import { describe, it, expect } from 'vitest'
import { classify, check, gate, CONFIRM_WORD } from '../src/main/policy'

const ROOTS = ['C:\\FakeWindows', 'C:\\Fake Program Files']

describe('classify', () => {
  it('flags a system root and any descendant', () => {
    expect(classify('C:\\FakeWindows', ROOTS)).toBe('system')
    expect(classify('C:\\FakeWindows\\System32\\drivers', ROOTS)).toBe('system')
  })
  it('is case- and separator-insensitive', () => {
    expect(classify('c:/fakewindows/system32', ROOTS)).toBe('system')
    expect(classify('C:\\FakeWindows\\', ROOTS)).toBe('system')
  })
  it('does not flag a sibling with a shared prefix', () => {
    expect(classify('C:\\FakeWindowsBackup', ROOTS)).toBe('normal')
  })
  it('flags drive roots', () => {
    expect(classify('C:\\', ROOTS)).toBe('driveRoot')
    expect(classify('D:\\', ROOTS)).toBe('driveRoot')
  })
  it('flags the app trash dir at any depth', () => {
    expect(classify('C:\\.claude-explorer-trash', ROOTS)).toBe('trash')
    expect(classify('C:\\.claude-explorer-trash\\abc\\f.txt', ROOTS)).toBe('trash')
  })
  it('treats ordinary paths as normal', () => {
    expect(classify('C:\\Users\\dan\\proj', ROOTS)).toBe('normal')
  })
})

describe('check', () => {
  it('allows normal deletes in both modes with no confirmation', () => {
    expect(check('delete', ['C:\\Users\\dan\\a'], 'explorer', ROOTS).kind).toBe('allow')
    expect(check('delete', ['C:\\Users\\dan\\a'], 'developer', ROOTS).kind).toBe('allow')
  })
  it('denies system paths in explorer mode and names the way forward', () => {
    const v = check('delete', ['C:\\FakeWindows\\x'], 'explorer', ROOTS)
    expect(v.kind).toBe('deny')
    if (v.kind === 'deny') expect(v.reason).toMatch(/Developer mode/i)
  })
  it('requires typed confirmation for system paths in developer mode', () => {
    const v = check('delete', ['C:\\FakeWindows\\x'], 'developer', ROOTS)
    expect(v.kind).toBe('confirm')
    if (v.kind === 'confirm') expect(v.typed).toBe(true)
  })
  it('denies the trash dir in BOTH modes', () => {
    for (const m of ['explorer', 'developer'] as const) {
      expect(check('delete', ['C:\\.claude-explorer-trash\\x'], m, ROOTS).kind).toBe('deny')
    }
  })
  it('denies permanent delete outright in explorer mode', () => {
    expect(check('permanentDelete', ['C:\\Users\\dan\\a'], 'explorer', ROOTS).kind).toBe('deny')
  })
  it('requires typed confirmation for permanent delete in developer mode', () => {
    const v = check('permanentDelete', ['C:\\Users\\dan\\a'], 'developer', ROOTS)
    expect(v.kind).toBe('confirm')
    if (v.kind === 'confirm') expect(v.typed).toBe(true)
  })
  it('blocks if ANY path in a multi-select is protected', () => {
    const v = check('delete', ['C:\\Users\\dan\\ok', 'C:\\FakeWindows\\bad'], 'explorer', ROOTS)
    expect(v.kind).toBe('deny')
  })
})

describe('gate', () => {
  it('returns null when allowed', () => {
    expect(gate('delete', ['C:\\Users\\dan\\a'], 'explorer', undefined, ROOTS)).toBeNull()
  })
  it('returns the verdict when denied, even with a confirm value', () => {
    expect(gate('delete', ['C:\\FakeWindows\\x'], 'explorer', CONFIRM_WORD, ROOTS)).not.toBeNull()
  })
  it('rejects a wrong or missing typed confirmation', () => {
    expect(gate('delete', ['C:\\FakeWindows\\x'], 'developer', undefined, ROOTS)).not.toBeNull()
    expect(gate('delete', ['C:\\FakeWindows\\x'], 'developer', 'yes', ROOTS)).not.toBeNull()
    expect(gate('delete', ['C:\\FakeWindows\\x'], 'developer', 'confirm', ROOTS)).not.toBeNull()
  })
  it('passes with the exact confirm word', () => {
    expect(gate('delete', ['C:\\FakeWindows\\x'], 'developer', CONFIRM_WORD, ROOTS)).toBeNull()
  })
})
