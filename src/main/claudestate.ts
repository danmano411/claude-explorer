import type { ClaudeState } from '../shared/types'

/**
 * KAN-73. The Claude session-state signal: what goes into the injected settings
 * blob, and how a hook payload becomes a `ClaudeState`. Pure — no electron, no
 * http, no PtyManager — so the state machine is testable without any of them
 * (mcp.ts owns the socket, pty.handlers.ts owns the window).
 *
 * WHY HOOKS AND NOT SOMETHING ALREADY HERE. Both alternatives were checked
 * against the installed binary and neither can answer the question:
 *  - The JSONL transcript writes a `tool_use` block as soon as the model turn
 *    returns, BEFORE any permission dialog, and the matching `tool_result` only
 *    lands in the next record. "Awaiting approval", "tool running" and "tool
 *    crashed" are one state there. (There is also no file watcher in this tree
 *    — sessions.ts is read-on-demand — so this route is new machinery that
 *    still cannot distinguish them.)
 *  - Terminal bell / OSC: `preferredNotifChannel` defaults to `auto`, which
 *    emits nothing in a ConPTY/xterm.js host, and even forced it cannot
 *    separate permission-needed from finished.
 */

/**
 * The route on mcp.ts's existing loopback listener that hooks POST to. A route
 * on THAT server rather than a second listener: the trust boundary, the
 * ephemeral port, the per-run bearer token and mcpauth.ts's fail-closed check
 * all already exist there, and mcp.ts checks the bearer for the whole server
 * before it routes anything. A second listener would be a second place to get
 * that right.
 */
export const HOOK_PATH = '/claude-state'

/**
 * The env var the hook's Authorization header interpolates, matching what
 * mcp-agent-control.json does for `--mcp-config`: the file on disk holds the
 * LITERAL `${CLAUDE_EXPLORER_MCP_TOKEN}` and pty.ts puts the real token in the
 * session's environment, so the token still never touches disk.
 *
 * `allowedEnvVars` is not optional garnish — verified in the binary, header
 * interpolation is OFF unless the variable is named there ("Required for env
 * var interpolation to work"), and an un-interpolated `${...}` would be sent as
 * a literal, which mcpauth.ts 401s. That is the same silent-literal failure
 * mode mcpauth.ts's comment already describes for `--mcp-config`.
 */
const TOKEN_VAR = 'CLAUDE_EXPLORER_MCP_TOKEN'

/**
 * Seconds. A hook runs INSIDE the turn — UserPromptSubmit fires before the
 * prompt goes out — so this is the worst case a user waits if main is wedged
 * (a dead-UNC stat still costs ~21 s of libuv threadpool, KAN-65). Loopback to
 * a handler that parses one small object and returns is sub-millisecond, so 2
 * is generous for the honest case and cheap for the pathological one.
 */
const HOOK_TIMEOUT_S = 2

/**
 * The settings blob passed as `claude --settings <path>`.
 *
 * A PATH, never inline JSON: see pty.ts:163-208 for the cmd.exe quoting rule
 * that a fourth quote on the line breaks, and inline JSON is nothing but
 * quotes. The path form is the one `--mcp-config` already proved through that
 * code.
 *
 * Deliberately NOT `~/.claude/settings.json`: that would change Claude Code's
 * behaviour for every session on the machine, including ones this app never
 * launched, and leave residue after an uninstall. `--settings` is per-launch
 * and MERGES rather than replaces — measured, not assumed: a project
 * `.claude/settings.json` hook and a `--settings` hook for the same event both
 * fired, in that order, against claude.exe v2.1.220.
 *
 * `type: "http"` rather than `command`: no process spawn per event (this fires
 * on every tool call), and it reuses the trust boundary above. HTTP hooks are
 * refused by Claude Code for `SessionStart`/`Setup` — neither is used here.
 *
 * NO `matcher` ON Notification, on purpose. The matcher would be the
 * notification_type, and putting the two names we care about there means a
 * renamed or mistyped matcher silently yields no hook at all. Matching
 * everything and deciding in stateFromHook() below puts that decision in
 * TypeScript, where a test can hold it.
 */
