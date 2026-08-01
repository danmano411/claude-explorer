import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { FileMode } from '../shared/types'
import { isWindows } from '../shared/pathutil'

export type Op = 'delete' | 'permanentDelete' | 'move' | 'copy' | 'rename' | 'mkdir' | 'newFile'
export type PathClass = 'system' | 'driveRoot' | 'trash' | 'normal'

export type Verdict =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'confirm'; reason: string; typed: boolean }

export const CONFIRM_WORD = 'CONFIRM'
export const TRASH_DIR_NAME = '.claude-explorer-trash'

/** The separator this platform's paths are made of. Taken from KAN-89's
 *  `isWindows` rather than node's `path.sep` deliberately: `path.sep` cannot be
 *  moved in a test, so the POSIX arms below would be unreachable and would ship
 *  unexercised — which is the exact failure mode this ticket exists to fix. */
const SEP = isWindows ? '\\' : '/'

const WINDOWS_SYSTEM_ROOTS = [
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
]

/**
 * KAN-90. ONE POSIX list, not a darwin one and a linux one: every entry that
 * does not belong to a platform simply does not exist there (`/System` and
 * `/Library` are meaningless on Linux, `/boot` on macOS), so two lists would
 * differ only in dead entries while doubling what has to stay in step.
 *
 * `/private/etc` is NOT decoration. On macOS `/etc` is a symlink to
 * `/private/etc`, and gate() canonicalises through symlinks BEFORE classifying —
 * so a delete aimed at `/etc/hosts` arrives here spelled `/private/etc/hosts`
 * and would sail past a list containing only `/etc`. The guard's own
 * canonicalisation is what would have defeated it. `/var` and `/tmp` are the
 * other two macOS symlinks into `/private` and are deliberately absent for the
 * opposite reason — see below.
 *
 * Deliberately NOT protected, each because protecting it would be wrong rather
 * than merely cautious:
 *  - `/Applications` (macOS): dragging an app out of it IS how a mac user
 *    uninstalls software. Guarding it would break the platform's most ordinary
 *    file-manager action.
 *  - `/var`, `/private/var` (macOS): `$TMPDIR` is `/private/var/folders/…`, so
 *    protecting `/var` would deny every delete inside the user's own temp
 *    directory. Linux's `/var` is left out for symmetry; what is dangerous under
 *    it is root-owned anyway.
 *  - `/opt` (Linux/macOS): `/opt/homebrew` is user-installed software the user
 *    manages, not the OS.
 *  - `/Users`, `/home`: `C:\Users` is not on the Windows list either, and
 *    parity beats inventing new protection on the new platforms.
 *
 * On modern Linux `/bin`, `/sbin` and `/lib` are symlinks into `/usr`
 * (usrmerge), so canonicalisation folds them onto `/usr`, which is listed — the
 * entries are kept for the distros that have not merged.
 */
const POSIX_SYSTEM_ROOTS = [
  '/System',
  '/Library',
  '/usr',
  '/bin',
  '/sbin',
  '/etc',
  '/private/etc',
  '/lib',
  '/boot',
]

export const DEFAULT_SYSTEM_ROOTS = isWindows ? WINDOWS_SYSTEM_ROOTS : POSIX_SYSTEM_ROOTS

/** Lower-case, one separator, no trailing separator.
 *
 *  Windows folds '/' onto '\'; POSIX must NOT, because a backslash is an
 *  ordinary character in a POSIX filename and folding it would split `a\b.txt`
 *  into two segments — which is how a file could be mistaken for the trash dir.
 *
 *  Lower-casing on POSIX is deliberate. macOS is case-insensitive by default, so
 *  there it is simply correct; on case-sensitive Linux it can only ever
 *  OVER-match (`/USR` is not `/usr`), and every over-match is a refusal on a
 *  path no real system has, which fails safe. */
