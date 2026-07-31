// KAN-40 — pure unit tests for the bearer-token gate in src/main/mcpauth.ts.
// No electron, no net, no http server: isAuthorized() is exercised directly.
//
// CLAUDE.md rule: an assertion only earns its place if it fails against the
// UNMODIFIED build. Every assertion below was proven red by mutating
// src/main/mcpauth.ts (never checked in — see the report accompanying this
// file for the exact mutation + captured RED output for each), then the file
// was restored verbatim before this suite was left in its final state.
//
// "Refusal semantics, not merely a boolean" (per the task): guardedToolCall()
// below is the same one-line shape mcp.ts's real request handler uses around
// isAuthorized — a 401 short-circuits before any tool code runs. Wrapping it
// here lets every negative case assert BOTH the 401 AND that tool code (the
// `tally` counter) was never reached, instead of trusting the boolean alone.
import { describe, it, expect } from 'vitest'
import { isAuthorized } from '../src/main/mcpauth'

const TOKEN = 'a1'.repeat(32) // 64 hex chars, shape of the real randomBytes(32) token

function guardedToolCall(header: string | undefined, token: string, tally: { reached: number }): number {
  if (!isAuthorized(header, token)) return 401
  tally.reached++
  return 200
}

describe('isAuthorized', () => {
  it('accepts the exact valid bearer header, and only then does tool code run', () => {
    const tally = { reached: 0 }
    expect(isAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true)
    expect(guardedToolCall(`Bearer ${TOKEN}`, TOKEN, tally)).toBe(200)
    expect(tally.reached).toBe(1)
  })

  it('refuses a wrong token of the SAME length (exercises the timingSafeEqual compare path)', () => {
    const wrongSameLength = 'b1' + TOKEN.slice(2) // 64 chars, one hex digit different
    expect(wrongSameLength).toHaveLength(TOKEN.length)
    const tally = { reached: 0 }
    expect(isAuthorized(`Bearer ${wrongSameLength}`, TOKEN)).toBe(false)
    expect(guardedToolCall(`Bearer ${wrongSameLength}`, TOKEN, tally)).toBe(401)
    expect(tally.reached).toBe(0)
  })

  it('refuses a wrong token of a DIFFERENT length without crashing (timingSafeEqual throws on raw length mismatch)', () => {
    const wrongDiffLength = 'c2'.repeat(10) // 20 chars, shorter than TOKEN
    expect(wrongDiffLength).not.toHaveLength(TOKEN.length)
    const tally = { reached: 0 }
    expect(() => isAuthorized(`Bearer ${wrongDiffLength}`, TOKEN)).not.toThrow()
    expect(isAuthorized(`Bearer ${wrongDiffLength}`, TOKEN)).toBe(false)
    expect(guardedToolCall(`Bearer ${wrongDiffLength}`, TOKEN, tally)).toBe(401)
    expect(tally.reached).toBe(0)
  })

  it('refuses a missing Authorization header without crashing', () => {
    const tally = { reached: 0 }
    expect(() => isAuthorized(undefined, TOKEN)).not.toThrow()
    expect(isAuthorized(undefined, TOKEN)).toBe(false)
    expect(guardedToolCall(undefined, TOKEN, tally)).toBe(401)
    expect(tally.reached).toBe(0)
  })

  it('refuses malformed headers: no "Bearer " prefix, wrong scheme, and empty string', () => {
    const tally = { reached: 0 }
    for (const bad of [TOKEN, `Basic ${TOKEN}`, '']) {
      expect(isAuthorized(bad, TOKEN)).toBe(false)
      expect(guardedToolCall(bad, TOKEN, tally)).toBe(401)
    }
    expect(tally.reached).toBe(0)
  })

  it('CRITICAL: refuses the literal unexpanded placeholder Claude Code sends when the env var is unset (verified fact 2)', () => {
    const literal = 'Bearer ${CLAUDE_EXPLORER_MCP_TOKEN}'
    const tally = { reached: 0 }
    expect(isAuthorized(literal, TOKEN)).toBe(false)
    expect(guardedToolCall(literal, TOKEN, tally)).toBe(401)
    expect(tally.reached).toBe(0)
  })

  it('refuses everything when the server token itself is blank, including the header that would otherwise match it', () => {
    const tally = { reached: 0 }
    // Without the `!token` guard, `Bearer ` (header) === `Bearer ${''}` (target)
    // would be a byte-for-byte match — this is the case that guard exists for.
    expect(isAuthorized('Bearer ', '')).toBe(false)
    expect(guardedToolCall('Bearer ', '', tally)).toBe(401)
    expect(tally.reached).toBe(0)
  })
})
