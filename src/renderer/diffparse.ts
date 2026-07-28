import { winDirname } from '../shared/pathutil'
import type { GitFileStatus } from '../shared/types'

/**
 * Pure logic behind the diff surface: the unified-diff parser (DiffView) and the
 * per-row git marks for the file listing (FileBrowser). No React, no Electron,
 * so it unit-tests against real `git diff` output.
 */

export type DiffLineKind = 'ctx' | 'add' | 'del'

export interface DiffLine {
  kind: DiffLineKind
  text: string // content with the leading '+'/'-'/' ' marker removed
  oldNo?: number // 1-based line number in the pre-image  (ctx + del)
  newNo?: number // 1-based line number in the post-image (ctx + add)
  noNewline?: boolean // "\ No newline at end of file" followed this line
}

export interface DiffHunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  heading: string // whatever git puts after the closing @@ (enclosing function)
  lines: DiffLine[]
}

export interface ParsedDiff {
  hunks: DiffHunk[]
  added: number
  removed: number
  binary: boolean
}

// Counts are optional in the format: "@@ -1 +1 @@" means one line each.
// ponytail: plain two-file hunks only. A CONFLICTED merge makes `git diff` emit
// combined "@@@" headers, which fall through as preamble and show as "no
// changes" — teach this regex the N-parent form if that case ever matters.
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/

/**
 * Parses unified diff text into hunks carrying REAL old/new line numbers — the
 * whole point of the surface is "which line of the file did Claude touch", so
 * the numbers come from the @@ header, never from a render-time counter.
 *
 * Anything outside a hunk (diff --git, index, ---/+++, mode changes) is
 * preamble and dropped. A hunk ends when its declared line counts are spent,
 * which is what keeps the next file's preamble — and the trailing '' from the
 * final newline — out of the previous hunk's body.
 */
export function parseUnifiedDiff(text: string): ParsedDiff {
  const hunks: DiffHunk[] = []
  let added = 0
  let removed = 0
  let binary = false
  let hunk: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0
  let oldLeft = 0
  let newLeft = 0

  for (const raw of text.split(/\r?\n/)) {
    const m = HUNK.exec(raw)
    if (m) {
      hunk = {
        oldStart: +m[1],
        oldCount: m[2] === undefined ? 1 : +m[2],
        newStart: +m[3],
        newCount: m[4] === undefined ? 1 : +m[4],
        heading: m[5] ?? '',
        lines: [],
      }
      hunks.push(hunk)
      oldNo = hunk.oldStart
      newNo = hunk.newStart
      oldLeft = hunk.oldCount
      newLeft = hunk.newCount
      continue
    }
    if (!hunk) {
      if (raw.startsWith('Binary files') || raw.startsWith('GIT binary patch')) binary = true
      continue
    }
    // Marks the PREVIOUS line, and consumes no line count of its own — so it is
    // checked before the exhaustion test, which is already true at that point.
    if (raw.startsWith('\\')) {
      const last = hunk.lines[hunk.lines.length - 1]
      if (last) last.noNewline = true
      continue
    }
    if (oldLeft <= 0 && newLeft <= 0) {
      hunk = null
      continue
    }
    const c = raw[0]
    if (c === '+') {
      hunk.lines.push({ kind: 'add', text: raw.slice(1), newNo })
      newNo++
      newLeft--
      added++
    } else if (c === '-') {
      hunk.lines.push({ kind: 'del', text: raw.slice(1), oldNo })
      oldNo++
      oldLeft--
      removed++
    } else {
      // ' ' context — also the empty string, because some producers strip the
      // trailing space from a blank context line.
      hunk.lines.push({ kind: 'ctx', text: raw.slice(1), oldNo, newNo })
      oldNo++
      newNo++
      oldLeft--
      newLeft--
    }
  }

  return { hunks, added, removed, binary }
}

/** A folder that merely CONTAINS changes, so the repo root is not silently blank. */
export type GutterMark = GitFileStatus['status'] | 'contains'

/** Windows paths compare case-insensitively, and git reports an untracked
 *  DIRECTORY with a trailing slash ("?? sub/"). One key shape for both. */
export function markKey(p: string): string {
  return p.replace(/[\\/]+$/, '').toLowerCase()
}

/**
 * Path -> marker for the file listing. Every changed file marks itself, and
 * every ancestor folder gets 'contains': without that, opening a repo root
 * after Claude edited `src/main/foo.ts` shows an empty gutter, which answers
 * the question wrong.
 */
export function gutterMarks(files: GitFileStatus[]): Map<string, GutterMark> {
  const marks = new Map<string, GutterMark>()
  for (const f of files) marks.set(markKey(f.path), f.status)
  for (const f of files) {
    let d = winDirname(markKey(f.path))
    // winDirname('c:') returns 'c:' — compare against the previous value rather
    // than trusting it to bottom out at ''.
    for (let prev = ''; d && d !== prev; prev = d, d = winDirname(d)) {
      if (marks.has(d)) break // already marked, so its ancestors are too
      marks.set(d, 'contains')
    }
  }
  return marks
}