function norm(p: string): string {
  if (!isWindows) return p.replace(/\/+$/, '').toLowerCase() || '/'
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** True when `child` IS `parent` or sits beneath it. Segment-aware, so
 *  "C:\WindowsBackup" is not treated as living under "C:\Windows" — and
 *  "/etcetera" is not treated as living under "/etc". */
function isUnder(child: string, parent: string): boolean {
  const c = norm(child)
  const p = norm(parent)
  return c === p || c.startsWith(p + SEP)
}

/**
 * The POSIX answer to `D:\`: the filesystem root, and the mount points where
 * emptying the directory empties a whole disk. Both the container and the mounts
 * inside it, because deleting `/Volumes` is as bad as deleting the disk under it.
 *
 *   macOS   /Volumes, /Volumes/<disk>
 *   Linux   /mnt, /mnt/<disk>, /media, /media/<disk>,
 *           /media/<user>/<disk>, /run/media/<user>/<disk>  (udisks, per distro)
 *
 * One level under /Volumes and /mnt, no deeper — `/mnt/c/Users/dan` is a folder
 * a WSL user browses constantly, and treating it as a drive root would deny
 * every operation in it. The two-level alternative is only for the udisks
 * layouts, where the extra level is the user name and the disk is beneath it.
 *
 * ponytail: a static list of the four conventional mount containers, not a
 * /proc/mounts or `mount` parse. classify() is pure synchronous string matching
 * on purpose (gate() is the only thing allowed to touch the disk, behind its
 * queue). A real mount-table lookup belongs behind volumeRootOf() the day a
 * distro turns up that mounts removable media somewhere else.
 */
const POSIX_MOUNT_ROOT =
  /^\/(?:volumes|mnt|media)(?:\/[^/]+)?$|^\/(?:media|run\/media)\/[^/]+\/[^/]+$/

/** `C:`, `\\server\share`, and their `\\?\` / `\\?\UNC\` spellings — or, on
 *  POSIX, `/` and a mount point. */
function isDriveRoot(n: string): boolean {
  if (!isWindows) return n === '/' || POSIX_MOUNT_ROOT.test(n)
  const s = n.replace(/^\\\\\?\\/, '').replace(/^unc\\/, '\\\\')
  return /^[a-z]:$/.test(s) || /^\\\\[^\\]+\\[^\\]+$/.test(s)
}

export function classify(p: string, roots: string[] = DEFAULT_SYSTEM_ROOTS): PathClass {
  const n = norm(p)
  // Trash is checked first: it is denied in BOTH modes, so it must win over
  // any other classification that might merely require confirmation.
  if (n.split(SEP).includes(TRASH_DIR_NAME)) return 'trash'
  if (isDriveRoot(n)) return 'driveRoot'
  for (const r of roots) if (isUnder(p, r)) return 'system'
  return 'normal'
}

/** `p` itself, then each ancestor, paired with the segments to re-append. The
 *  first one that really exists on disk is the answer; if none does, the caller
 *  falls back to the lexical path. */
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

const realpathNative = promisify(fs.realpath.native)

/** Resolve to the real on-disk path: expands 8.3 short names, `..`, symlinks
 *  and junctions, and strips the `\\?\` prefix. For a target that does not
 *  exist yet (mkdir/newFile) the nearest existing ancestor is resolved and the
 *  remaining segments re-appended. Never throws.
 *
 *  KAN-68 deleted the `realpathSync.native` spelling of this, so no path
 *  RESOLUTION in main pins the whole process any more. That is a claim about
 *  realpath and nothing else: main still calls sync `fs` elsewhere, and the line
 *  that matters is whose path it is. settings/workspace/recents read their own
 *  files under userData; ide/pty/search probe their own install locations. None
 *  of those is renderer- or caller-supplied. git.ts's `existsSync` WAS — it ran
 *  on the directory FileBrowser navigates to, on every navigation — so KAN-68
 *  moved it too. Add a sync `fs` call on a path that came from outside main and
 *  this sentence stops being true.
 *
 *  This one is UNGATED and therefore not exported: a single call still parks a
 *  libuv worker for ~21 seconds on an unreachable host, and libuv has four. Both
 *  exported spellings below put it behind a queue — which queue is the trust
 *  boundary, see gateOne. */
async function resolveReal(p: string): Promise<string> {
  for (const [cur, rest] of ancestors(p)) {
    try {
      return path.join(await realpathNative(cur), ...rest)
    } catch {
      /* keep walking up */
    }
  }
  return path.resolve(p)
}

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
 * operations ride gateOne, a separate instance, and that is the point). Give it
 * a real worker pool with per-client fairness the day that is worth caring about.
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
/** The ONE gate every untrusted path resolution in main shares — MCP's
 *  canonicalize (via canonicalizeAsync) and the CLI's canonicalize AND its stat
 *  (cli.ts). Shared, not one queue each, and that is the whole point: what is
 *  being bounded is how many of libuv's four worker threads a caller outside the
 *  app can hold at once, and two queues would make that two. The cost is that a
 *  looping agent delays a CLI launch and vice versa — but each of them can
 *  already starve its own class, so a second queue would buy isolation between
 *  two untrusted callers at the price of a second pinned thread.
 *
 *  UNTRUSTED is the word doing the work: gateOne (below) is a second queue, and
 *  it does not break this rule, because what it serialises is the window's own
 *  operations. The invariant is "a caller outside the app pins at most one
 *  worker", and that is still exactly one queue. */
