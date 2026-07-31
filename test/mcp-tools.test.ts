// KAN-41 — pure unit tests for the confirm-token / cap core in
// src/main/spawnguard.ts, tested as a pure module (no electron, no http, no
// real timers — every ambient dependency is injected, same shape as
// control.test.ts's harness for control.ts).
//
// CLAUDE.md rule: an assertion only earns its place if it fails against the
// UNMODIFIED build. Every assertion below was proven red by a TARGETED
// mutation of src/main/spawnguard.ts, run with `npx vitest run
// test/mcp-tools.test.ts`, then the file was restored to its exact original
// text (verified with `git diff --stat src/main/spawnguard.ts` showing no
// changes) before this suite was left in its final state. See the report
// accompanying this file for the exact mutation + captured RED output for
// each numbered case.
import { describe, it, expect } from 'vitest'
import { createSpawnGuard, type SpawnGuardOpts, type SpawnDecision } from '../src/main/spawnguard'

type SchedCall = { fn: () => void; ms: number; cancelled: boolean }

function harness(overrides: Partial<SpawnGuardOpts> = {}) {
  const scheduled: SchedCall[] = []
  const prompts: { token: string; path: string; expiresAt: number }[] = []
  const spawnCalls: string[] = []
  let n = 0
  let clock = 0
  const opts: SpawnGuardOpts = {
    liveCount: overrides.liveCount ?? (() => 0),
    prompt: overrides.prompt ?? ((p) => { prompts.push(p); return true }),
    now: overrides.now ?? (() => clock),
    newToken: overrides.newToken ?? (() => `tok${++n}`),
    schedule:
      overrides.schedule ??
      ((fn, ms) => {
        const call: SchedCall = { fn, ms, cancelled: false }
        scheduled.push(call)
        return () => {
          call.cancelled = true
        }
      }),
    ttlMs: overrides.ttlMs,
    waitMs: overrides.waitMs,
    max: overrides.max,
    cooldownMs: overrides.cooldownMs,
  }
  const guard = createSpawnGuard(opts)
  // The default spawn a test hands to `request`: records the path, never fails.
  const spawn = async (path: string) => {
    spawnCalls.push(path)
  }
  return {
    guard,
    scheduled,
    prompts,
    spawnCalls,
    advance: (ms: number) => {
      clock += ms
    },
    fireTtl: () => scheduled[0]?.fn(),
  }
}

const needsToken = (d: SpawnDecision): string => {
  if (d.kind !== 'needsConfirm') throw new Error(`expected needsConfirm, got ${d.kind}`)
  return d.token
}

/** The refusal text, or a description of what came back instead — so a decision
 *  of the wrong KIND fails on the message rather than on `undefined`. */
const refusal = (d: SpawnDecision): string =>
  d.kind === 'refused' ? d.reason : `NOT REFUSED: ${d.kind}`

/** Let every already-settled promise in the guard run. `await Promise.resolve()`
 *  is one microtask; redeem() sits behind a Promise.race and then a claim, which
 *  is several. */
const flush = () => new Promise<void>((r) => setImmediate(r))

