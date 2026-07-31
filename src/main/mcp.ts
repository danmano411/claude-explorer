import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { app } from 'electron'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { control } from './control.handlers'
import { isAuthorized } from './mcpauth'

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
  'terminalKind ("claude" | "shell") and status ("running" | "waiting" | "stopped"). ' +
  'Tab ids exist nowhere else, so call this to obtain one. Safe to call again at any ' +
  'time: it only reads, and the list changes as the user opens and closes tabs.'

const token = randomBytes(32).toString('hex')

let http: Server | null = null
let port = 0

export function startMcpServer(): Promise<{ port: number; token: string }> {
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
  server.registerTool('list_tabs', { description: LIST_TABS_DESCRIPTION }, async () => ({
    // control() rejects with a ControlError on `no-window` | `timeout` |
    // `renderer`; the SDK turns a throwing tool callback into an isError result
    // carrying the message, which is the answer the model needs, so no catch.
    // listTabs is the one op safe to retry on a timeout — it is read-only.
    content: [{ type: 'text' as const, text: JSON.stringify(await control({ op: 'listTabs' })) }],
  }))
  // .catch, not `void`: close() is async and ends in Protocol._onclose(), which
  // settles every outstanding response handler — a throw in one of those rejects
  // close(), and an unhandled rejection takes main down with it (Node 22's
  // default). Nothing to do about it here but not die: the response is over.
  res.on('close', () => { transport.close().catch(() => {}) })
  await server.connect(transport)
  await transport.handleRequest(req, res)
}