export function hookSettings(port: number): object {
  const hook = {
    type: 'http',
    url: `http://127.0.0.1:${port}${HOOK_PATH}`,
    headers: { Authorization: `Bearer \${${TOKEN_VAR}}` },
    allowedEnvVars: [TOKEN_VAR],
    timeout: HOOK_TIMEOUT_S,
  }
  const on = [{ hooks: [hook] }]
  // Exactly the five events the state machine needs. Nothing speculative: each
  // one is a transition in stateFromHook below, and an event with no transition
  // would be traffic on every turn for nothing.
  return {
    hooks: {
      UserPromptSubmit: on, PreToolUse: on, PostToolUse: on, Notification: on, Stop: on,
    },
  }
}

/**
 * A hook payload -> a transition, or null for "this says nothing about state".
 *
 * The whole state machine, in one place:
 *
 *   UserPromptSubmit                  -> working
 *   PreToolUse                        -> working
 *   PostToolUse                       -> working
 *   Notification/permission_prompt    -> awaiting-input
 *   Notification/idle_prompt          -> idle
 *   Stop                              -> idle
 *   pty:exit (existing IPC, not here) -> stopped
 *
 * NEITHER TOOL EVENT IS EVER "PERMISSION NEEDED". They fire around every tool
 * call in every permission mode, including bypass and accept-edits, so reading
 * either as blocked would paint the urgent state on every session that never
 * blocks. `permission_prompt` is the only thing that means blocked.
 *
 * `PostToolUse` IS THE ONE THAT CLEARS `awaiting-input`, and it is here because
 * a real session said so. The design assumed `PreToolUse` would do it, on the
 * reasoning that the approved tool then runs — but measured against a live
 * permission dialog the order is PreToolUse, THEN the dialog, so PreToolUse has
 * already fired by the time anyone is blocked and cannot clear anything. There
 * is no hook on the approval itself. PostToolUse is therefore the earliest
 * signal that the human is no longer the thing being waited on; without it a
 * tab stays "needs you" for the entire duration of a tool the user already
 * approved, which for a long build is minutes of exactly the false alarm this
 * milestone exists to remove.
 *
 * `Stop` is the main agent only — `SubagentStop` is a separate event and is not
 * registered — so a Task subagent finishing cannot report the session idle
 * while the parent is still working. A subagent's own PreToolUse does arrive
 * (same `session_id`, plus an `agent_id` we ignore) and says `working`, which
 * is true of the session.
 *
 * The Notification types deliberately NOT mapped: `auth_success`,
 * `elicitation_dialog`, `elicitation_complete`, `elicitation_response`,
 * `agent_needs_input`, `agent_completed`. They arrive (there is no matcher) and
 * are dropped. Two of them arguably mean awaiting-input; adding them is a
 * one-line change here when a real session is seen to need it, and guessing
 * wrong paints a blocked dot on a session nobody has to answer.
 *
 * Untyped input on purpose: this is parsed from a request body. Everything is
 * shape-checked here rather than trusted, and anything unrecognised is null.
 */
export function stateFromHook(body: unknown): { sessionId: string; state: ClaudeState } | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>
  const sessionId = b.session_id
  if (typeof sessionId !== 'string' || sessionId === '') return null
  let state: ClaudeState | null = null
  switch (b.hook_event_name) {
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      state = 'working'
      break
    case 'Stop':
      state = 'idle'
      break
    case 'Notification':
      state =
        b.notification_type === 'permission_prompt'
          ? 'awaiting-input'
          : b.notification_type === 'idle_prompt'
            ? 'idle'
            : null
      break
  }
  return state === null ? null : { sessionId, state }
}
