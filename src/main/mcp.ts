import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { app } from 'electron'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { control } from './control.handlers'
import { ControlError } from './control'
import { isAuthorized } from './mcpauth'
import { canonicalizeAsync } from './policy'
import { agentSessionCount } from './pty.handlers'
import { getSettings } from './settings'
import { promptSpawnConfirm } from './spawnconfirm.handlers'
import { createSpawnGuard } from './spawnguard'
import type { ControlOp, ControlResult, ControlTab } from '../shared/types'

/**
 * KAN-40: the in-process MCP server, and the first caller of control().
 *
 * Streamable HTTP on 127.0.0.1 with an ephemeral port, NOT stdio: a stdio server
 * is spawned by its client, which here would mean Claude Code launching Electron
 * main. The client is a Claude Code already running in one of our own tabs, so
 * the server has to exist first and be dialled.
 *
 * The token is minted per app run and lives only in memory. It reaches Claude
 * Code through the PTY env (CLAUDE_EXPLORER_MCP_TOKEN); the `--mcp-config` file
 * on disk holds only the literal `${CLAUDE_EXPLORER_MCP_TOKEN}`, which Claude
 * Code expands itself. Both halves are in pty.ts.
 */

/** The tool description is the ONLY thing the model reads about this server. */
const LIST_TABS_DESCRIPTION =
  'List the tabs currently open in Claude Explorer, the file manager hosting this ' +
  'session. Returns a JSON array of tab objects: id, view ("files" | "terminal" | ' +
  '"viewer"), cwd (absolute Windows path), title, and — for a terminal tab — ptyId, ' +
  'terminalKind ("claude" | "shell"), status ("running" | "waiting" | "stopped") and ' +
  'agentSpawned (true only for a tab open_claude_session opened). A terminal tab has ' +
  'no status until its process emits something, so a missing status does NOT mean it ' +
  'has stopped. Tab ids exist nowhere else, so call this to obtain one. Safe to call ' +
  'again at any time: it only reads, and the list changes as the user opens and ' +
  'closes tabs.'

const CLOSE_TAB_DESCRIPTION =
  'Close one tab in Claude Explorer, the file manager hosting this session. `tabId` ' +
  'is an `id` from list_tabs — no other id works, and ids do not survive a restart. ' +
  'Closing a terminal tab ENDS the process in it: a Claude session there is ' +
  'terminated. Returns {"ok":true}; call list_tabs to see the result. On a timeout ' +
  'the tab may or may not have closed — call list_tabs, do not call this again ' +
  'blindly.'

const OPEN_VIEWER_TAB_DESCRIPTION =
  'Open a read-only tab in Claude Explorer showing the GIT DIFF of one file — the ' +
  'same output as `git diff` for that path. `path` is an ABSOLUTE Windows path to a ' +
  'file (e.g. C:\\Users\\me\\repo\\src\\index.ts) inside a git repository; an ' +
  'unchanged file opens an empty diff. If the file is NOT inside a git repository ' +
  'the call still returns {"ok":true} and the tab shows git\'s own error instead of a ' +
  'diff — so {"ok":true} means the tab was opened, not that a diff was produced. ' +
  'This only shows the USER something: it returns no file contents to you and changes ' +
  'nothing on disk. The new tab appears in list_tabs.'

/**
 * KAN-64. Built per request from the LIVE setting, because "the description and
 * the enforced behaviour must say the same thing in both directions" is the
 * acceptance bar and a hardcoded 8 stops being true the moment the user picks 4.
 * serve() already builds a fresh McpServer per HTTP request, so this costs one
 * settings read.
 *
 * ponytail: a client that fetched tools/list before the user changed the number
 * keeps the old text until it reconnects. Push tools/list_changed if that ever
 * matters — it needs the stateful transport serve() deliberately does not have.
 */
