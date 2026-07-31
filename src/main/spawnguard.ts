import { randomBytes } from 'node:crypto'
import { DEFAULT_AGENT_FREE_SESSIONS } from '../shared/types'

/**
 * KAN-41. The human gate in front of `open_claude_session`, and (KAN-64) the
 * free allowance that decides when that gate is shown.
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
/**
 * KAN-64. How many app-spawned Claude sessions may be open before the tool
 * starts asking, when the caller supplies no `allowance`. The real app always
 * supplies one (the user's setting); this is the fallback for a guard built
 * without it.
 *
 * A THROTTLE, NOT A CAP. It used to be `MAX_AGENT_SESSIONS`, a hard refusal at
 * 8 — which made the user hand-close a tab whose Claude had already exited just
 * to reclaim a slot the app knew was free. Now crossing it costs one human
 * click, every time, for as long as the user keeps clicking. What bounds
 * unbounded process creation from a prompt-injected agent is therefore the
 * human on the other side of `prompt` (plus DENY_COOLDOWN_MS below), not a
 * number; the number only decides how soon that human is involved.
 */
export const DEFAULT_FREE_AGENT_SESSIONS = DEFAULT_AGENT_FREE_SESSIONS
/**
 * How long a Deny silences the next ask.
 *
 * Without it, `answer()` frees the slot the instant the user refuses and the
 * agent re-asks immediately: measured at 12 modals in 428 ms. The prompt is a
 * fixed full-window backdrop, so at ~28 a second the app is unusable, the user
 * cannot even read the tab they are worried about, and an Allow button is
 * flashing under their cursor — the realistic outcome is a mis-click or a
 * force-quit, i.e. the DoS ends in an approval.
 *
 * Ten seconds, chosen against the two costs. Against the attack it is a 280x
 * cut (0.1 prompts/s instead of 28): every modal is readable, dismissable, and
 * leaves the app usable in between. Against the honest case — the user denies,
 * then tells the agent to try a different folder — the conversational turn that
 * produces the second ask already takes longer than this, and the refusal below
 * TELLS the model how long to wait, so it is a pause, not a failure. Longer
 * would start punishing the honest case for nothing; shorter stops being a
 * meaningful cut.
 *
 * GLOBAL, not per-path: an agent supplies the folder, so a per-path cooldown is
 * walked around by naming a sibling directory. Only a Deny arms it — an expiry
 * already costs the attacker the full TTL, and an Allow is not a refusal.
 */
export const DENY_COOLDOWN_MS = 10_000

export type SpawnDecision =
  | { kind: 'needsConfirm'; token: string; path: string; expiresAt: number }
  | { kind: 'spawned' }
  | { kind: 'refused'; reason: string }

/** A scheduled timeout, cancelled by calling it — same shape as control.ts. */
export type Cancel = () => void

export interface SpawnGuardOpts {
  /** How many app-spawned Claude sessions currently count against the
   *  allowance. DERIVED, never a counter — no site anywhere decrements this,
   *  because nothing ever needs to remember to. As of KAN-64 this is not only
   *  "live": a session still counts while its tab is open even with no process
   *  behind it yet (a tab restored from before a restart) or no process behind
   *  it any more (its Claude exited but the tab was not closed) — see
   *  pty.handlers.ts's agentSessionCount, the sole caller in the real app. */
  liveCount: () => number
  /** Show the prompt. `false` = no window to show it in, so no token is minted —
   *  a token nobody can ever answer is a permission that only expires. */
  prompt: (p: { token: string; path: string; expiresAt: number }) => boolean
  /** KAN-64. How many sessions may open WITHOUT asking. Read fresh on every
   *  request, not captured: it is a user setting and can change mid-run. `0`
   *  means ask every time, which is exactly the behaviour KAN-41 shipped. */
  allowance?: () => number
  /**
   * KAN-64. The last thing tried before a human is asked: close the tabs this
   * tool opened whose Claude process has ALREADY EXITED, and report how many
   * agent sessions the snapshot it worked from has left — or `null` if it could
   * not tell (no window, a timeout), which is treated as "no room freed".
   *
   * Called ONLY when a spawn would otherwise cross the allowance, which is the
   * whole design: nothing disappears while the user is merely using the app, so
   * a dead agent tab stays on screen as the record of what happened until its
   * slot is genuinely wanted. Deciding WHICH tabs are dead is the caller's job
   * and is the risky half — see mcp.ts.
   */
  reap?: () => Promise<number | null>
  now?: () => number
  newToken?: () => string
  schedule?: (fn: () => void, ms: number) => Cancel
  ttlMs?: number
  waitMs?: number
  cooldownMs?: number
}