describe('spawnguard token lifecycle', () => {
  it('a fresh token authorises exactly one spawn', async () => {
    const { guard, spawnCalls } = harness()
    const ask = await guard.request('C:\\repo', undefined, () => Promise.reject(new Error('unused')))
    const token = needsToken(ask)
    guard.answer(token, true)
    const spawn = async (p: string) => { spawnCalls.push(p) }
    const result = await guard.request('C:\\repo', token, spawn)
    expect(result).toEqual({ kind: 'spawned' })
    expect(spawnCalls).toEqual(['C:\\repo'])
  })

  it('a reused token is refused, and does not spawn a second time', async () => {
    const { guard, spawnCalls } = harness()
    const spawn = async (p: string) => { spawnCalls.push(p) }
    const ask = await guard.request('C:\\repo', undefined, spawn)
    const token = needsToken(ask)
    guard.answer(token, true)
    const first = await guard.request('C:\\repo', token, spawn)
    expect(first.kind).toBe('spawned')

    // Same token, same path, called again — the retry a timed-out control op
    // would trigger.
    const second = await guard.request('C:\\repo', token, spawn)
    expect(second.kind).toBe('refused')
    expect(spawnCalls).toEqual(['C:\\repo']) // still exactly one spawn, not two
  })

  it('a token minted for one path is refused when redeemed for a different path, and is NOT consumed', async () => {
    const { guard, spawnCalls } = harness()
    const spawn = async (p: string) => { spawnCalls.push(p) }
    const ask = await guard.request('C:\\repo-a', undefined, spawn)
    const token = needsToken(ask)

    const wrongPath = await guard.request('C:\\repo-b', token, spawn)
    expect(wrongPath.kind).toBe('refused')
    expect(spawnCalls).toEqual([])

    // The user's real approval (for repo-a) must still be usable — a
    // wrong-path attempt must not have burned it.
    guard.answer(token, true)
    const rightPath = await guard.request('C:\\repo-a', token, spawn)
    expect(rightPath.kind).toBe('spawned')
    expect(spawnCalls).toEqual(['C:\\repo-a'])
  })

  it('an unknown token is refused without ever calling spawn, even while a real one is pending', async () => {
    const { guard, spawnCalls } = harness()
    const spawn = async (p: string) => { spawnCalls.push(p) }
    const ask = await guard.request('C:\\repo', undefined, spawn) // mints a real, live token
    const token = needsToken(ask)
    const bogus = token + 'x' // a caller (or a hostile one) making one up

    const result = await guard.request('C:\\repo', bogus, spawn)
    expect(result.kind).toBe('refused')
    expect(spawnCalls).toEqual([])

    // The bogus attempt must not have disturbed the real pending confirmation.
    guard.answer(token, true)
    const real = await guard.request('C:\\repo', token, spawn)
    expect(real.kind).toBe('spawned')
    expect(spawnCalls).toEqual(['C:\\repo'])
  })

  // THE HEADLINE SAFETY PROPERTY, and the one every other test above misses
  // because every one of them hands redeem a spawn that RESOLVES.
  //
  // control() rejects with a ControlError on `timeout`, and a timed-out
  // openClaudeSession MAY ALREADY HAVE STARTED — the op is at-least-once and
  // cannot be recalled. The tool description tells the model to call again. So
  // the token has to be dead whether the spawn succeeded, failed, or is
  // unknowable, which is why the claim sits ABOVE `await spawn` and not in the
  // finally next to `inFlight--`. Move it down and this is the only assertion
  // in the tree that notices.
  it('a spawn that REJECTS still consumes the token, so the documented retry cannot start a second session', async () => {
    const { guard } = harness()
    let calls = 0
    const spawnThatRejects = async () => {
      calls++
      throw new Error('control timeout')
    }
    const ask = await guard.request('C:\\repo', undefined, spawnThatRejects)
    const token = needsToken(ask)
    guard.answer(token, true)

    // The rejection propagates unchanged, so mcp.ts can map the ControlError.
    await expect(guard.request('C:\\repo', token, spawnThatRejects)).rejects.toThrow('control timeout')
    expect(calls).toBe(1)

    // "If that call returns needsConfirm again, call again with the same token"
    // — exactly what the model was told to do after a timeout. Asserted before
    // the state below, so the failure reads as the outcome that matters.
    // `.catch`, so a retry that DID spawn is reported as the second spawn below
    // rather than pre-empting the assertion with that spawn's own rejection.
    const retry = await guard.request('C:\\repo', token, spawnThatRejects).catch(() => null)
    expect(calls).toBe(1) // NOT two Claude Code processes on one folder
    expect(retry?.kind).toBe('refused')
    expect(refusal(retry!)).toMatch(/unknown, already used, or expired/i)
    expect(guard.pending).toBeNull() // nothing left alive to redeem
    expect(guard.inFlight).toBe(0) // and the slot was released on the way out
  })

  // The claim's OTHER half, and the one the test above cannot see. Its comment
  // promises the block is "synchronous from here to `pending = null`, so two
  // redemptions that woke on the same answer cannot both win" — nothing asserted
  // that. It matters because the realistic way finding 1 gets re-broken is not
  // moving the claim past the spawn, it is TIDYING IT INTO THE `finally` next to
  // `inFlight--`: that still consumes the token on a rejecting spawn, so the
  // test above stays green, while `pending` now survives across `await
  // spawn(path)` and a second redemption of the same token walks straight
  // through the claim. Two Claude Code processes on one folder, one approval.
  it('two redemptions woken by the SAME answer spawn exactly once', async () => {
    const { guard, spawnCalls } = harness()
    const spawn = async (p: string) => { spawnCalls.push(p) }
    const token = needsToken(await guard.request('C:\\repo', undefined, spawn))

    // Both in flight BEFORE the answer, so one settle wakes both — two MCP
    // requests are two HTTP requests and nothing serialises them.
    const a = guard.request('C:\\repo', token, spawn)
    const b = guard.request('C:\\repo', token, spawn)
    guard.answer(token, true)
    const [ra, rb] = await Promise.all([a, b])

    expect(spawnCalls).toEqual(['C:\\repo']) // ONE session, not two
    expect([ra.kind, rb.kind].sort()).toEqual(['refused', 'spawned'])
    expect(refusal(ra.kind === 'refused' ? ra : rb)).toMatch(/already used/i)
    expect(guard.inFlight).toBe(0)
  })

  it('mints nothing when there is no window to prompt in', async () => {
    // prompt() returning false means the send never reached a renderer. A token
    // minted anyway is a live permission nobody can answer and only expiry can
    // clear — and the cap slot it would consume is gone for two minutes.
    const { guard, spawnCalls } = harness({ prompt: () => false })
    const spawn = async (p: string) => { spawnCalls.push(p) }
    const r = await guard.request('C:\\repo', undefined, spawn)
    expect(r.kind).toBe('refused')
    expect(refusal(r)).toMatch(/no window/i)
    expect(guard.pending).toBeNull()
    expect(spawnCalls).toEqual([])
  })

  it('holds exactly one outstanding confirmation, and the second ask does not displace the first', async () => {
    // ONE record and one timer by construction. Without this the agent queues
    // prompts: N live permissions, N modals, and the user answering the one in
    // front of them approves whichever the guard happens to be holding.
    const { guard, prompts } = harness()
    const spawn = async () => {}
    const first = needsToken(await guard.request('C:\\a', undefined, spawn))
    const second = await guard.request('C:\\b', undefined, spawn)
    expect(second.kind).toBe('refused')
    expect(refusal(second)).toMatch(/already asking/i)
    expect(prompts.map((p) => p.path)).toEqual(['C:\\a']) // one modal, for one folder
    expect(guard.pending?.token).toBe(first)
  })

  it('answer() ignores a token that is not the outstanding one', async () => {
    // The renderer is not trusted to send back the token main is holding: a
    // forged or echoed spawn:confirm-answer, or a renderer bug replaying a stale
    // one, must not settle whatever confirmation happens to be up.
    const { guard, scheduled, spawnCalls } = harness({ waitMs: 1_000 })
    const spawn = async (p: string) => { spawnCalls.push(p) }
    const token = needsToken(await guard.request('C:\\repo', undefined, spawn))

    guard.answer(token + 'x', true)
    guard.answer('', true)
    guard.answer('a'.repeat(64), true)

    const redeemed = guard.request('C:\\repo', token, spawn)
    scheduled[1].fn() // the redemption's wait timer; the TTL is left alone
    const r = await redeemed
    expect(r.kind).toBe('needsConfirm') // still waiting on a REAL human
    expect(spawnCalls).toEqual([])
    expect(guard.pending?.token).toBe(token)
  })
})

