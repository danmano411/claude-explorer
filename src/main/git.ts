import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { GitFileStatus, GitStatusResult, ReadResult } from '../shared/types'
import { humanizeFsError } from './fs'
// A diff is viewer text like any other, so it gets the viewer's caps (KAN-19)
// rather than a second set of numbers that could drift apart.
import { MAX_BYTES, MAX_CHARS, MAX_LINES } from './fileread'

const exec = promisify(execFile)

/**
 * KAN-68: this was `existsSync`, reached with a renderer-supplied directory on
 * EVERY navigation — FileBrowser fires gitStatus from a `[dir]` effect. On an
 * unreachable UNC path that pinned the whole main process for ~21 seconds (no
 * IPC, no pty:data, no paint): the same freeze KAN-41/65/68 took out of the
 * three path resolvers, arriving through a different door. Async parks one of
 * libuv's four workers instead of the process. Measured in test/harness/gate.mjs
 * — a folder listing issued during this call took 21,048 ms before, 54 ms after.
 *
 * Ungated on purpose. This is the user's own navigation over authenticated
 * renderer IPC, one call per navigation, and the argument written down at
 * policy.ts's `gateOne` applies unchanged: a queue here would bound nothing a
 * caller outside the app can reach, and would put the user behind themselves.
 */
const exists = (dir: string) => access(dir).then(() => true, () => false)

/**
 * execFile with an argv array — NEVER exec/shell:true. Every path below is
 * user-controlled, and a shell would interpret `&` in a folder name: exactly the
 * injection fixed in ide.ts under KAN-15 R6.
 */
function git(cwd: string, args: string[]) {
  return exec('git', args, { cwd, maxBuffer: MAX_BYTES, windowsHide: true, encoding: 'utf8' })
}

/**
 * Most folders a user opens are not repos and git may not be installed at all —
 * both are ordinary states with their own empty state, not errors.
 */
function classify(err: unknown): { kind: 'notrepo' | 'nogit' | 'error'; reason: string } {
  const e = err as (NodeJS.ErrnoException & { stderr?: string }) | undefined
  if (e?.code === 'ENOENT') return { kind: 'nogit', reason: 'Git is not installed' }
  if (e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
    return { kind: 'error', reason: 'Too much output to display' }
  const stderr = (e?.stderr || '').trim()
  if (/not a git repository/i.test(stderr))
    return { kind: 'notrepo', reason: 'Not a Git repository' }
  return { kind: 'error', reason: stderr.split('\n')[0] || humanizeFsError(err) }
}

function mapStatus(xy: string): GitFileStatus['status'] {
  if (xy === '??') return 'untracked'
  if (xy.includes('R')) return 'renamed'
  if (xy.includes('D')) return 'deleted'
  if (xy.includes('A') || xy.includes('C')) return 'added'
  return 'modified'
}

/**
 * Parses `git status --porcelain=v1 -z`. Records are `XY<space>path\0` with NO
 * trailing newline; -z is what keeps git from quoting and backslash-escaping any
 * path with a space or non-ASCII byte.
 */
export function parseStatusZ(out: string, root: string): GitFileStatus[] {
  const fields = out.split('\0')
  const files: GitFileStatus[] = []
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i]
    if (!rec || rec.length < 4) continue // final field after the terminating NUL
    const xy = rec.slice(0, 2)
    // R and C emit a SECOND field (the path renamed/copied FROM). Skipping it is
    // what stops the next record from being read as a path.
    if (xy.includes('R') || xy.includes('C')) i++
    files.push({ path: join(root, rec.slice(3)), status: mapStatus(xy) })
  }
  return files
}

/** Working-tree status for the repo containing `dir` (any path inside it). */
export async function gitStatus(dir: string): Promise<GitStatusResult> {
  // A missing cwd also makes spawn fail with ENOENT, which would cry "git is not
  // installed" at a folder that was merely deleted.
  if (!(await exists(dir)))
    return { ok: false, kind: 'error', reason: humanizeFsError({ code: 'ENOENT' }) }
  try {
    const top = await git(dir, ['rev-parse', '--show-toplevel'])
    // git answers with forward slashes ("C:/Users/..."); resolve() makes it Windows.
    const repoRoot = resolve(top.stdout.trim())
    const { stdout } = await git(dir, ['status', '--porcelain=v1', '-z'])
    return { ok: true, repoRoot, files: parseStatusZ(stdout, repoRoot) }
  } catch (err) {
    const { kind, reason } = classify(err)
    return { ok: false, kind, reason }
  }
}

/**
 * Unified diff of one file against HEAD, as text for the viewer.
 *
 * Diffed against HEAD, not the index: the gutter marks come from
 * `git status --porcelain`, which counts STAGED changes too. Plain `git diff`
 * shows only unstaged work, so any file that has been `git add`-ed showed a
 * change marker next to an empty diff pane. Claude Code stages files routinely,
 * so that was the common case failing, not an edge case.
 */
export async function gitDiff(path: string): Promise<ReadResult> {
  try {
    const dir = dirname(path)
    if (!(await exists(dir)))
      return { ok: false, kind: 'error', reason: humanizeFsError({ code: 'ENOENT' }) }
    // --literal-pathspecs because `--` stops option parsing but NOT pathspec
    // wildmatch: `[` and `]` are legal Windows filename characters, so a file
    // named "[test].md" would glob-expand and pull OTHER files' hunks into this
    // file's diff. Run in the file's own folder and pass the bare name.
    const args = ['--literal-pathspecs', 'diff', 'HEAD', '--', basename(path)]
    let stdout: string
    try {
      ;({ stdout } = await git(dir, args))
    } catch (headErr) {
      // A repo with no commits yet has no HEAD to diff against; fall back to the
      // working-tree diff rather than reporting a fault the user cannot act on.
      if (!/unknown revision|bad revision|ambiguous argument/i.test(String(headErr)))
        throw headErr
      ;({ stdout } = await git(dir, ['--literal-pathspecs', 'diff', '--', basename(path)]))
    }
    // ponytail: the char/line cap is 6 lines duplicated from readTextFile. Pull it
    // out into a shared capText() the moment a third caller wants it.
    let content = stdout
    let truncated = false
    if (content.length > MAX_CHARS) {
      content = content.slice(0, MAX_CHARS)
      truncated = true
    }
    const parts = content.split('\n')
    if (parts.length > MAX_LINES) {
      content = parts.slice(0, MAX_LINES).join('\n')
      truncated = true
    }
    const lines = content === '' ? 0 : Math.min(parts.length, MAX_LINES)
    return { ok: true, content, truncated, lines }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
      return { ok: false, kind: 'toolarge', reason: 'This diff is too large to display' }
    return { ok: false, kind: 'error', reason: classify(err).reason }
  }
}