const openClaudeSessionDescription = (free: number): string =>
  'Start a NEW Claude Code session in a new terminal tab of Claude Explorer, in the ' +
  'folder `path` (an ABSOLUTE Windows path, e.g. C:\\Users\\me\\repo). It runs with ' +
  "the user's own permissions and that folder's CLAUDE.md, hooks and settings — " +
  'treat it as the user launching Claude Code there themselves. ' +
  'WHETHER IT ASKS THE USER FIRST DEPENDS ON HOW MANY SESSIONS THIS TOOL ALREADY HAS ' +
  'OPEN, against a number the user sets in Claude Explorer under Settings > ' +
  `Preferences…, currently ${free}. ` +
  (free === 0
    ? 'It is 0, so this tool ASKS EVERY TIME. Nothing you have open, and nothing that ' +
      'has since exited, changes that: no count makes a session free here, and no tab ' +
      'is ever closed on your behalf to make room. '
    : `While fewer than ${free} are open, this call starts the session immediately and ` +
      'returns {"started":true} — no token, no prompt, nothing for the user to answer. ' +
      `Once ${free} are open, it asks. `) +
  'WHEN IT ASKS, it takes two calls: call it with `path` alone and it returns ' +
  '{"needsConfirm":true,"token":…,"path":…,"expiresAt":…} while Claude Explorer asks ' +
  'the user to Allow or Deny that exact folder. Then call it AGAIN with the same ' +
  '`path` and that `token`. If that call returns needsConfirm again, the user has not ' +
  'answered yet — call again with the same token. On success it returns ' +
  '{"started":true}. A token works once, only for the path it was issued for, and ' +
  'expires after two minutes. THE NUMBER IS A THROTTLE, NOT A LIMIT: there is no ' +
  'count at which this tool stops working, and an approval always starts the session, ' +
  'however many are already open. ' +
  'IF THE USER DENIES, STOP: this tool then refuses for a short cooldown and the ' +
  'refusal tells you how many seconds. Do not retry to wait it out — only ask again ' +
  'if the user themselves asks you to. ' +
  'The new session has NO Claude Explorer tools: it cannot open tabs or start ' +
  'further sessions. ' +
  // Only when there IS a count. At 0 the guard never reaps (spawnguard.ts skips
  // it: no count there can produce room) and nothing is ever free, so every
  // sentence below would be a promise the code does not keep — which is the
  // description/behaviour equivalence this ticket exists to close.
  (free === 0
    ? ''
    : 'A session counts for as long as its TAB stays open in Claude ' +
      'Explorer — including one restored from before Claude Explorer last restarted that ' +
      'has not been reactivated yet. The process ending does not free the slot by itself, ' +
      'but you do not have to close those tabs: when a new session would otherwise need ' +
      'the user to be asked, Claude Explorer first closes the tabs THIS TOOL opened whose ' +
      'Claude process has already exited, and if that brings the count back under the ' +
      'number your session starts with no prompt after all. Tabs whose session is still ' +
      'running, and every tab the user opened themselves, are never closed for you — ' +
      'close_tab is the only way those go. ') +
  'If Claude Code has never run in that folder, the new tab will show ' +
  'Claude\'s "do you trust this folder" prompt until the user answers it. Call ' +
  'list_tabs to find the tab that was created.'

const token = randomBytes(32).toString('hex')

let http: Server | null = null
let port = 0

