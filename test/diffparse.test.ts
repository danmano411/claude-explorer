import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseUnifiedDiff, gutterMarks, markKey } from '../src/renderer/diffparse'
import type { GitFileStatus } from '../src/shared/types'

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

let repo: string
const lines = (n: number, word = 'line') => Array.from({ length: n }, (_, i) => `${word} ${i + 1}`)

function run(args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
}
function diff(args: string[]): string {
  return execFileSync('git', ['diff', ...args], { cwd: repo, encoding: 'utf8' })
}
function show(rev: string): string {
  return execFileSync('git', ['show', rev], { cwd: repo, encoding: 'utf8' })
}

beforeAll(() => {
  if (!hasGit) return
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'ce-diff-')))
  run(['init', '-q', '.'])
  run(['config', 'user.email', 'test@example.com'])
  run(['config', 'user.name', 'Test'])
  run(['config', 'commit.gpgsign', 'false'])
  run(['config', 'core.autocrlf', 'false']) // keep LF, so the fixtures are the bytes we wrote

  writeFileSync(join(repo, 'multi.txt'), lines(40).join('\n') + '\n')
  writeFileSync(join(repo, 'tail.txt'), 'alpha\nbravo\ncharlie') // no trailing newline
  writeFileSync(join(repo, 'gone.txt'), 'x\ny\n')
  run(['add', '-A'])
  run(['commit', '-qm', 'init'])

  // The working tree an AI just edited.
  const edited = lines(40)
  edited[2] = 'THIRD'
  edited.splice(10, 0, 'inserted after ten') // shifts every later line by one
  edited[30] = 'THIRTIETH-ISH'
  writeFileSync(join(repo, 'multi.txt'), edited.join('\n') + '\n')
  writeFileSync(join(repo, 'tail.txt'), 'alpha\nBRAVO\nCHARLIE') // still no trailing newline
  unlinkSync(join(repo, 'gone.txt'))
  writeFileSync(join(repo, 'new.txt'), 'fresh 1\nfresh 2\n')
  run(['add', 'new.txt']) // untracked files have no diff; staged ones do
})

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true })
})

/** Every numbered line must name the line it actually is in the real file. */
function expectNumbersMatchFiles(text: string, oldFile: string[], newFile: string[]) {
  const d = parseUnifiedDiff(text)
  let checked = 0
  for (const h of d.hunks) {
    for (const l of h.lines) {
      if (l.oldNo !== undefined) {
        expect([l.oldNo, oldFile[l.oldNo - 1]]).toEqual([l.oldNo, l.text])
        checked++
      }
      if (l.newNo !== undefined) {
        expect([l.newNo, newFile[l.newNo - 1]]).toEqual([l.newNo, l.text])
        checked++
      }
    }
  }
  expect(checked).toBeGreaterThan(0)
  return d
}

describe.skipIf(!hasGit)('parseUnifiedDiff on real git output', () => {
  it('numbers every line of a multi-hunk diff against the real files', () => {
    const oldFile = show('HEAD:multi.txt').split('\n')
    const newFile = lines(40)
    newFile[2] = 'THIRD'
    newFile.splice(10, 0, 'inserted after ten')
    newFile[30] = 'THIRTIETH-ISH'

    const d = expectNumbersMatchFiles(diff(['--', 'multi.txt']), oldFile, newFile)

    // Three edits far enough apart to be three hunks — the second and third only
    // land on the right lines if the @@ headers are read, not counted.
    expect(d.hunks.length).toBeGreaterThan(1)
    expect(d.added).toBe(3) // THIRD, inserted after ten, THIRTIETH-ISH
    expect(d.removed).toBe(2)
    expect(d.hunks[0].oldStart).toBeGreaterThan(0)
    // The post-image is one line longer, so later hunks are offset.
    const last = d.hunks[d.hunks.length - 1]
    expect(last.newStart).toBe(last.oldStart + 1)
  })

  it('flags "\\ No newline at end of file" on the line it belongs to', () => {
    const d = parseUnifiedDiff(diff(['--', 'tail.txt']))
    const flagged = d.hunks.flatMap((h) => h.lines).filter((l) => l.noNewline)
    // The last line changed, so git emits the marker TWICE — once for the old
    // side, once for the new — and each must land on the line above it.
    expect(flagged.map((l) => [l.kind, l.text])).toEqual([
      ['del', 'charlie'],
      ['add', 'CHARLIE'],
    ])
    // The marker itself is never a diff line.
    expect(d.hunks.flatMap((h) => h.lines).some((l) => l.text.startsWith(' No newline'))).toBe(false)
    expect(d.added).toBe(2)
    expect(d.removed).toBe(2)
  })

  it('reads a staged new file (old side is 0,0)', () => {
    const d = parseUnifiedDiff(diff(['--cached', '--', 'new.txt']))
    expect(d.hunks).toHaveLength(1)
    expect(d.hunks[0].oldStart).toBe(0)
    expect(d.hunks[0].oldCount).toBe(0)
    expect(d.hunks[0].newStart).toBe(1)
    expect(d.hunks[0].lines.map((l) => [l.kind, l.newNo, l.text])).toEqual([
      ['add', 1, 'fresh 1'],
      ['add', 2, 'fresh 2'],
    ])
    expect(d.hunks[0].lines.every((l) => l.oldNo === undefined)).toBe(true)
  })

  it('reads a deleted file as an all-removed hunk', () => {
    const d = parseUnifiedDiff(diff(['--', 'gone.txt']))
    expect(d.removed).toBe(2)
    expect(d.added).toBe(0)
    expect(d.hunks[0].newCount).toBe(0)
    expect(d.hunks[0].lines.map((l) => l.oldNo)).toEqual([1, 2])
  })

  it('keeps two files in one diff apart instead of merging their hunks', () => {
    const d = parseUnifiedDiff(diff([]))
    // 3 hunks in multi.txt + 1 in tail.txt + 1 in gone.txt; the "diff --git"
    // preamble between files must not be swallowed as content.
    expect(d.hunks.length).toBeGreaterThanOrEqual(4)
    expect(d.hunks.every((h) => h.lines.length > 0)).toBe(true)
    expect(d.hunks.flatMap((h) => h.lines).some((l) => l.text.startsWith('diff --git'))).toBe(false)
    expect(d.hunks.flatMap((h) => h.lines).some((l) => l.text.startsWith('++ b/'))).toBe(false)
  })

  it('carries the enclosing-context heading from the @@ line', () => {
    const withHeading = parseUnifiedDiff(diff(['-U1', '--', 'multi.txt']))
    expect(withHeading.hunks.length).toBeGreaterThan(1)
    expect(withHeading.hunks[1].heading.length).toBeGreaterThan(0)
  })
})

