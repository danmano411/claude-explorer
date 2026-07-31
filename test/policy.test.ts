import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { classify, check, gate, canonicalize, canonicalizeAsync, CONFIRM_WORD, TRASH_DIR_NAME } from '../src/main/policy'
import type { Op } from '../src/main/policy'

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
  it('flags drive roots in \\\\?\\ and UNC spellings', () => {
    expect(classify('\\\\?\\C:\\', ROOTS)).toBe('driveRoot')
    expect(classify('\\\\?\\C:', ROOTS)).toBe('driveRoot')
    expect(classify('\\\\server\\share', ROOTS)).toBe('driveRoot')
    expect(classify('\\\\server\\share\\', ROOTS)).toBe('driveRoot')
    expect(classify('\\\\?\\UNC\\server\\share', ROOTS)).toBe('driveRoot')
  })
  it('does not flag a folder inside a UNC share', () => {
    expect(classify('\\\\server\\share\\proj', ROOTS)).toBe('normal')
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
  it('leaves paths untouched when an identity resolver is injected', () => {
    const id = (p: string) => p
    expect(gate('delete', ['C:\\FakeWindows\\x'], 'explorer', undefined, ROOTS, id)).not.toBeNull()
    expect(gate('delete', ['C:\\Users\\dan\\a'], 'explorer', undefined, ROOTS, id)).toBeNull()
  })
})

// These run against the real filesystem: every input below is a different
// spelling of a REAL protected target, and lexical matching misses all of them.
describe('gate canonicalises before classifying', () => {
  let base = ''
  let junction = ''
  let shortTrash = ''

  beforeAll(() => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'policy-canon-')))
    fs.mkdirSync(path.join(base, TRASH_DIR_NAME))
    const listing = execFileSync('cmd', ['/c', 'dir', '/x', '/a', base], { encoding: 'latin1' })
    const row = listing.split(/\r?\n/).find((l) => l.endsWith(TRASH_DIR_NAME))
    const short = row?.match(/(\S*~\d\S*)/)?.[1]
    if (short) shortTrash = path.join(base, short)
    try {
      const link = path.join(base, 'link')
      execFileSync('cmd', ['/c', 'mklink', '/J', link, 'C:\\Windows\\System32'], { stdio: 'pipe' })
      junction = link
    } catch {
      junction = '' // no privilege to create junctions — that test is skipped
    }
  })

  afterAll(() => {
    // Remove the junction FIRST and only recurse if it is gone: a recursive rm
    // that followed it would be pointed at C:\Windows\System32.
    try {
      if (junction) fs.rmdirSync(junction)
    } catch {
      /* leave the temp dir behind rather than risk following the junction */
    }
    if (base && !fs.existsSync(path.join(base, 'link')))
      fs.rmSync(base, { recursive: true, force: true })
  })

  const denied = (p: string) => gate('delete', [p], 'explorer')

  it('catches an 8.3 short name for a system root', () => {
    expect(classify('C:\\PROGRA~1')).toBe('normal') // lexically invisible
    expect(canonicalize('C:\\PROGRA~1')).toBe('C:\\Program Files')
    expect(denied('C:\\PROGRA~1')).not.toBeNull()
  })

  it('catches .. traversal into a system root', () => {
    // NOT path.join — that would normalise the `..` away before classify sees it.
    const p = os.homedir() + '\\..\\..\\Windows\\System32'
    expect(classify(p)).toBe('normal')
    expect(denied(p)).not.toBeNull()
  })

  it('catches the \\\\?\\ spelling of a system root', () => {
    expect(classify('\\\\?\\C:\\Windows\\System32')).toBe('normal')
    expect(denied('\\\\?\\C:\\Windows\\System32')).not.toBeNull()
  })

  it('catches an 8.3 short name for the trash dir, in both modes', () => {
    if (!shortTrash) return // volume has 8.3 name creation disabled
    expect(classify(shortTrash)).toBe('normal')
    expect(gate('delete', [shortTrash], 'explorer')).not.toBeNull()
    // Trash is denied outright, so even a typed confirm in developer mode fails.
    expect(gate('delete', [shortTrash], 'developer', CONFIRM_WORD)).not.toBeNull()
  })

  it('catches a junction pointing into a system root', () => {
    if (!junction) return
    const p = path.join(junction, 'drivers')
    expect(classify(p)).toBe('normal')
    expect(denied(p)).not.toBeNull()
  })

  it('catches a not-yet-existing target under a junction (mkdir/newFile)', () => {
    if (!junction) return
    const p = path.join(junction, 'does-not-exist-yet', 'x.txt')
    expect(canonicalize(p)).toBe(path.join('C:\\Windows\\System32', 'does-not-exist-yet', 'x.txt'))
    expect(denied(p)).not.toBeNull()
  })

  it('leaves an ordinary temp path alone', () => {
    expect(gate('delete', [path.join(base, 'ordinary.txt')], 'explorer')).toBeNull()
  })
})

