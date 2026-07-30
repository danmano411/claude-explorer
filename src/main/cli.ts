import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { canonicalize } from './policy'

export type CliIntent = { cmd: 'open' | 'new-session'; path: string }

/** What the renderer is asked to do. Two arms, not three: there is deliberately
 *  no 'new-session' target — see resolveCliIntent for why. */
export type CliTarget = { cmd: 'open-path' | 'open-file'; path: string }

/**
 * Scan argv for our own two flags. Deliberately a scan and not index
 * arithmetic, because the argv SHAPE differs three ways and none of them can
 * contain our flag names by accident:
 *
 *   dev       [electron.exe, '.', '--inspect=9229', '--no-sandbox']
 *             electron-vite spawns `[entry].concat(args)` with entry = '.'
 *   harness   [electron.exe, '--user-data-dir=<tmp>', '<root>/out/main/index.js']
 *   packaged  ['C:\...\Claude Explorer.exe', '--open', 'C:\repo']
 *
 * So there is no app.isPackaged branch and no argv[1]/argv[2] guessing: the
 * junk is simply never '--open' or '--new-session'. `cwd` resolves a relative
 * path — a forwarded launch is resolved against the OTHER process's cwd, and
 * resolving against ours would silently open the wrong folder.
 *
 * There is a FOURTH shape this must never be fed: the argv Chromium hands to
 * app's 'second-instance' event, which is the second process's command line
 * regrouped into [program, ...switches, ...loose args] with extra switches
 * injected. `--open <path>` arrives there as a bare `--open` followed by an
 * unrelated switch. main/index.ts therefore forwards the second process's
 * VERBATIM argv through requestSingleInstanceLock's additionalData and parses
 * that instead — see the comment on the lock, and the pinning case in
 * test/cli.test.ts.
 *
 * Returns null when there is nothing to do (the overwhelmingly common case).
 *
 * ponytail: flag scan, not a parser. No `--open=<path>`, no short flags, no
 * bare positional, first flag wins. Reach for a real parser at flag three.
 */
export function parseCliArgs(argv: string[], cwd: string): CliIntent | null {
  for (let i = 0; i < argv.length; i++) {
    const cmd = argv[i] === '--open' ? 'open' : argv[i] === '--new-session' ? 'new-session' : null
    if (!cmd) continue
    // First flag wins, and a flag with no path is a typo — not a request to
    // open the cwd. Bail rather than keep scanning: a later `--open` in the
    // same argv would then silently rescue a malformed earlier one.
    const raw = argv[i + 1]
    if (!raw || raw.startsWith('-')) return null
    return { cmd, path: resolve(cwd, raw) }
  }
  return null
}

/**
 * Turn an intent into something the renderer can act on, or null. Touches the
 * disk (canonicalize + stat), which is why it is separate from parseCliArgs —
 * that one stays unit-testable with no fixtures.
 *
 * ponytail: no fs fixtures for resolveCliIntent — the E2E proves it for real
 * (test/harness/cli.mjs).
 */
export function resolveCliIntent(i: CliIntent | null): CliTarget | null {
  if (!i) return null
  // Explorer hands us %V, which can be an 8.3 short name, a junction, or a
  // UNC/\\?\ spelling; the shell also lets a path arrive with '..' in it.
  // canonicalize() is the repo's existing resolver for exactly this
  // (policy.ts) — realpathSync.native, falling back to an ancestor walk,
  // never throws.
  const path = canonicalize(i.path)
  let dir: boolean
  try {
    dir = statSync(path).isDirectory()
  } catch {
    // The OS handed us a path that is gone or unreadable. Do NOT open a tab
    // pointed at nothing: a files tab would render an empty error pane. One
    // log line, no tab, and the launching process still exits 0 — an
    // unauthenticated caller gets no UI it can provoke.
    console.error('cli: ignoring unreachable path', path)
    return null
  }
  // --new-session STAGES a session: it opens the folder so the user is one
  // click (the orange arrow) from launching Claude themselves. It deliberately
  // does not spawn, because after this ships ANY local process with no
  // authentication of any kind can say `"Claude Explorer.exe" --new-session
  // <path>` and have it forwarded into the running window — Electron's
  // second-instance authenticates nobody. Spawning Claude Code in a
  // caller-named directory is not navigation: the child inherits the user's own
  // Claude Code configuration (PtyManager.spawn passes no permission flags), so
  // Bash and Edit at the user's level, plus that folder's CLAUDE.md,
  // .claude/settings.json hooks and .mcp.json. Enforcement is structural, not a
  // check: CliTarget has no 'new-session' arm and applyCli in App.tsx has no
  // arm that spawns, so there is no code path from argv to a pty.
  if (i.cmd === 'new-session') {
    // ponytail: a --new-session on a FILE is refused, not silently promoted to
    // its parent folder. Guessing which folder the user meant is worse than
    // doing nothing. Promote to winDirname() if a real workflow needs it.
    if (!dir) {
      console.error('cli: --new-session needs a folder', path)
      return null
    }
    return { cmd: 'open-path', path }
  }
  return { cmd: dir ? 'open-path' : 'open-file', path }
}

// ponytail: --new-session is currently a strict alias of --open on a folder,
// because staging IS opening the folder. It stays a separate flag because the
// Explorer verb and any script want to express the intent, and because the day
// a visible one-click confirm is built, this is where it hangs. Do not
// "simplify" it into --open: that deletes the seam and the intent.
