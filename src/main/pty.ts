import * as pty from 'node-pty'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, delimiter } from 'node:path'
import { homedir } from 'node:os'

type Handle = { proc: pty.IPty; agentSpawned?: boolean }

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

/**
 * KAN-40. Set once by src/main/index.ts, after the MCP server has bound its
 * port and its --mcp-config file is on disk; null until then, and forever if
 * the server fails to bind — the app still launches Claude, just without agent
 * control. Every Claude session spawned after that point gets the config file
 * on its argv and the bearer token in its environment, which is the only place
 * that token exists outside this process (the file on disk holds the literal
 * `${CLAUDE_EXPLORER_MCP_TOKEN}` and Claude Code expands it per invocation).
 *
 * Shell tabs deliberately get neither: without --mcp-config the token buys them
 * nothing, and a shell hands its whole environment to everything the user runs.
 */
let mcp: { configPath: string; token: string } | null = null

export function setMcpInjection(v: { configPath: string; token: string } | null): void {
  mcp = v
}

/**
 * cmd.exe /c does NOT re-parse its tail by CreateProcess rules. `cmd /?` spells
 * out the rule that bites: unless the tail contains EXACTLY two quote
 * characters, wrapping the name of an executable, cmd strips the FIRST quote on
 * the line and the LAST one and runs whatever is left. Until now the tail was
 * `<claude.cmd> --resume <uuid>` — at most two quotes, around an executable, so
 * it sat in the exempt case and survived. Appending `--mcp-config
 * "<userData>\mcp-agent-control.json"` puts FOUR quotes on the line as soon as
 * the shim path also needs quoting, the exemption stops applying, and Claude
 * never launches.
 *
 * WHO THAT BREAKS: anyone whose tail carries a space or a shell metacharacter
 * ANYWHERE in it — which is driven by the WINDOWS ACCOUNT NAME, not by the
 * build. `C:\Users\First Last\…` puts a space in BOTH halves at once (the
 * npm-global shim is `…\First Last\AppData\Roaming\npm\claude.cmd` and the
 * config path is under the same profile), and an account name containing `&`
 * made cmd truncate the line at the & and run the remainder as a second
 * command. Both were measured against the old array form; the string form below
 * is correct in every case tried.
 *
 * NOT packaged-only — do not "simplify" this back on the grounds that dev and
 * installed userData look identical. They ARE identical: package.json has no
 * top-level productName (only build.productName, which names the installer and
 * the exe, not app.getName()), so userData is `…\Roaming\claude-explorer` in
 * both and an installed build on a no-space account proves nothing about the
 * account next door.
 *
 * So build the tail here and hand it to node-pty as a STRING, which
 * `argsToCommandLine` appends verbatim rather than quoting (an array cannot
 * express this: it backslash-escapes any quote we embed, which cmd does not
 * understand). One extra pair of quotes around the whole tail is the documented
 * idiom — the strip-first-and-last rule then removes exactly that pair and
 * leaves a correctly quoted command line, whether or not the shim path has a
 * space in it.
 *
 * Quote an argument iff it is not a plain path/flag token: a space is not the
 * only character cmd reacts to, and `&`, `^`, `|`, `>` can reach us inside the
 * userData path via the account name. Inside quotes cmd treats none of them as
 * operators. Nothing caller-influenced reaches here un-validated — see
 * SESSION_ID above — so this is a correctness guard, not the security one.
 */
const CMD_SAFE_BARE = /^[\w.:\\/=-]+$/
function batchCommandLine(shim: string, args: string[]): string {
  const tail = args.map((a) => (CMD_SAFE_BARE.test(a) ? a : `"${a}"`)).join(' ')
  return `/c ""${shim}"${tail ? ` ${tail}` : ''}"`
}

export class PtyManager {
  private handles = new Map<string, Handle>()

  spawn(
    opts: {
      path: string; resumeId?: string; shell?: boolean; sessionId?: string
      /** KAN-41. This session was asked for by the MCP tool, not by the user.
       *  See the recursion guard below. Provenance, not preference — the
       *  renderer carries it across a restart so restoring a tab cannot launder
       *  a worker back into a parent. */
      agentSpawned?: boolean
    },
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
    // KAN-41's recursion guard, the term the comment here predicted. A session
    // the agent asked for is a WORKER: no config file and no token, so it never
    // receives the tool that created it and fan-out cannot compound. spawn() is
    // the only Claude path in the tree, so this one term covers every route.
    //
    // --strict-mcp-config with no --mcp-config is ZERO servers, which also takes
    // away whatever .mcp.json the TARGET folder ships (an agent names that
    // folder, so its config is as untrusted as the request). Not added to a
    // user-launched session — that would silently delete the user's own servers.
    // It is a literal constant matching CMD_SAFE_BARE, so it needs no
    // SESSION_ID-style validation and goes out bare through batchCommandLine.
    //
    // ONE local feeds BOTH injection sites: dropping the flag while leaving the
    // bearer token in the child's environment is a half-fix, not a guard.
    const agentControl = opts.agentSpawned ? null : mcp
    if (agentControl) claudeArgs.push('--mcp-config', agentControl.configPath)
    else if (opts.agentSpawned) claudeArgs.push('--strict-mcp-config')
    // .cmd/.bat shims must run through the command processor; a real .exe launches directly.
    const isBatch = /\.(cmd|bat)$/i.test(CLAUDE)
    const file = isBatch ? process.env.COMSPEC || 'cmd.exe' : CLAUDE
    const args = isBatch ? batchCommandLine(CLAUDE, claudeArgs) : claudeArgs

    let proc: pty.IPty
    try {
      proc = pty.spawn(file, args, {
        name: 'xterm-color',
        cwd: opts.path,
        cols: 80,
        rows: 24,
        // CLAUDE_EXPLORER_PTY_ID is the id this spawn just minted, so the agent
        // in the pane can name the tab it is running in.
        env: {
          ...launchEnv(),
          ...(agentControl
            ? { CLAUDE_EXPLORER_MCP_TOKEN: agentControl.token, CLAUDE_EXPLORER_PTY_ID: id }
            : {}),
        },
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
    this.handles.set(id, { proc, agentSpawned: opts.agentSpawned })
    return id
  }

  /** KAN-41's cap: how many app-spawned Claude sessions are alive right now.
   *  DERIVED from the handle map, never a counter — the map already loses its
   *  entry in onExit above and in kill() below, and closing a tab IS kill(), so
   *  there is no decrement site to forget and the cap cannot creep up until it
   *  bricks the tool. The shell branch returns before any of this, so a shell
   *  tab is never counted. */
  agentSessions(): number {
    return [...this.handles.values()].filter((h) => h.agentSpawned).length
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