// D4: check() returns on the FIRST protected path, so a twenty-item selection
// with one bad entry used to yield a reason naming the class but not the path.
// The renderer prints the reason verbatim; without the path the user cannot
// tell which item to deselect.
describe('D4 — a refusal names the offending path', () => {
  it('names the system path that blocked an explorer-mode multi-select', () => {
    const v = check('delete', ['C:\\Users\\dan\\ok', 'C:\\FakeWindows\\bad'], 'explorer', ROOTS)
    expect(v.kind).toBe('deny')
    if (v.kind === 'deny') expect(v.reason).toContain('C:\\FakeWindows\\bad')
  })
  it('names the system path in the developer-mode confirm prompt', () => {
    const v = check('delete', ['C:\\Users\\dan\\ok', 'C:\\FakeWindows\\bad'], 'developer', ROOTS)
    expect(v.kind).toBe('confirm')
    if (v.kind === 'confirm') expect(v.reason).toContain('C:\\FakeWindows\\bad')
  })
  it('names the drive root', () => {
    const v = check('delete', ['C:\\Users\\dan\\ok', 'D:\\'], 'explorer', ROOTS)
    expect(v.kind).toBe('deny')
    if (v.kind === 'deny') expect(v.reason).toContain('D:\\')
  })
  it('names the trash path', () => {
    const bad = `C:\\${TRASH_DIR_NAME}\\abc\\f.txt`
    const v = check('move', ['C:\\Users\\dan\\ok', bad], 'explorer', ROOTS)
    expect(v.kind).toBe('deny')
    if (v.kind === 'deny') expect(v.reason).toContain(bad)
  })
  it('still keeps the class in the reason', () => {
    const v = check('delete', ['C:\\FakeWindows\\bad'], 'explorer', ROOTS)
    if (v.kind === 'deny') expect(v.reason).toMatch(/system folder/i)
  })
})

// D5: gate() carried `v.typed ? confirm === CONFIRM_WORD : confirm !== undefined`.
// The untyped half was unreachable, and would have accepted ANY defined string
// including ''. The branch is gone; these pin both halves of why that is safe.
describe('D5 — confirmation requires the exact word', () => {
  it('check() never emits an untyped confirm verdict', () => {
    const ops: Op[] = ['delete', 'permanentDelete', 'move', 'copy', 'rename', 'mkdir', 'newFile']
    const paths = ['C:\\Users\\dan\\ok', 'C:\\FakeWindows\\bad', 'C:\\', `C:\\${TRASH_DIR_NAME}\\x`]
    for (const op of ops) {
      for (const p of paths) {
        for (const mode of ['explorer', 'developer'] as const) {
          const v = check(op, [p], mode, ROOTS)
          if (v.kind === 'confirm') expect(v.typed).toBe(true)
        }
      }
    }
  })
  it('rejects empty and whitespace-only confirmations', () => {
    expect(gate('delete', ['C:\\FakeWindows\\x'], 'developer', '', ROOTS)).not.toBeNull()
    expect(gate('delete', ['C:\\FakeWindows\\x'], 'developer', '   ', ROOTS)).not.toBeNull()
    expect(gate('delete', ['C:\\FakeWindows\\x'], 'developer', '\t\n', ROOTS)).not.toBeNull()
  })
})

describe('canonicalize', () => {
  it('never throws on garbage', () => {
    expect(() => canonicalize('')).not.toThrow()
    expect(() => canonicalize('Z:\\nope\\<>|')).not.toThrow()
  })

  // canonicalizeAsync is what every path from OUTSIDE the app resolves through
  // (mcp.ts), because realpathSync.native on an unreachable SMB host pins main
  // for ~21 seconds. It is only safe to route those through it if it answers
  // IDENTICALLY — a botched port of the ancestor walk would silently change what
  // a caller-supplied path resolves to, and gate() classifies the result.
  it('canonicalizeAsync agrees with canonicalize, including the ancestor walk', async () => {
    const cases = [
      'C:\\PROGRA~1', // 8.3 short name -> a real system root
      path.join(os.tmpdir(), 'ce-does-not-exist-yet', 'x.txt'), // the walk
      os.homedir() + '\\..\\..\\Windows\\System32', // .. traversal
      '\\\\?\\C:\\Windows\\System32',
      'Z:\\nope\\<>|', // garbage: neither may throw
      '',
    ]
    for (const p of cases) expect(await canonicalizeAsync(p)).toBe(canonicalize(p))
  })
})
