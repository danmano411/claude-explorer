import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { FileMode } from '../shared/types'

export type Op = 'delete' | 'permanentDelete' | 'move' | 'copy' | 'rename' | 'mkdir' | 'newFile'
export type PathClass = 'system' | 'driveRoot' | 'trash' | 'normal'

export type Verdict =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'confirm'; reason: string; typed: boolean }

export const CONFIRM_WORD = 'CONFIRM'
export const TRASH_DIR_NAME = '.claude-explorer-trash'

export const DEFAULT_SYSTEM_ROOTS = [
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
]

/** Lower-case, backslash-only, no trailing separator. */
function norm(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** True when `child` IS `parent` or sits beneath it. Segment-aware, so
 *  "C:\WindowsBackup" is not treated as living under "C:\Windows". */
function isUnder(child: string, parent: string): boolean {
  const c = norm(child)
  const p = norm(parent)
  return c === p || c.startsWith(p + '\\')
}

/** `C:`, `\\server\share`, and their `\\?\` / `\\?\UNC\` spellings. */
function isDriveRoot(n: string): boolean {
  const s = n.replace(/^\\\\\?\\/, '').replace(/^unc\\/, '\\\\')
  return /^[a-z]:$/.test(s) || /^\\\\[^\\]+\\[^\\]+$/.test(s)
}

export function classify(p: string, roots: string[] = DEFAULT_SYSTEM_ROOTS): PathClass {
  const n = norm(p)
  // Trash is checked first: it is denied in BOTH modes, so it must win over
  // any other classification that might merely require confirmation.
  if (n.split('\\').includes(TRASH_DIR_NAME)) return 'trash'
  if (isDriveRoot(n)) return 'driveRoot'
  for (const r of roots) if (isUnder(p, r)) return 'system'
  return 'normal'
}

/** `p` itself, then each ancestor, paired with the segments to re-append. The
 *  first one that really exists on disk is the answer; if none does, the caller
 *  falls back to the lexical path. Shared so the sync and async resolvers below
 *  cannot drift apart — the only difference between them is which realpath they
 *  await. */
function* ancestors(p: string): Generator<[string, string[]]> {
  const rest: string[] = []
  let cur = path.resolve(p)
  for (;;) {
    yield [cur, rest.slice()]
    const parent = path.dirname(cur)
    if (parent === cur) return
    rest.unshift(path.basename(cur))
    cur = parent
  }
}

/** Resolve to the real on-disk path: expands 8.3 short names, `..`, symlinks
 *  and junctions, and strips the `\\?\` prefix. For a target that does not
 *  exist yet (mkdir/newFile) the nearest existing ancestor is resolved and the
 *  remaining segments re-appended. Never throws.
 *
 *  BLOCKS THE PROCESS. `realpathSync.native` on a path whose host is
 *  unreachable (`\\10.255.255.1\share\x`) takes ~21 SECONDS, and every one of
 *  them is spent on the calling thread. In main that is the whole app: no IPC,
 *  no pty:data, no paint. Only use this for a path the USER chose in the window
 *  that would be frozen; anything a caller outside the app named goes through
 *  canonicalizeAsync. */
export function canonicalize(p: string): string {
  for (const [cur, rest] of ancestors(p)) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest)
    } catch {
      /* keep walking up */
    }
  }
  return path.resolve(p)
}

const realpathNative = promisify(fs.realpath.native)

/**
 * A gate that runs what it is handed one at a time, in call order. A rejection
 * settles the queue exactly like a return, so a thrower cannot wedge it.
 *
 * ponytail: a queue of ONE, not a pool with a size. What is being bounded is how
 * many libuv worker threads an untrusted caller may hold at once, and libuv has
 * four — one is the only number that still leaves the app a majority however the
 * pool is sized.
 *
 * Ceiling: lookups now queue behind each other, which is microseconds on a local
 * path but the full 21s behind an unreachable one — so a looping agent can still
 * starve the two MCP tools that resolve a path (its OWN tools; the window's file
 * operations do not go through here, and that is the point). Give it a real
 * worker pool with per-client fairness the day that is worth caring about.
 */
