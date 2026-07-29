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
