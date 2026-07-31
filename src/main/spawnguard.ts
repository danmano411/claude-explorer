import { randomBytes } from 'node:crypto'

/**
 * KAN-41. The human gate in front of `open_claude_session`, and the cap on how
 * many sessions an agent may have running.
 *
 * Pure, in the same sense control.ts is: no electron, no fs, no HTTP. The clock,
 * the timer, the token source, the prompt and the live-session count are all
 * handed in, so every rule below is testable without a window or a process.
 *
 * The rule this file exists for: A TOKEN IS CONSUMED BEFORE ANYTHING SPAWNS, not
 * after the spawn settles. Control ops are at-least-once and not cancellable, so
 * a spawn that times out may well have started; if the token were still live at
 * that point the agent's retry would be a SECOND Claude Code on the same folder.
 * Consuming at the claim makes the retry a no-op instead. See `request`.
 */

/** How long a confirmation the user never answered stays answerable. */
export const CONFIRM_TTL_MS = 120_000
/** How long one redemption waits on the human before answering `needsConfirm`
 *  again. Shorter than the TTL so the model gets a sentence rather than a
 *  transport abort; correctness does not depend on it (the claim below is what
 *  makes a repeat wait safe). */
export const CONFIRM_WAIT_MS = 55_000
/** Concurrent app-spawned Claude sessions. The worst case this bounds is not
 *  data loss, it is unbounded process creation and API spend from one
 *  prompt-injected agent. */
export const MAX_AGENT_SESSIONS = 8

export type SpawnDecision =
  | { kind: 'needsConfirm'; token: string; path: string; expiresAt: number }
  | { kind: 'spawned' }
  | { kind: 'refused'; reason: string }

/** A scheduled timeout, cancelled by calling it — same shape as control.ts. */
export type Cancel = () => void

export interface SpawnGuardOpts {
  /** Live app-spawned Claude sessions. DERIVED from the pty handle map, never a
   *  counter: the map loses its entry on pty exit AND on kill(), which is what
   *  closing a tab does, so there is no decrement site to forget. */
  liveCount: () => number
  /** Show the prompt. `false` = no window to show it in, so no token is minted —
   *  a token nobody can ever answer is a permission that only expires. */
  prompt: (p: { token: string; path: string; expiresAt: number }) => boolean
  now?: () => number
  newToken?: () => string
  schedule?: (fn: () => void, ms: number) => Cancel
  ttlMs?: number
  waitMs?: number
  max?: number
}

export interface SpawnGuard {
  /**
   * ONE MCP tool invocation.
   *
   * `token` undefined -> cap pre-check, mint, prompt, resolve `needsConfirm`
   *                      WITHOUT calling `spawn`.
   * `token` given     -> match token AND path against the single outstanding
   *                      confirmation, wait for the answer, and on allow CONSUME
   *                      it BEFORE calling `spawn`. Still unanswered after
   *                      `waitMs` -> the SAME `needsConfirm` payload, so a
   *                      repeat call is safe and needs no third shape.
   *
   * `path` must already be canonical: the guard does string equality only.
   * A rejection from `spawn` propagates unchanged (the in-flight count is
   * released in a `finally`) so the caller can map ControlError codes itself.
   */
  request(
    path: string,
    token: string | undefined,
    spawn: (path: string) => Promise<void>,
  ): Promise<SpawnDecision>
  /** The user's answer. Total: an unknown or stale token is dropped, never
   *  thrown — the IPC listener calling this has nobody to catch for it. A deny
   *  frees the slot immediately; an allow leaves it until claimed or expired. */
  answer(token: string, allow: boolean): void
  readonly pending: Readonly<{ token: string; path: string; expiresAt: number }> | null
  readonly inFlight: number
}

/** `true` allow, `false` deny, `null` the TTL fired with nobody answering. */
type Answer = boolean | null

type Pending = {
  token: string
  path: string
  expiresAt: number
  answered: Promise<Answer>
  settle: (a: Answer) => void
  cancel: Cancel
}

const defaultSchedule = (fn: () => void, ms: number): Cancel => {
  const t = setTimeout(fn, ms)
  return () => clearTimeout(t)
}

/**
 * ponytail: ONE outstanding confirmation app-wide, not a map. A second
 * token-less call while one is pending is refused, which bounds the state at one
 * record and one timer by construction instead of by expiry hygiene — there is
 * no set of live spawn permissions to accumulate. Ceiling: an agent cannot queue
 * two folders. Make it a map (with a size cap) if anyone ever wants to.
 */