describe('spawnguard cap', () => {
  it('refuses the 9th concurrent session, and recovers the moment one exits', async () => {
    // liveCount is driven by hand, the way PtyManager.agentSessions() is
    // driven by the real handle map: it goes up only once request() actually
    // spawns, and the test decrements it to model a pty exiting.
    let live = 0
    const { guard } = harness({ liveCount: () => live, max: 8 })
    const spawnThatCounts = async () => {
      live++
    }

    for (let i = 0; i < 8; i++) {
      const ask = await guard.request(`C:\\r${i}`, undefined, spawnThatCounts)
      const token = needsToken(ask)
      guard.answer(token, true)
      const result = await guard.request(`C:\\r${i}`, token, spawnThatCounts)
      expect(result.kind).toBe('spawned')
    }
    expect(live).toBe(8)

    // 9th: refused at the mint step, before a human is ever asked.
    const ninthAsk = await guard.request('C:\\r8', undefined, spawnThatCounts)
    expect(ninthAsk.kind).toBe('refused')
    expect(live).toBe(8) // the cap refusal never called spawn

    // One session exits — the cap must fall with it, not stay pinned at 8.
    live--
    const recovered = await guard.request('C:\\r8', undefined, spawnThatCounts)
    expect(recovered.kind).toBe('needsConfirm')
  })

  it('does not prompt the user for a request the cap can never satisfy', async () => {
    const { guard, prompts } = harness({ liveCount: () => 8, max: 8 })
    const result = await guard.request('C:\\repo', undefined, async () => {})
    expect(result.kind).toBe('refused')
    expect(prompts).toEqual([]) // no human was asked about a folder that cannot launch
  })

  it('counts a spawn that is still in flight, before its pty exists', async () => {
    // liveCount stays 0 for this whole test ON PURPOSE: this is the window
    // between control() being asked for a session and the pty appearing in the
    // handle map. Without the in-flight term, N redemptions overlapping in that
    // window all read the same pre-spawn total and all pass the cap.
    const { guard } = harness({ liveCount: () => 0, max: 1 })
    let release = () => {}
    const hang = () => new Promise<void>((r) => { release = r })

    const token = needsToken(await guard.request('C:\\a', undefined, hang))
    guard.answer(token, true)
    const spawning = guard.request('C:\\a', token, hang)
    await flush()
    expect(guard.inFlight).toBe(1)

    const second = await guard.request('C:\\b', undefined, hang)
    expect(second.kind).toBe('refused')
    expect(refusal(second)).toMatch(/at most 1 Claude sessions/i)

    // And it is a window, not a leak: the term goes away when the spawn returns.
    release()
    expect(await spawning).toEqual({ kind: 'spawned' })
    expect(guard.inFlight).toBe(0)
    expect((await guard.request('C:\\b', undefined, hang)).kind).toBe('needsConfirm')
  })

  it('re-checks the cap after the human answers, not only before they were asked', async () => {
    // The world moves while a human thinks. A token minted under the cap two
    // minutes ago is not evidence there is still room, and the mint-time check
    // is the only other one.
    let live = 0
    const { guard, spawnCalls } = harness({ liveCount: () => live, max: 1 })
    const spawn = async (p: string) => { spawnCalls.push(p) }
    const token = needsToken(await guard.request('C:\\a', undefined, spawn))
    guard.answer(token, true)
    live = 1 // the user started one themselves, or another redemption landed

    const r = await guard.request('C:\\a', token, spawn)
    expect(r.kind).toBe('refused')
    expect(refusal(r)).toMatch(/at most 1 Claude sessions/i)
    expect(spawnCalls).toEqual([])
  })
})

