// Path helpers shared by main, preload and the renderer.
//
// KAN-89: this file and its main-process sibling `main/volume.ts` are the ONLY
// two places allowed to branch on the platform for path reasons. Every consumer
// calls the same names on every OS.
//
// This file CANNOT import node:path. src/shared is bundled into the renderer,
// which runs with contextIsolation:true / nodeIntegration:false and therefore
// has no node builtins at all. The POSIX arms below are transcriptions of
// path.posix.basename / path.posix.dirname; test/pathutil.test.ts proves they
// agree with the real ones over a corpus, and that the Windows arms are
// byte-for-byte what shipped through 0.9.0.
//
// The names winBasename / winDirname are historical — this was a Windows-only
// app through 0.9.0 — and are kept so ten call sites do not churn. Both are
// cross-platform now.

/** Windows treats '\' and '/' alike; on POSIX a backslash is an ordinary
 *  character in a filename, so the two cannot share one splitter.
 *
 *  main and preload have node's `process`; the renderer has none at all, so it
 *  reads Chromium's UA. The last resort is Windows — it is the platform with
 *  users, and the only thing a wrong answer changes is whether '\' separates. */
function detectWindows(): boolean {
  if (typeof process !== 'undefined' && typeof process.platform === 'string') {
    return process.platform === 'win32'
  }
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  return !/Macintosh|Mac OS X|Linux|X11|CrOS/i.test(ua)
}

export const isWindows: boolean = detectWindows()

/** Reduces a path to the volume it lives on: "c:" for local paths,
 *  "\\\\server\\share" for UNC. The old implementation used slice(0,1), which
 *  returned "\" for EVERY UNC path — making all network paths compare equal.
 *
 *  WINDOWS SEMANTICS ONLY: POSIX has neither drive letters nor shares, and its
 *  volume identity (st_dev) needs a stat. Use main/volume.ts's sameVolume() /
 *  volumeRootOf() unless you have already established you are on Windows. */
export function driveKey(p: string): string {
  const s = p.replace(/^\\\\\?\\/, '') // strip \\?\ long-path prefix
  const unc = /^\\\\([^\\]+)\\([^\\]+)/.exec(s)
  if (unc) return `\\\\${unc[1]}\\${unc[2]}`.toLowerCase()
  return s.slice(0, 2).toLowerCase()
}

/** The Windows arm of sameVolume(). Pure string, no fs, so no stall — which is
 *  why the Windows side of drag-and-drop and trash staging costs nothing. */
export function sameDrive(a: string, b: string): boolean {
  return driveKey(a) === driveKey(b)
}

// path.posix.basename / path.posix.dirname, transcribed (see the header: no
// node builtins reachable from here). Kept in node's own shape rather than
// "split on /" because the naive versions disagree with it on '/', '//a' and
// 'a//b', and test/pathutil.test.ts diffs them against the real thing.
function posixBasename(p: string): string {
  let end = p.length
  while (end > 0 && p.charCodeAt(end - 1) === 47) end-- // ignore trailing '/'
  return p.slice(p.lastIndexOf('/', end - 1) + 1, end)
}

function posixDirname(p: string): string {
  let end = p.length
  while (end > 1 && p.charCodeAt(end - 1) === 47) end-- // ignore trailing '/'
  const i = p.lastIndexOf('/', end - 1)
  if (i < 0) return '.'
  if (i === 0) return '/'
  if (i === 1 && p.charCodeAt(0) === 47) return '//' // POSIX reserves a leading '//'
  return p.slice(0, i)
}

export function winBasename(p: string): string {
  if (!isWindows) return posixBasename(p)
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] ?? p
}

export function winDirname(p: string): string {
  if (!isWindows) return posixDirname(p)
  const trimmed = p.replace(/[\\/]+$/, '')
  const i = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  return i <= 0 ? trimmed : trimmed.slice(0, i)
}

function splitExt(name: string): [string, string] {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
}

export function uniqueName(existing: string[], name: string): string {
  const set = new Set(existing)
  if (!set.has(name)) return name
  const [base, ext] = splitExt(name)
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})${ext}`
    if (!set.has(candidate)) return candidate
  }
}