export interface SpawnGuard {
  /**
   * ONE MCP tool invocation.
   *
   * `token` undefined -> under the allowance, SPAWN with no prompt and no token
   *                      (KAN-64). Otherwise reap, and if that did not make
   *                      room, mint + prompt and resolve `needsConfirm`
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
   *  frees the slot immediately and starts the DENY_COOLDOWN_MS backoff; an
   *  allow leaves it until claimed or expired. */
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
  const allowance = opts.allowance ?? (() => DEFAULT_FREE_AGENT_SESSIONS)
  const cooldownMs = opts.cooldownMs ?? DENY_COOLDOWN_MS
  const now = opts.now ?? Date.now
  const newToken = opts.newToken ?? (() => randomBytes(32).toString('hex'))
  const schedule = opts.schedule ?? defaultSchedule

  let pending: Pending | null = null
  let inFlight = 0
  /** Wall-clock instant the last Deny stops silencing mint(). Not a flag and not
   *  a timer: it EXPIRES by itself, so there is no clear-it site to forget and
   *  no way for one refusal to disable the tool for the rest of the run. */
  let deniedUntil = 0

  /**
   * How many sessions may still open silently. The in-flight term is why
   * `inFlight` exists: without it, N concurrent requests all read the same
   * pre-spawn total and all decide they are under the allowance. During the
   * overlap a session is briefly counted twice (the pty exists AND control()
   * has not returned); a throttle should err that way.
   *
   * `Math.trunc`/`Math.max` on the allowance because it comes from a
   * user-editable file through settings.ts — normalized there, defended here,
   * since a NaN would make every comparison false and silently turn the
   * allowance into "ask every time"... which is the safe direction, but only by
   * luck, and `-1` is not.
   */
  const room = (count: number): boolean =>
    count + inFlight < Math.max(0, Math.trunc(allowance()) || 0)

  /** The two refusals that outrank everything, including a FREE spawn: a fresh
   *  Deny must not be walked around by a slot opening up, and one outstanding
   *  confirmation app-wide is what bounds this file's state at one record.
   *  Re-checked after the reap's await, because both can arm during it. */
  const blocked = (): SpawnDecision | null => {
    // Before the pending check, because a Deny clears `pending` — this is the
    // only thing standing between a refusal and the next modal. A typed reason
    // carrying the wait, so a model that is not attacking knows to pause rather
    // than to retry blind. See DENY_COOLDOWN_MS.
    const wait = deniedUntil - now()
    if (wait > 0) {
      return {
        kind: 'refused',
        reason:
          `the user denied the last request to start a Claude session; do not ask again ` +
          `for ${Math.ceil(wait / 1000)}s, and only if they ask you to`,
      }
    }
    if (pending) {
      return {
        kind: 'refused',
        reason: `Claude Explorer is already asking the user about ${pending.path}; wait for that to be answered`,
      }
    }
    return null
  }

  /** A spawn nobody was asked about (KAN-64), counted while it is in flight for
   *  the same reason a redeemed one is. */
  const freeSpawn = async (
    path: string,
    spawn: (path: string) => Promise<void>,
  ): Promise<SpawnDecision> => {
    inFlight++
    try {
      await spawn(path)
    } finally {
      inFlight--
    }
    return { kind: 'spawned' }
  }

  const mint = async (
    path: string,
    spawn: (path: string) => Promise<void>,
  ): Promise<SpawnDecision> => {
    const stop = blocked()
    if (stop) return stop
    // KAN-64: under the allowance, no human is involved at all.
    if (room(opts.liveCount())) return freeSpawn(path, spawn)
    // At it — so before spending a human's attention, take back the slots held
    // by tabs this tool opened whose Claude has already exited. Skipped
    // entirely at an allowance of 0, where no count can ever produce room and
    // reaping could only close tabs for nothing.
    if (allowance() > 0) {
      const left = await opts.reap?.()
      // Re-checked, not assumed: `await` means a Deny or another ask can have
      // landed while the reap was closing tabs, and minting past either would
      // clobber an outstanding confirmation.
      const stopAgain = blocked()
      if (stopAgain) return stopAgain
      // From the reap's OWN snapshot, never a re-poll of liveCount(): that is
      // Math.max(live, persisted) and the persisted half reads stale-high until
      // the renderer's immediate-persist lands, so a re-poll would prompt for a
      // slot the reap had just freed.
      if (left !== null && left !== undefined && room(left)) return freeSpawn(path, spawn)
    }
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

    // KAN-64: NO count re-check here any more. The allowance is a throttle, and
    // this is the user having answered the throttle's question with "yes" —
    // refusing them their own approval because the number moved while they read
    // the dialog is the hard refusal this ticket removed.
    return freeSpawn(path, spawn)
  }

  return {
    request: (path, token, spawn) =>
      token === undefined ? mint(path, spawn) : redeem(path, token, spawn),

    answer: (token, allow) => {
      const p = pending
      if (!p || p.token !== token) return
      // A deny frees the slot now rather than at the TTL, so the next ask does
      // not have to wait out two minutes of a permission the user refused — and
      // arms the cooldown, so freeing it is not an invitation to re-ask at once.
      if (!allow) {
        pending = null
        p.cancel()
        deniedUntil = now() + cooldownMs
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