// KAN-41 follow-up (finding 3). Denying used to free the slot with no backoff,
// so a loop of open_claude_session redrew the modal ~28 times a second: measured
// 12 modals in 428 ms. .modal-backdrop is position:fixed; inset:0; z-index:100,
// so the app is unusable and an Allow button is flashing under the cursor. Not a
// bypass — nothing spawns — but the realistic end of it is a mis-click.
describe('spawnguard deny cooldown', () => {
  it('a Deny silences the next ask, tells the model how long, and then wears off', async () => {
    const { guard, prompts, advance } = harness({ cooldownMs: 10_000 })
    const spawn = async () => {}
    const token = needsToken(await guard.request('C:\\a', undefined, spawn))
    guard.answer(token, false)

    const immediate = await guard.request('C:\\a', undefined, spawn)
    expect(immediate.kind).toBe('refused')
    // A typed refusal the agent can read and act on, not silence — and it names
    // the wait, so a model that is not attacking knows to pause rather than spin.
    expect(refusal(immediate)).toMatch(/denied the last request/i)
    expect(refusal(immediate)).toMatch(/\b10s\b/)

    // Global, not per-path: an agent supplies the folder, so a per-path cooldown
    // is walked around by naming a sibling directory.
    const elsewhere = await guard.request('C:\\b', undefined, spawn)
    expect(elsewhere.kind).toBe('refused')
    expect(prompts.length).toBe(1) // exactly one modal has ever been shown

    advance(9_999)
    expect((await guard.request('C:\\a', undefined, spawn)).kind).toBe('refused')

    // AND IT EXPIRES. A cooldown with no expiry is a new bug: one denial would
    // disable the tool for the rest of the app run, and the user's cure would be
    // restarting the app.
    advance(1)
    const after = await guard.request('C:\\a', undefined, spawn)
    expect(after.kind).toBe('needsConfirm')
    expect(prompts.length).toBe(2)
  })

  it('an unanswered expiry does not arm the cooldown', async () => {
    // Only a refusal is a refusal. A TTL that fired already cost the caller two
    // minutes, and treating silence as a Deny would let a single ignored prompt
    // block the tool for a user who simply walked away and came back.
    const { guard, fireTtl } = harness({ ttlMs: 120_000, cooldownMs: 10_000 })
    const spawn = async () => {}
    await guard.request('C:\\a', undefined, spawn)
    fireTtl()
    expect((await guard.request('C:\\a', undefined, spawn)).kind).toBe('needsConfirm')
  })
})