/**
 * KAN-64. Close the tabs THIS TOOL opened whose Claude has already exited, and
 * report how many agent sessions the snapshot it worked from has left. Called
 * only when a spawn is about to cross the allowance — never on a timer, never
 * at boot.
 *
 * DEAD vs DORMANT IS THE WHOLE RISK, and both have no live process:
 *  - DEAD, reapable: `agentSpawned` AND `status === 'stopped'`. That status
 *    comes from a pty:exit the renderer actually saw (ptystatus.ts, where
 *    'stopped' is terminal and never evicted), so it is positive evidence that
 *    a process ran here and ended.
 *  - DORMANT, NEVER reapable: `agentSpawned` with no ptyId — a tab restored
 *    from before a restart that the user has not activated. It is the only
 *    surviving trace of what the agent was doing, and closing it destroys that
 *    silently. It reports NO status, which is exactly why the test is
 *    `=== 'stopped'` and not `!== 'running'`: "no status entry" is also what a
 *    freshly spawned session looks like before its first byte, so the loose
 *    test would reap live spawns and dormant tabs alike.
 * A tab the USER opened is not `agentSpawned` and so is never a candidate,
 * however dead it is.
 *
 * Closed through the ordinary control op, so trash/undo/persist behave exactly
 * as they do for any other close and the renderer's pinned refusal still
 * stands. A close that refuses is simply not counted as room freed.
 *
 * ponytail: THE ALLOWANCE IS THEREFORE CONCURRENT, NOT A LIFETIME BUDGET, and
 * that is a consequence of the reap rather than an oversight. A session that
 * exits hands its free slot straight back, so an agent whose sessions die
 * quickly can start them without ever reaching a human — the number bounds how
 * many exist AT ONCE, not how many may be started. The ticket's own rule ("it
 * throttles, it never blocks") means what bounds total process creation is the
 * human watching tabs appear, plus DENY_COOLDOWN_MS once one is denied.
 * Ceiling: no rate limit. Add one (spawns per minute — not a refusal at a
 * count) if a runaway agent ever makes it concrete, and say "N CONCURRENT,
 * recycled automatically" wherever the number is described to a user, because
 * "N sessions" reads as a lifetime budget and is not one.
 */
async function reapDeadAgentTabs(): Promise<number | null> {
  const rows = await control({ op: 'listTabs' }).catch(() => null)
  if (!Array.isArray(rows)) return null // no window, or the renderer never answered
  const mine = (rows as ControlTab[]).filter((t) => t.agentSpawned)
  let closed = 0
  for (const t of mine) {
    if (t.status !== 'stopped') continue
    // Per tab, because one refusal (a pinned tab, an id that just went away)
    // must not cost the others — and a failed close is not a freed slot.
    const ok = await control({ op: 'closeTab', args: { tabId: t.id } }).then(
      () => true,
      () => false,
    )
    if (ok) closed++
  }
  // From THIS snapshot, not a re-poll: agentSessionCount() is
  // Math.max(live, persisted) and the persisted half stays stale-high until the
  // renderer's immediate-persist lands, which would undo the room just freed.
  return mine.length - closed
}

/**
 * KAN-41. Module scope, not inside serve(): the transport is stateless and
 * builds a FRESH McpServer per HTTP request, so anything the guard remembers —
 * the outstanding confirmation, the in-flight count — has to outlive a request.
 */
const guard = createSpawnGuard({
  liveCount: agentSessionCount,
  prompt: promptSpawnConfirm,
  // Read per request, not captured: the user can change it while sessions are
  // open, and the next call must honour the new number (KAN-64).
  allowance: () => getSettings().agentFreeSessions,
  reap: reapDeadAgentTabs,
})

/** The renderer's answer, wired in index.ts. Passed to the IPC glue rather than
 *  imported by it, so spawnconfirm.handlers stays a leaf. */
export const answerSpawnConfirm = (t: string, allow: boolean): void => guard.answer(t, allow)

/**
 * One control op, with ControlError mapped onto text a model can act on.
 *
 * `timeout` is the one that matters: the op may still be executing and cannot be
 * recalled, so the answer is never "try again" — it is "go and look". A retried
 * openClaudeSession is two Claude processes on one folder.
 */