export function createSpawnGuard(opts: SpawnGuardOpts): SpawnGuard {
  const ttlMs = opts.ttlMs ?? CONFIRM_TTL_MS
  const waitMs = opts.waitMs ?? CONFIRM_WAIT_MS
  const max = opts.max ?? MAX_AGENT_SESSIONS
  const now = opts.now ?? Date.now
  const newToken = opts.newToken ?? (() => randomBytes(32).toString('hex'))
  const schedule = opts.schedule ?? defaultSchedule

  let pending: Pending | null = null
  let inFlight = 0

  /** In-flight spawns count. Without that, N concurrent redemptions all read the
   *  same pre-spawn total. During the overlap a session is briefly counted twice
   *  (the pty exists AND control() has not returned); a safety valve should err
   *  that way. */
  const atCap = (): boolean => opts.liveCount() + inFlight >= max

  const capReason = `at most ${max} Claude sessions started by this tool may run at once; close one first`

  const mint = (path: string): SpawnDecision => {
    if (pending) {
      return {
        kind: 'refused',
        reason: `Claude Explorer is already asking the user about ${pending.path}; wait for that to be answered`,
      }
    }
    if (atCap()) return { kind: 'refused', reason: capReason }
    const token = newToken()
    const expiresAt = now() + ttlMs
    // Prompt BEFORE recording anything: a mint whose prompt never reached a
    // window would leave a permission that can only expire.
    if (!opts.prompt({ token, path, expiresAt })) {
      return { kind: 'refused', reason: 'Claude Explorer has no window to ask the user in' }
    }
    let settle!: (a: Answer) => void
    const answered = new Promise<Answer>((r) => {
      settle = r
    })
    const p: Pending = {
      token,
      path,
      expiresAt,
      answered,
      settle,
      cancel: schedule(() => {
        if (pending === p) pending = null
        settle(null)
      }, ttlMs),
    }
    pending = p
    return { kind: 'needsConfirm', token, path, expiresAt }
  }

  const redeem = async (
    path: string,
    token: string,
    spawn: (path: string) => Promise<void>,
  ): Promise<SpawnDecision> => {
    const p = pending
    if (!p || p.token !== token) {
      return {
        kind: 'refused',
        reason:
          'that confirmation token is unknown, already used, or expired; call this tool again with only `path` to ask the user afresh',
      }
    }
    // Refused WITHOUT consuming: a wrong-path redemption must not burn the
    // approval the user actually gave.
    if (p.path !== path) {
      return {
        kind: 'refused',
        reason: `that token was issued for ${p.path}, not ${path}`,
      }
    }

    let cancelWait: Cancel = () => {}
    const waited = new Promise<'wait'>((r) => {
      cancelWait = schedule(() => r('wait'), waitMs)
    })
    const answer = await Promise.race([p.answered, waited])
    cancelWait()

    if (answer === 'wait') {
      return { kind: 'needsConfirm', token: p.token, path: p.path, expiresAt: p.expiresAt }
    }
    if (answer === null) {
      return { kind: 'refused', reason: 'the user did not answer in time; ask again if still needed' }
    }
    if (answer === false) {
      return { kind: 'refused', reason: 'the user declined to start a Claude session there' }
    }

    // --- CLAIM. Synchronous from here to `pending = null`, so two redemptions
    // that woke on the same answer cannot both win, and — the point of the whole
    // file — the token is dead BEFORE any spawn exists. Moving this below the
    // `await spawn` is the defect: a spawn that timed out but did start would
    // leave a live token, and the retry would be a second Claude Code.
    if (pending !== p) {
      return { kind: 'refused', reason: 'that confirmation was already used' }
    }
    pending = null
    p.cancel()

    // The world moves while a human thinks, so the cap is checked again here and
    // not only at mint.
    if (atCap()) return { kind: 'refused', reason: capReason }

    inFlight++
    try {
      await spawn(path)
    } finally {
      inFlight--
    }
    return { kind: 'spawned' }
  }

  return {
    request: (path, token, spawn) =>
      token === undefined ? Promise.resolve(mint(path)) : redeem(path, token, spawn),

    answer: (token, allow) => {
      const p = pending
      if (!p || p.token !== token) return
      // A deny frees the slot now rather than at the TTL, so the next ask does
      // not have to wait out two minutes of a permission the user refused.
      if (!allow) {
        pending = null
        p.cancel()
      }
      p.settle(allow)
    },

    get pending() {
      return pending && { token: pending.token, path: pending.path, expiresAt: pending.expiresAt }
    },

    get inFlight() {
      return inFlight
    },
  }
}