export const resolveOne = oneAtATime()

/** Path resolution for a caller OUTSIDE the app, on the shared untrusted queue.
 *  This is the spelling every caller-supplied path must use (see mcp.ts, cli.ts):
 *  the 21-second stall then costs one request instead of the whole process.
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
  return resolveOne(() => resolveReal(p))
}

/** gate()'s resolver: the SAME walk, its OWN queue — deliberately not resolveOne.
 *
 *  KAN-68's one real design decision, so it is written down here. gate()'s paths
 *  are the user's own selection arriving over authenticated renderer IPC; the
 *  MCP and CLI paths are named by callers outside the app. Those are different
 *  trust classes, and resolveOne exists to bound a class, not a workload:
 *
 *  - Sharing resolveOne would mean one looping agent — which is entitled to hold
 *    that queue for 21 s per resolve — puts the USER'S OWN delete behind serial
 *    21-second stalls. Today's bug is self-inflicted; that would convert it into
 *    an agent-inflicted one. Strictly worse, so no.
 *  - No queue at all would be enough *today*, because every file operation in
 *    the renderer awaits sequentially (paste, drop, delete, rename are all
 *    `for..of` + `await`), so the window issues one gate() at a time. But that
 *    is a property of FileBrowser's control flow, not of this file — one
 *    `Promise.all` over a multi-select drop and the window is holding all four
 *    libuv workers again. The whole point of this ticket is properties over
 *    conventions, so: a queue.
 *
 *  Cost, stated plainly: worst case two of libuv's four workers are held (one
 *  per queue) instead of one. The invariant that actually matters is unchanged —
 *  a caller OUTSIDE the app can still pin at most one — and the second is held
 *  only by an operation the user started and is waiting for. Merge the queues
 *  the day a user's file operation stops being more privileged than an agent's. */
const gateOne = oneAtATime()
const resolveForWindow = (p: string) => gateOne(() => resolveReal(p))

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
        // "your system", not "Windows": the same sentence now appears on macOS
        // and Linux. Nothing asserts on this string.
        reason: `${what}: ${p} — this can break your system. Type ${CONFIRM_WORD} to proceed.`,
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
 *  pure string matching, and no call site can forget to resolve first.
 *
 *  ASYNC since KAN-68. A missed `await` at a call site is a TYPE ERROR, not a
 *  silently disabled guard: this returns a Verdict that `blocked()` consumes, so
 *  an unawaited Promise — which would be truthy in the `if (v)` — cannot be
 *  passed on. Keep it that way; the day someone takes the result in a boolean
 *  position, a forgotten await opens the file-safety chokepoint.
 *
 *  Paths resolve one after another rather than in parallel: a twenty-item
 *  selection is one queued resolution twenty times, not a twenty-deep fan-out. */
export async function gate(
  op: Op,
  paths: string[],
  mode: FileMode,
  confirm?: string,
  roots: string[] = DEFAULT_SYSTEM_ROOTS,
  resolve: (p: string) => string | Promise<string> = resolveForWindow,
): Promise<Verdict | null> {
  const resolved: string[] = []
  for (const p of paths) resolved.push(await resolve(p))
  const v = check(op, resolved, mode, roots)
  if (v.kind === 'allow') return null
  if (v.kind === 'deny') return v
  // Every confirm verdict check() produces is `typed`, so there is one rule:
  // the exact word. A simple-confirm verdict added later fails closed here
  // (it would demand the word) rather than accepting any defined string, ''
  // included — which is what the branch that used to live here did.
  return confirm === CONFIRM_WORD ? null : v
}
