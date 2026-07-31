import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * KAN-40 bearer check, pure so it is testable without a server or a live token.
 *
 * FAIL CLOSED, and the reason is measured, not theoretical: a `--mcp-config`
 * whose `${CLAUDE_EXPLORER_MCP_TOKEN}` is unset expands to nothing — Claude Code
 * sends the LITERAL `Bearer ${CLAUDE_EXPLORER_MCP_TOKEN}`, connects, and exits 0
 * with no error anywhere. So "a request arrived" is never authentication; only
 * this function's `true` is, and it must run before any tool code.
 *
 * Digests, not the raw strings, because timingSafeEqual throws on a length
 * mismatch: an early `length !==` return would both leak the length and be the
 * only shape that never reaches the constant-time compare. SHA-256 makes every
 * input — absent, empty, wrong scheme, the literal placeholder, a wrong token of
 * any size — 32 bytes and one code path.
 */
export function isAuthorized(header: string | undefined, token: string): boolean {
  // A blank token would make `Bearer ` a valid credential; nothing should ever
  // call in with one, which is exactly why it is worth one line here.
  if (!token) return false
  const digest = (s: string): Buffer => createHash('sha256').update(s).digest()
  return timingSafeEqual(digest(header ?? ''), digest(`Bearer ${token}`))
}
