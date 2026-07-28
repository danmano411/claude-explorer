import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitStatus, gitDiff, parseStatusZ } from '../src/main/git'
import { MAX_LINES } from '../src/main/fileread'

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

// A space and a non-ASCII byte: without -z git quotes and backslash-escapes both.
const MODIFIED = 'keep me.txt'
const RENAMED = 'renamed ünicode.txt'

let base: string // parent, holds both the repo and a plain folder
let repo: string
let plain: string

function run(args: string[], cwd = repo): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

beforeAll(() => {
  if (!hasGit) return
  // realpath: %TEMP% can hand back an 8.3 short path, which git would not echo back.
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ce-git-')))
  repo = join(base, 'repo with space')
  plain = join(base, 'plain')
  mkdirSync(join(repo, 'sub'), { recursive: true })
  mkdirSync(plain)

  run(['init', '-q', '.'])
  run(['config', 'user.email', 'test@example.com'])
  run(['config', 'user.name', 'Test'])
  run(['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(repo, 'sub', 'untouched.txt'), 'still\n')
  writeFileSync(join(repo, MODIFIED), 'alpha\nbravo\ncharlie\n')
  writeFileSync(join(repo, 'old.txt'), 'x\n')
  writeFileSync(join(repo, 'gone.txt'), 'y\n')
  run(['add', '-A'])
  run(['commit', '-qm', 'init'])

  // The working tree an AI just edited: one modified, one renamed, one deleted, one new.
  writeFileSync(join(repo, MODIFIED), 'alpha\nBRAVO\ncharlie\n')
  run(['mv', 'old.txt', RENAMED])
  unlinkSync(join(repo, 'gone.txt'))
  writeFileSync(join(repo, 'new file.txt'), 'z\n')
})

afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true })
})

describe('parseStatusZ', () => {
  it('does not swallow the record after a rename', () => {
    // A rename emits TWO NUL-separated paths for one entry; miss that and "b.txt"
    // below is parsed as a status record and every later entry shifts.
    const out = 'R  new.txt\0old.txt\0 M b.txt\0?? c.txt\0'
    expect(parseStatusZ(out, 'C:\\r')).toEqual([
      { path: 'C:\\r\\new.txt', status: 'renamed' },
      { path: 'C:\\r\\b.txt', status: 'modified' },
      { path: 'C:\\r\\c.txt', status: 'untracked' },
    ])
  })

  it('maps the status pair and joins repo-relative paths', () => {
    const out = 'A  add.txt\0 D del.txt\0?? un.txt\0MM both.txt\0C  copy.txt\0src.txt\0'
    expect(parseStatusZ(out, 'C:\\r').map((f) => f.status)).toEqual([
      'added',
      'deleted',
      'untracked',
      'modified',
      'added',
    ])
    expect(parseStatusZ('?? sub/dir/f.txt\0', 'C:\\r')[0].path).toBe('C:\\r\\sub\\dir\\f.txt')
  })
})

describe.skipIf(!hasGit)('gitStatus', () => {
  it('reports a real working tree', async () => {
    const r = await gitStatus(repo)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.repoRoot.toLowerCase()).toBe(repo.toLowerCase())
    const byName = new Map(r.files.map((f) => [f.path, f.status]))
    expect(byName.get(join(repo, MODIFIED))).toBe('modified')
    expect(byName.get(join(repo, RENAMED))).toBe('renamed')
    expect(byName.get(join(repo, 'gone.txt'))).toBe('deleted')
    expect(byName.get(join(repo, 'new file.txt'))).toBe('untracked')
    expect(r.files).toHaveLength(4)
  })

  it('finds the repo root from a subfolder', async () => {
    const r = await gitStatus(join(repo, 'sub'))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.repoRoot.toLowerCase()).toBe(repo.toLowerCase())
  })

  it('says notrepo — not error — for an ordinary folder', async () => {
    const r = await gitStatus(plain)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe('notrepo')
  })

  it('does not blame a missing git for a missing folder', async () => {
    const r = await gitStatus(join(base, 'does-not-exist'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe('error')
  })
})