async function runControl(op: ControlOp, what: string): Promise<ControlResult> {
  try {
    return await control(op)
  } catch (e) {
    if (e instanceof ControlError && e.code === 'timeout') {
      throw new Error(
        `Claude Explorer's window did not answer in time. ${what} may or may not have ` +
          'happened — call list_tabs to find out. Do NOT call this again blindly.',
      )
    }
    if (e instanceof ControlError && e.code === 'no-window') {
      throw new Error('Claude Explorer has no open window, so nothing was done.')
    }
    // `renderer`: unknown tab id, a request that expired in the queue, or a
    // throw the renderer caught. Its own message is the useful part.
    throw e instanceof Error ? e : new Error(String(e))
  }
}

/**
 * A caller-supplied path, checked for SHAPE before the resolver sees it.
 * Order is load-bearing: the resolver resolves a relative path against
 * Electron's cwd and would silently launder `src` into an absolute path the
 * model never named — and, for open_claude_session, into a folder the user is
 * then asked to approve.
 */
async function absolutePath(p: string): Promise<string> {
  if (!/^[a-zA-Z]:[\\/]|^\\\\[^\\]/.test(p)) {
    throw new Error(`path must be an absolute Windows path (e.g. C:\\Users\\me\\repo), got: ${p}`)
  }
  return canonicalizeAsync(p)
}

/**
 * ASYNC ON PURPOSE, all the way down. Both steps here are OS path resolution on
 * a path the CALLER named, and both are slow in exactly the same case: an SMB
 * host that does not answer. `\\10.255.255.1\share\x` takes ~21 seconds to fail,
 * and in the synchronous spelling all 21 are spent on main's thread — one
 * open_viewer_tab (which needs no confirmation at all) freezes IPC, pty output,
 * the menu and every repaint, and a loop over fresh hostnames keeps it frozen.
 * Awaited, the same stall costs this one request and nothing else.
 */
async function existingPath(p: string, want: 'file' | 'folder'): Promise<string> {
  const full = await absolutePath(p)
  const st = await stat(full).catch(() => null)
  if (!st) throw new Error(`no such path: ${full}`)
  if (st.isDirectory() !== (want === 'folder')) {
    throw new Error(`${full} is a ${st.isDirectory() ? 'folder' : 'file'}; this tool needs a ${want}`)
  }
  return full
}

const asText = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
})

export function startMcpServer(): Promise<{ port: number; token: string }> {
  // KAN-42: idempotent, because the kill switch can call this again at any
  // moment — settings:set runs it on every save, and a second listen() would
  // leave the first listener bound with nothing holding its handle.
  if (http) return Promise.resolve({ port, token })
  const srv = createServer((req, res) => {
    // Outside the transport, before any SDK code: everything below this line is
    // tool surface. See mcpauth.ts for why a request that merely arrived proves
    // nothing.
    if (!isAuthorized(req.headers.authorization, token)) {
      res.writeHead(401).end()
      return
    }
    serve(req, res).catch(() => {
      // handleRequest owns the response once it has written; a throw before that
      // (or from transport setup) would otherwise leave the socket hanging and,
      // unhandled, take main down with it.
      if (!res.headersSent) res.writeHead(500)
      if (!res.writableEnded) res.end()
    })
  })
  http = srv
  return new Promise((resolve, reject) => {
    // `on`, not `once`: the listener has to outlive listen() so that a later
    // server 'error' is consumed rather than thrown as an uncaught exception.
    // Rejecting an already-resolved promise is a no-op.
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ port, token })
    })
  })
}

export function stopMcpServer(): void {
  http?.close()
  http = null
}

