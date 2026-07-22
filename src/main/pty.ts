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

export class PtyManager {
  private handles = new Map<string, Handle>()

  spawn(
    opts: { path: string; resumeId?: string; shell?: boolean },
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
          env: process.env as Record<string, string>,
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

    const claudeArgs = opts.resumeId ? ['--resume', opts.resumeId] : []
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
        env: process.env as Record<string, string>,
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
