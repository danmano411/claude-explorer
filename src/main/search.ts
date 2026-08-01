import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { winBasename } from '../shared/pathutil'
import type { SearchDone, SearchHit, SearchQuery } from '../shared/types'

/** Hard ceiling on hits per search. Past this nobody is reading the list, and
 *  walking the rest of the tree only costs battery. Reported as `truncated`. */
export const MAX_HITS = 2000

/** Batch window. One IPC message per match drowns the channel on a dense query
 *  (a bare "e" over a repo is tens of thousands of matches). */
const BATCH_SIZE = 50
const BATCH_MS = 100

/**
 * Absolute path to the bundled ripgrep, or null if it is missing.
 *
 * Deliberately returns null instead of throwing: a missing binary must degrade
 * search to filename-only rather than making the feature vanish, so the caller
 * turns this into SearchDone { kind: 'norg' }.
 */
export function resolveRg(): string | null {
  // @vscode/ripgrep 1.18 ships the binary in a per-platform optional dependency
  // (the esbuild pattern) rather than downloading it in a postinstall, so the
  // exe lives in a SIBLING package, not under @vscode/ripgrep itself.
  //
  // KAN-90: which sibling is the platform's business. All four POSIX packages
  // (@vscode/ripgrep-darwin-x64/-arm64, -linux-x64/-arm64) are already optional
  // dependencies in the lockfile and ship `bin/rg` with no extension, so this is
  // a name, not a new dependency. process.platform is used raw rather than
  // KAN-89's isWindows because there are three answers here, not two.
  const plat = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg'
  const pkg = (arch: string) => `node_modules/@vscode/ripgrep-${plat}-${arch}/bin/${exe}`
  // Both arches are probed rather than trusting process.arch: an x64 build runs
  // under Rosetta on Apple Silicon (and under WOW64 on Windows) reporting the
  // arch it was BUILT for, not the package npm actually installed.
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, exe)]
    : [
        join(app.getAppPath(), pkg('x64')),
        join(app.getAppPath(), pkg('arm64')),
        join(__dirname, '../../', pkg('x64')),
      ]
  return candidates.find((p) => existsSync(p)) ?? null
}

/**
 * Run `rg --version` once at startup and throw the result away.
 *
 * On-access antivirus scans a newly installed 5.4 MB unsigned binary the first
 * time it executes, and that scan blocks the launch. Measured on this machine:
 * the first `rg --version` took 655 SECONDS; every call after it took ~1.5s.
 * Without this, the user's first search after installing appears to hang.
 * Fire-and-forget, off the UI path, so the cost lands before anyone searches.
 */
export function warmRg(): void {
  const rg = resolveRg()
  if (!rg) return
  try {
    const c = spawn(rg, ['--version'], { windowsHide: true, stdio: 'ignore' })
    c.on('error', () => {})
    c.unref()
  } catch { /* warming is best effort; a failure here must never break startup */ }
}

/**
 * ripgrep arguments for a query. Pure and exported so the flag mapping is
 * unit-testable without spawning anything.
 */
export function buildArgs(q: SearchQuery): string[] {
  const args: string[] = []
  if (q.content) {
    // --json implies line numbers and byte columns.
    args.push('--json')
    if (!q.regex) args.push('--fixed-strings')
    if (!q.caseSensitive) args.push('--ignore-case')
  } else {
    // Names only: --files lists paths without reading a single byte of content.
    args.push('--files')
  }
  // Developer mode searches everything. Explorer mode keeps ripgrep's defaults,
  // which already honour .gitignore and skip hidden files — exactly the M1 split.
  if (q.includeIgnored) args.push('-uu')
  if (q.content) args.push('--', q.query, q.root)
  else args.push('--', q.root)
  return args
}

/** Substring match on the basename, for --files mode. Uses the shared
 *  winBasename so UNC paths and forward slashes behave as everywhere else. */
export function nameMatches(path: string, query: string, caseSensitive: boolean): boolean {
  const base = winBasename(path)
  return caseSensitive ? base.includes(query) : base.toLowerCase().includes(query.toLowerCase())
}

/**
 * Splits a byte stream into complete lines, holding any partial trailing line
 * until the rest of it arrives.
 *
 * This is the part a naive implementation gets wrong: ripgrep's JSON objects are
 * one per line, but a chunk boundary lands mid-line often enough that
 * `chunk.split('\n')` per chunk silently drops or corrupts matches on any large
 * result set.
 */
export function makeLineSplitter(onLine: (line: string) => void): {
  push: (chunk: string) => void
  flush: () => void
} {
  let rest = ''
  return {
    push(chunk) {
      rest += chunk
      let nl: number
      while ((nl = rest.indexOf('\n')) !== -1) {
        const line = rest.slice(0, nl).replace(/\r$/, '')
        rest = rest.slice(nl + 1)
        if (line) onLine(line)
      }
    },
    flush() {
      const line = rest.replace(/\r$/, '')
      rest = ''
      if (line) onLine(line)
    },
  }
}