describe.skipIf(!hasGit)('gitDiff', () => {
  it('returns the unified diff of a modified file', async () => {
    const r = await gitDiff(join(repo, MODIFIED))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.content).toContain('@@')
    expect(r.content).toContain('-bravo')
    expect(r.content).toContain('+BRAVO')
    expect(r.lines).toBeGreaterThan(5)
  })

  it('returns empty content — not an error — for a genuinely unchanged file', async () => {
    // sub/untouched.txt is committed and never edited. RENAMED is NOT a valid
    // subject here: `git mv` stages the rename, so it does have changes vs HEAD.
    const r = await gitDiff(join(repo, 'sub', 'untouched.txt'))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.content).toBe('')
  })

  it('shows a staged rename rather than pretending nothing changed', async () => {
    // This previously asserted empty content, which encoded the defect the M2
    // audit found: the gutter labels it 'renamed' from `git status`, while plain
    // `git diff` reports nothing because the rename is staged. Diffing against
    // HEAD is what makes the marker and the pane agree.
    const r = await gitDiff(join(repo, RENAMED))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.content).not.toBe('')
  })

  it('caps a huge diff at the viewer line limit instead of shipping it whole', async () => {
    // Its own repo: the shared one's status is asserted file-by-file above.
    const dir = join(base, 'big repo')
    mkdirSync(dir)
    run(['init', '-q', '.'], dir)
    run(['config', 'user.email', 'test@example.com'], dir)
    run(['config', 'user.name', 'Test'], dir)
    run(['config', 'commit.gpgsign', 'false'], dir)
    // A machine-generated file rewritten wholesale — the diff is ~2x MAX_LINES.
    const big = join(dir, 'big.txt')
    const gen = (w: string) => Array.from({ length: MAX_LINES + 5000 }, (_, i) => `${w} ${i}`)
    writeFileSync(big, gen('line').join('\n'))
    run(['add', '-A'], dir)
    run(['commit', '-qm', 'big'], dir)
    writeFileSync(big, gen('LINE').join('\n'))

    const r = await gitDiff(big)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.truncated).toBe(true)
    expect(r.lines).toBe(MAX_LINES)
    expect(r.content.split('\n')).toHaveLength(MAX_LINES)
  }, 20000)

  it('reports an error for a file outside any repo', async () => {
    writeFileSync(join(plain, 'a.txt'), 'x')
    const r = await gitDiff(join(plain, 'a.txt'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe('error')
  })
})

// --- Regressions found by the M2 adversarial audit ---
describe.skipIf(!hasGit)('gitDiff audit regressions', () => {
  it('shows STAGED changes, not just unstaged ones', async () => {
    // The gutter comes from `git status --porcelain`, which counts staged work.
    // Plain `git diff` does not, so a `git add`-ed file drew a change marker next
    // to an empty diff pane. Claude Code stages routinely, so this was the common
    // case, not an edge case.
    const f = join(repo, 'staged.txt')
    writeFileSync(f, 'before\n')
    run(['add', '--', 'staged.txt'])
    run(['commit', '-q', '-m', 'add staged.txt'])
    writeFileSync(f, 'after\n')
    run(['add', '--', 'staged.txt'])

    const r = await gitDiff(f)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.content).toContain('-before')
    expect(r.content).toContain('+after')
  })

  it('does not glob-expand a filename containing pathspec wildmatch characters', async () => {
    // `--` stops option parsing but NOT wildmatch. `[` and `]` are legal Windows
    // filename characters, so "[test].md" matched "t.md" too and rendered another
    // file's hunks under the clicked file's name.
    const bracket = join(repo, '[test].md')
    const collateral = join(repo, 't.md')
    writeFileSync(bracket, 'bracket original\n')
    writeFileSync(collateral, 'collateral original\n')
    run(['add', '--all'])
    run(['commit', '-q', '-m', 'add bracket + collateral'])
    writeFileSync(bracket, 'bracket CHANGED\n')
    writeFileSync(collateral, 'collateral CHANGED\n')

    const r = await gitDiff(bracket)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.content).toContain('bracket CHANGED')
    // The whole point: t.md's edit must not appear in [test].md's diff.
    expect(r.content).not.toContain('collateral CHANGED')
  })
})