export function oneAtATime(): <T>(fn: () => Promise<T>) => Promise<T> {
  let queue: Promise<unknown> = Promise.resolve()
  return (fn) => {
    const run = queue.then(fn)
    queue = run.then(
      () => {},
      () => {},
    )
    return run
  }
}
const resolveOne = oneAtATime()

/** canonicalize() without pinning the main thread — same answers, one awaited
 *  syscall at a time. This is the spelling every caller-supplied path must use
 *  (see mcp.ts): the 21-second stall above then costs one request instead of
 *  the whole process.
 *
 *  SERIALISED, and that is half the fix, not tidiness. `await` moves the stall
 *  off the event loop but not off libuv's threadpool, which is FOUR threads —
 *  so four concurrent `\\10.255.255.n\s\x` resolutions (one agent can emit
 *  parallel tool calls) park every other async fs operation in main behind
 *  them: measured, a `readdir("C:\Windows\System32")` issued during four of
 *  them took 20,636 ms, versus 4 ms during one. The file browser, the viewer,
 *  session parsing and every trash op are all `node:fs/promises`. One at a time
 *  caps an outside caller at a single worker. */
export async function canonicalizeAsync(p: string): Promise<string> {
  return resolveOne(async () => {
    for (const [cur, rest] of ancestors(p)) {
      try {
        return path.join(await realpathNative(cur), ...rest)
      } catch {
        /* keep walking up */
      }
    }
    return path.resolve(p)
  })
}

export function check(
  op: Op,
  paths: string[],
  mode: FileMode,
  roots: string[] = DEFAULT_SYSTEM_ROOTS,
): Verdict {
  if (op === 'permanentDelete' && mode === 'explorer') {
    return {
      kind: 'deny',
      reason:
        'Permanent delete is a Developer mode operation. Switch modes in the status bar if you really need it.',
    }
  }

  for (const p of paths) {
    const cls = classify(p, roots)
    // Name the path, not just the class: a refusal on one item of a twenty-item
    // selection is useless if the user cannot tell which one to deselect.
    if (cls === 'trash') {
      return {
        kind: 'deny',
        reason: `${p} is Claude Explorer's own undo staging folder — changing it would break pending undo.`,
      }
    }
    if (cls === 'system' || cls === 'driveRoot') {
      const what = cls === 'system' ? 'A system folder' : 'A drive root'
      if (mode === 'explorer') {
        return {
          kind: 'deny',
          reason: `${what}: ${p}. Switch to Developer mode if you really need this.`,
        }
      }
      return {
        kind: 'confirm',
        reason: `${what}: ${p} — this can break Windows. Type ${CONFIRM_WORD} to proceed.`,
        typed: true,
      }
    }
  }

  if (op === 'permanentDelete') {
    return {
      kind: 'confirm',
      reason: `Permanent delete skips the trash and cannot be undone with Ctrl+Z. Type ${CONFIRM_WORD} to proceed.`,
      typed: true,
    }
  }

  // Normal deletes are deliberately NOT confirmed: Windows 11 does not confirm
  // Recycle Bin deletes, and trash staging + Ctrl+Z already cover this.
  return { kind: 'allow' }
}

/** The chokepoint. Returns null when the operation may proceed, otherwise the
 *  blocking verdict. Re-validates on every call — a caller that supplies a
 *  confirm value is never trusted to have actually earned it.
 *
 *  Canonicalisation lives HERE, not in the handlers: `classify`/`check` stay
 *  pure string matching, and no call site can forget to resolve first. */
export function gate(
  op: Op,
  paths: string[],
  mode: FileMode,
  confirm?: string,
  roots: string[] = DEFAULT_SYSTEM_ROOTS,
  resolve: (p: string) => string = canonicalize,
): Verdict | null {
  const v = check(
    op,
    paths.map((p) => resolve(p)),
    mode,
    roots,
  )
  if (v.kind === 'allow') return null
  if (v.kind === 'deny') return v
  // Every confirm verdict check() produces is `typed`, so there is one rule:
  // the exact word. A simple-confirm verdict added later fails closed here
  // (it would demand the word) rather than accepting any defined string, ''
  // included — which is what the branch that used to live here did.
  return confirm === CONFIRM_WORD ? null : v
}