describe('spawnguard expiry', () => {
  it('a token nobody answered before the TTL fires is refused, and the slot is freed', async () => {
    const { guard, fireTtl, spawnCalls } = harness({ ttlMs: 120_000 })
    const spawn = async (p: string) => { spawnCalls.push(p) }
    const ask = await guard.request('C:\\repo', undefined, spawn)
    const token = needsToken(ask)

    const redeemed = guard.request('C:\\repo', token, spawn) // awaits the answer
    fireTtl() // the TTL timer, not a real answer
    const result = await redeemed
    expect(result.kind).toBe('refused')
    expect(spawnCalls).toEqual([])
    expect(guard.pending).toBeNull() // slot freed, not held for the rest of the TTL

    // The freed slot immediately accepts a fresh ask.
    const again = await guard.request('C:\\repo', undefined, spawn)
    expect(again.kind).toBe('needsConfirm')
  })

  it('a redemption still unanswered after waitMs gets the SAME needsConfirm payload back, not a throw', async () => {
    const { guard, scheduled } = harness({ waitMs: 1_000 })
    const spawn = async () => {}
    const ask = await guard.request('C:\\repo', undefined, spawn)
    const token = needsToken(ask)

    const redeemed = guard.request('C:\\repo', token, spawn)
    // scheduled[0] is the mint's TTL timer; scheduled[1] is redeem's wait
    // timer — fire the wait timer only, leaving the TTL (and the pending
    // record) alone.
    scheduled[1].fn()
    const result = await redeemed
    expect(result).toEqual({ kind: 'needsConfirm', token, path: 'C:\\repo', expiresAt: expect.any(Number) })
    expect(guard.pending?.token).toBe(token) // still redeemable — nothing was consumed
  })
})
