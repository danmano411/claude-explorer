import * as pty from 'node-pty'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, delimiter } from 'node:path'
import { homedir } from 'node:os'

type Handle = { proc: pty.IPty }

// node-pty on Windows does NOT PATH-resolve a bare command name (unlike a shell),
// so `pty.spawn('claude', …)` throws "File not found". Resolve to an absolute path.
function resolveClaude(): string {
  if (process.platform !== 'win32') return 'claude'
  const exts = ['.exe', '.cmd', '.bat', '']
  const dirs = (process.env.PATH || '').split(delimiter)
  dirs.push(join(homedir(), '.local', 'bin')) // known Claude Code install location
  for (const dir of dirs) {
    if (!dir) continue
    for (const ext of exts) {
      const full = join(dir, `claude${ext}`)
      if (existsSync(full)) return full
    }
  }
  return 'claude' // last resort — surfaces the original "File not found" if truly absent
}

const CLAUDE = resolveClaude()

/**
 * Every caller-influenced value that reaches ARGV is validated here, because
 * node-pty builds the Win32 command line itself and its quoting is narrower
 * than it looks: `argsToCommandLine` (node_modules/node-pty/lib/
 * windowsPtyAgent.js) quotes an argument only when it is EMPTY or contains a
 * space/tab, so `&`, `|`, `^`, `>` go out BARE. When resolveClaude() lands on
 * a .cmd/.bat shim the line then runs through COMSPEC — and cmd.exe reads
 * those bare characters as operators, so `--resume abc&calc` launches calc.
 * An npm-global install of Claude Code IS a .cmd shim, so that is an ordinary
 * machine, not an exotic one.
 *
 * Both ids are Claude session UUIDs (a transcript is `<uuid>.jsonl`), so demand
 * exactly that shape — an id of any other shape names no transcript and could
 * only ever have produced a failed launch anyway. `path` needs no guard: it is
 * handed to node-pty's `cwd` OPTION, a separate native parameter that never
 * joins the command line. Keep it that way, and if you add a flag below,
 * validate its value HERE — spawn() is the one place every caller routes
 * through (the control channel, the File menu, workspace restore, the CLI).
 */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A refusal, not a launch failure: nothing was spawned. Typed so a caller —
 *  KAN-40's MCP layer, via the control channel — can tell "you sent junk" from
 *  "claude died", and so this never takes the paint-it-in-the-pane path below,
 *  which would create a terminal tab for a request that was never legitimate. */
export class PtyArgError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PtyArgError'
  }
}

/**
 * Claude Code marks its own environment so a `claude` it spawns knows it is a
 * nested session — and a nested session **does not save a transcript**. If
 * Claude Explorer is itself launched from a Claude session (running `npm run
 * dev` from a Claude terminal, or opening the app from one), that marker is
 * inherited, every session spawned from the app silently stops persisting, and
 * both Open Recent and restore-on-restart quietly find nothing. The symptom is
 * a one-line warning inside the pane that nobody reads.
 *
 * Claude Explorer is a launcher: a session it starts is top-level, whatever
 * started Claude Explorer. So drop the parent's session identity.
 *
 * ponytail: a named list, not a `CLAUDE_CODE_*` prefix sweep — the prefix also
 * covers deliberate user configuration (CLAUDE_CODE_USE_BEDROCK,
 * CLAUDE_CODE_MAX_OUTPUT_TOKENS, …) which must pass through untouched. Ceiling:
 * if Claude Code renames its marker, this list needs the new name. The
 * env-scrub test is what would notice.
 */
const INHERITED_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_PID',
]

export function launchEnv(
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue
    if (INHERITED_SESSION_VARS.includes(k)) continue
    env[k] = v
  }
  return env
}

export class PtyManager {
  private handles = new Map<string, Handle>()

  spawn(
    opts: { path: string; resumeId?: string; shell?: boolean; sessionId?: string },
    onData: (id: string, d: string) => void,
    onExit: (id: string, code: number) => void,
  ): string {
    // Before anything else, including the shell branch: a value that cannot
    // reach argv today must not become reachable by a later edit down there.
    for (const key of ['resumeId', 'sessionId'] as const) {
      const v = opts[key]
      if (v !== undefined && !SESSION_ID.test(v))
        throw new PtyArgError(`pty: ${key} is not a Claude session id`)
    }

    const id = randomUUID()

    // Plain interactive shell tab (feature 5) — no Claude.
    if (opts.shell) {
      let proc: pty.IPty
      try {
        proc = pty.spawn('powershell.exe', ['-NoLogo'], {
          name: 'xterm-color', cwd: opts.path, cols: 80, rows: 24,
          env: launchEnv(),
        })
      } catch (err) {
        const msg = `\r\n\x1b[31mFailed to launch shell: ${(err as Error).message}\x1b[0m\r\n`
        queueMicrotask(() => { onData(id, msg); onExit(id, 1) })
        return id
      }
      proc.onData((d) => onData(id, d))
      proc.onExit(({ exitCode }) => { onExit(id, exitCode); this.handles.delete(id) })
      this.handles.set(id, { proc })
      return id
    }

    // resumeId picks up an existing conversation; sessionId *names* a new one so
    // the tab that owns it can resume that exact conversation after a restart.
    // They are mutually exclusive — claude rejects --session-id for an id that
    // already has a transcript, which is precisely when --resume is the right
    // flag. The caller decides by checking whether the session exists on disk.
    const claudeArgs = opts.resumeId
      ? ['--resume', opts.resumeId]
      : opts.sessionId
        ? ['--session-id', opts.sessionId]
        : []
    // .cmd/.bat shims must run through the command processor; a real .exe launches directly.
    const isBatch = /\.(cmd|bat)$/i.test(CLAUDE)
    const file = isBatch ? process.env.COMSPEC || 'cmd.exe' : CLAUDE
    const args = isBatch ? ['/c', CLAUDE, ...claudeArgs] : claudeArgs

    let proc: pty.IPty
    try {
      proc = pty.spawn(file, args, {
        name: 'xterm-color',
        cwd: opts.path,
        cols: 80,
        rows: 24,
        env: launchEnv(),
      })
    } catch (err) {
      // Surface the failure inside the terminal tab instead of rejecting the IPC call
      // (which would leave the tab blank with only a console error).
      const msg = `\r\n\x1b[31mFailed to launch Claude: ${(err as Error).message}\x1b[0m\r\nTried: ${CLAUDE}\r\n`
      queueMicrotask(() => {
        onData(id, msg)
        onExit(id, 1)
      })
      return id
    }

    proc.onData((d) => onData(id, d))
    proc.onExit(({ exitCode }) => {
      onExit(id, exitCode)
      this.handles.delete(id)
    })
    this.handles.set(id, { proc })
    return id
  }

  write(id: string, data: string) {
    this.handles.get(id)?.proc.write(data)
  }
  resize(id: string, cols: number, rows: number) {
    this.handles.get(id)?.proc.resize(cols, rows)
  }
  kill(id: string) {
    this.handles.get(id)?.proc.kill()
    this.handles.delete(id)
  }
}