async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // ponytail: stateless — a fresh transport per request, so N Claude Code
  // clients need no session bookkeeping and one client cannot lock the server (a
  // single stateful transport rejects a second initialize). The ceiling is no
  // server->client stream: no notifications/tools/list_changed, no resumability.
  // Go stateful with a sessionId->transport map if we ever push.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    // Defence in depth only — the bearer above already stops a browser page,
    // which cannot read the token and gets 401 before reaching here. This adds
    // the Host check (a rebound DNS name arrives as Host: evil.example), which
    // no hand-rolled Origin rule covers. allowedOrigins is deliberately unset:
    // the SDK skips the Origin check when the header is absent, and every real
    // client here is non-browser, so it would never fire.
    enableDnsRebindingProtection: true,
    // An exact string compare, so both spellings of loopback have to be listed:
    // our own config file dials 127.0.0.1, but a hand-written or future config
    // using `localhost` would otherwise get an opaque -32000 Invalid Host header
    // with a perfectly good token. A rebound DNS name still arrives as its own
    // Host (evil.example) and is still refused.
    allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
  })
  const server = new McpServer({ name: 'claude-explorer', version: app.getVersion() })
  // Every tool below throws on bad input, and the SDK turns a throwing callback
  // into an isError result carrying the message — which is the answer the model
  // needs. So a typed refusal IS a throw here; nothing reaches the http layer.
  server.registerTool('list_tabs', { description: LIST_TABS_DESCRIPTION }, async () => ({
    // control() rejects with a ControlError on `no-window` | `timeout` |
    // `renderer`; the SDK turns a throwing tool callback into an isError result
    // carrying the message, which is the answer the model needs, so no catch.
    // listTabs is the one op safe to retry on a timeout — it is read-only.
    content: [{ type: 'text' as const, text: JSON.stringify(await control({ op: 'listTabs' })) }],
  }))

  server.registerTool(
    'close_tab',
    { description: CLOSE_TAB_DESCRIPTION, inputSchema: { tabId: z.string() } },
    async ({ tabId }) => {
      // No default to the active tab, here or anywhere: an op that guesses its
      // target is one an injected instruction can aim at whatever is in front of
      // the user. An unknown or already-closed id comes back as `renderer`.
      await runControl({ op: 'closeTab', args: { tabId } }, 'The tab')
      return asText({ ok: true })
    },
  )

  server.registerTool(
    'open_viewer_tab',
    { description: OPEN_VIEWER_TAB_DESCRIPTION, inputSchema: { path: z.string() } },
    async ({ path }) => {
      // No `mode` property at all: "file" is unrepresentable rather than
      // rejected, so there is nothing for a caller to try. Diff shows the user
      // a change; a file viewer would be a read tool, and the agent has a shell.
      const filePath = await existingPath(path, 'file')
      await runControl({ op: 'openViewerTab', args: { filePath, mode: 'diff' } }, 'The tab')
      return asText({ ok: true })
    },
  )

  server.registerTool(
    'open_claude_session',
    {
      description: openClaudeSessionDescription(getSettings().agentFreeSessions),
      inputSchema: { path: z.string(), token: z.string().optional() },
    },
    async ({ path, token: confirmToken }) => {
      // Validated before the guard sees either call, so a bad path never reaches
      // a human as a prompt and never mints a token.
      const cwd = await existingPath(path, 'folder')
      // No `resumeId`: the tool starts a new session and nothing else. Picking up
      // someone else's conversation is not a thing an agent gets to do.
      const decision = await guard.request(cwd, confirmToken, async (p) => {
        await runControl({ op: 'openClaudeSession', args: { cwd: p } }, 'The session')
      })
      if (decision.kind === 'refused') throw new Error(decision.reason)
      return asText(
        decision.kind === 'spawned'
          ? { started: true, path: cwd }
          : {
              needsConfirm: true,
              token: decision.token,
              path: decision.path,
              expiresAt: decision.expiresAt,
            },
      )
    },
  )
  // .catch, not `void`: close() is async and ends in Protocol._onclose(), which
  // settles every outstanding response handler — a throw in one of those rejects
  // close(), and an unhandled rejection takes main down with it (Node 22's
  // default). Nothing to do about it here but not die: the response is over.
  res.on('close', () => { transport.close().catch(() => {}) })
  await server.connect(transport)
  await transport.handleRequest(req, res)
}