describe('parseUnifiedDiff edge cases', () => {
  it('is empty — not broken — for an unchanged file', () => {
    expect(parseUnifiedDiff('')).toEqual({ hunks: [], added: 0, removed: 0, binary: false })
  })

  it('defaults an omitted count to 1', () => {
    const d = parseUnifiedDiff('@@ -7 +9 @@\n-a\n+b\n')
    expect(d.hunks[0]).toMatchObject({ oldStart: 7, oldCount: 1, newStart: 9, newCount: 1 })
    expect(d.hunks[0].lines).toEqual([
      { kind: 'del', text: 'a', oldNo: 7 },
      { kind: 'add', text: 'b', newNo: 9 },
    ])
  })

  it('keeps a blank context line even when the trailing space was stripped', () => {
    const d = parseUnifiedDiff('@@ -1,3 +1,3 @@\n a\n\n-c\n+C\n')
    expect(d.hunks[0].lines.map((l) => [l.kind, l.oldNo, l.text])).toEqual([
      ['ctx', 1, 'a'],
      ['ctx', 2, ''],
      ['del', 3, 'c'],
      ['add', undefined, 'C'],
    ])
  })

  it('reports a binary change instead of pretending it has hunks', () => {
    const d = parseUnifiedDiff(
      'diff --git a/i.png b/i.png\nindex 1..2 100644\nBinary files a/i.png and b/i.png differ\n',
    )
    expect(d.binary).toBe(true)
    expect(d.hunks).toEqual([])
  })

  it('tolerates a diff truncated mid-hunk', () => {
    const d = parseUnifiedDiff('@@ -1,50 +1,50 @@\n a\n-b\n+B')
    expect(d.hunks[0].lines).toHaveLength(3)
    expect(d.added).toBe(1)
  })
})

describe('gutterMarks', () => {
  const F = (path: string, status: GitFileStatus['status']): GitFileStatus => ({ path, status })

  it('marks the file and every ancestor folder', () => {
    const m = gutterMarks([F('C:\\r\\src\\main\\foo.ts', 'modified')])
    expect(m.get('c:\\r\\src\\main\\foo.ts')).toBe('modified')
    expect(m.get('c:\\r\\src\\main')).toBe('contains')
    expect(m.get('c:\\r\\src')).toBe('contains')
    expect(m.get('c:\\r')).toBe('contains')
  })

  it('never lets a folder roll-up overwrite a real status', () => {
    const m = gutterMarks([
      F('C:\\r\\sub\\', 'untracked'), // git reports an untracked DIR with a trailing slash
      F('C:\\r\\sub\\deep\\a.txt', 'modified'),
    ])
    expect(m.get('c:\\r\\sub')).toBe('untracked')
    expect(m.get('c:\\r')).toBe('contains')
  })

  it('matches paths case-insensitively, as Windows does', () => {
    const m = gutterMarks([F('C:\\Repo\\Src\\A.ts', 'added')])
    expect(m.get(markKey('c:\\repo\\src\\a.ts'))).toBe('added')
    expect(m.get(markKey('C:\\REPO\\SRC\\'))).toBe('contains')
  })

  it('terminates at the drive root', () => {
    expect(gutterMarks([F('C:\\a.txt', 'modified')]).size).toBeLessThan(4)
  })
})