/** One ripgrep --json event, narrowed to the parts we consume. */
interface RgMatch {
  type: string
  data?: {
    path?: { text?: string }
    line_number?: number
    lines?: { text?: string }
    submatches?: { start: number }[]
  }
}

/** Turn one --json line into a hit, or null for the event types we ignore
 *  (begin/end/summary) and for non-UTF8 paths ripgrep reports as bytes. */
export function hitFromJsonLine(line: string): SearchHit | null {
  let msg: RgMatch
  try {
    msg = JSON.parse(line)
  } catch {
    return null
  }
  if (msg.type !== 'match') return null
  const path = msg.data?.path?.text
  if (!path) return null
  const text = msg.data?.lines?.text ?? ''
  return {
    path,
    name: winBasename(path),
    isDirectory: false,
    line: msg.data?.line_number,
    column: msg.data?.submatches?.[0] ? msg.data.submatches[0].start + 1 : undefined,
    // Long minified lines would blow up the overlay; keep enough to read.
    preview: text.replace(/\r?\n$/, '').trimEnd().slice(0, 300),
  }
}

export interface RunningSearch {
  cancel: () => void
}

/**
 * Run one search. Hits stream to `onHits` in batches; `onDone` fires exactly
 * once. Cancelling produces SearchDone { kind: 'cancelled' } — the common case,
 * since every keystroke supersedes the previous run, and it must never reach the
 * user as an error.
 */
export function runSearch(
  q: SearchQuery,
  onHits: (hits: SearchHit[]) => void,
  onDone: (done: SearchDone) => void,
): RunningSearch {
  const rg = resolveRg()
  if (!rg) {
    onDone({ ok: false, reason: 'Bundled ripgrep is missing', kind: 'norg' })
    return { cancel: () => {} }
  }
  if (!q.query.trim()) {
    onDone({ ok: true, count: 0, truncated: false })
    return { cancel: () => {} }
  }

  // stdin is null because it is 'ignore' below — see the spawn options.
  let child: ChildProcessByStdio<null, Readable, Readable>
  try {
    // Binary path is argv[0], never interpolated into a shell string — the
    // install path contains a space.
    //
    // stdin is 'ignore', not the default pipe: given an open stdin pipe that
    // never closes, ripgrep will block forever waiting to read from it instead
    // of searching the path it was given. Observed hanging exactly that way.
    child = spawn(rg, buildArgs(q), {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    onDone({ ok: false, reason: e instanceof Error ? e.message : 'Could not start search', kind: 'error' })
    return { cancel: () => {} }
  }

  let count = 0
  let truncated = false
  let settled = false
  let cancelled = false
  let pending: SearchHit[] = []
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    if (pending.length) {
      onHits(pending)
      pending = []
    }
  }
  const emit = (hit: SearchHit) => {
    if (truncated) return
    pending.push(hit)
    count++
    if (count >= MAX_HITS) {
      truncated = true
      flush()
      kill()
      return
    }
    if (pending.length >= BATCH_SIZE) flush()
    else if (!timer) timer = setTimeout(flush, BATCH_MS)
  }
  const settle = (done: SearchDone) => {
    if (settled) return
    settled = true
    flush()
    onDone(done)
  }
  const kill = () => {
    // SIGKILL: ripgrep walking a 50k-file tree should stop now, not politely.
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }

  const splitter = makeLineSplitter((line) => {
    if (q.content) {
      const hit = hitFromJsonLine(line)
      if (hit) emit(hit)
    } else if (nameMatches(line, q.query, q.caseSensitive)) {
      emit({ path: line, name: winBasename(line), isDirectory: false })
    }
  })

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => splitter.push(chunk))

  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr += chunk.slice(0, 2000) })

  child.on('error', (e) =>
    settle({ ok: false, reason: e.message, kind: 'error' }))

  child.on('close', (code) => {
    splitter.flush()
    if (cancelled) return settle({ ok: false, reason: 'Superseded', kind: 'cancelled' })
    if (truncated) return settle({ ok: true, count, truncated: true })
    // rg exits 1 for "no matches" — a successful search with nothing in it,
    // not a failure. 2 is a real error, most often a bad regex.
    if (code === 0 || code === 1) return settle({ ok: true, count, truncated: false })
    const bad = /regex parse error|error parsing/i.test(stderr)
    settle({
      ok: false,
      reason: stderr.trim().split('\n').slice(-1)[0] || `ripgrep exited ${code}`,
      kind: bad ? 'badpattern' : 'error',
    })
  })

  return {
    cancel: () => {
      cancelled = true
      kill()
    },
  }
}
