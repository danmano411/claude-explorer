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
    // KAN-64: 0 by default, i.e. ask every time — so every KAN-41 test above
    // keeps measuring the confirmation path it was written for, and the
    // allowance tests below name the number they mean.
    allowance: overrides.allowance ?? (() => 0),
    reap: overrides.reap,
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

// KAN-64. The number stopped being a cap and became a FREE ALLOWANCE: below it
// nothing is asked, at it the user is asked, and an approval always lands. The
// describe it replaces asserted the opposite in three places ("refuses the
// 9th", "does not prompt for a request the cap can never satisfy", "re-checks
// the cap after the human answers") — those were the leash Dan called too
// tight, and their removal is the ticket, not collateral.
describe('spawnguard free allowance', () => {
  it('spawns silently below the allowance — no prompt, no token, no dialog', async () => {
    let live = 0
    const { guard, prompts, spawnCalls } = harness({ liveCount: () => live, allowance: () => 8 })
    const spawnThatCounts = async (p: string) => { spawnCalls.push(p); live++ }

    for (let i = 0; i < 8; i++) {
      const r = await guard.request(`C:\\r${i}`, undefined, spawnThatCounts)
      expect(r).toEqual({ kind: 'spawned' })
    }
    expect(live).toBe(8)
    expect(prompts).toEqual([]) // the whole point: the user was never interrupted
    expect(guard.pending).toBeNull() // and nothing minted a permission to hold
  })

  it('asks AT the allowance, and an approval opens the 9th — and the 10th', async () => {
    let live = 8
    const { guard, prompts, spawnCalls } = harness({ liveCount: () => live, allowance: () => 8 })
    const spawnThatCounts = async (p: string) => { spawnCalls.push(p); live++ }

    // At 8 of 8 the tool asks rather than refusing, and the folder it asks
    // about is the one that was requested.
    const ask = await guard.request('C:\\r8', undefined, spawnThatCounts)
    const token = needsToken(ask)
    expect(prompts.map((p) => p.path)).toEqual(['C:\\r8'])
    expect(spawnCalls).toEqual([]) // nothing started while the user was thinking

    guard.answer(token, true)
    expect(await guard.request('C:\\r8', token, spawnThatCounts)).toEqual({ kind: 'spawned' })
    expect(live).toBe(9) // PAST the number, which the old cap made unreachable

    // ...and again, from over the line. "It throttles, it never blocks": there
    // is no count at which the tool stops working.
    const ask2 = await guard.request('C:\\r9', undefined, spawnThatCounts)
    const token2 = needsToken(ask2)
    guard.answer(token2, true)
    expect(await guard.request('C:\\r9', token2, spawnThatCounts)).toEqual({ kind: 'spawned' })
    expect(live).toBe(10)
    expect(spawnCalls).toEqual(['C:\\r8', 'C:\\r9'])
  })

  it('never re-checks the count after the human said yes', async () => {
    // The removed hard refusal, asserted as an absence. The old guard
    // re-checked at the claim and refused an approval the user had just given
    // because the world had moved while they read the dialog.
    let live = 0
    const { guard, spawnCalls } = harness({ liveCount: () => live, allowance: () => 1 })
    const spawn = async (p: string) => { spawnCalls.push(p) }
    live = 1 // at the allowance, so this one has to be asked about
    const token = needsToken(await guard.request('C:\\a', undefined, spawn))
    live = 99 // the user opened a dozen themselves while the dialog was up

    guard.answer(token, true)
    expect(await guard.request('C:\\a', token, spawn)).toEqual({ kind: 'spawned' })
    expect(spawnCalls).toEqual(['C:\\a'])
  })

  it('with the allowance at 0, every single call asks — KAN-41 behaviour, unchanged', async () => {
    const { guard, prompts, spawnCalls } = harness({ liveCount: () => 0, allowance: () => 0 })
    const spawn = async (p: string) => { spawnCalls.push(p) }
    for (let i = 0; i < 3; i++) {
      const token = needsToken(await guard.request(`C:\\r${i}`, undefined, spawn))
      expect(spawnCalls.length).toBe(i) // nothing spawned by the ASK itself
      guard.answer(token, true)
      expect(await guard.request(`C:\\r${i}`, token, spawn)).toEqual({ kind: 'spawned' })
    }
    expect(prompts.length).toBe(3) // three sessions, three human answers
  })

  it('counts a spawn that is still in flight, before its pty exists', async () => {
    // liveCount stays 0 for this whole test ON PURPOSE: this is the window
    // between control() being asked for a session and the pty appearing in the
    // handle map. Without the in-flight term, N requests overlapping in that
    // window all read the same pre-spawn total and all spawn FREELY — the
    // allowance is not a cap any more, but it is still the thing that decides
    // whether a human is involved, and losing count of an in-flight spawn is
    // how an agent gets N sessions for one allowance of 1.
    const { guard, prompts } = harness({ liveCount: () => 0, allowance: () => 1 })
    let release = () => {}
    const hang = () => new Promise<void>((r) => { release = r })

    const spawning = guard.request('C:\\a', undefined, hang) // free: 0 of 1
    await flush()
    expect(guard.inFlight).toBe(1)

    const second = await guard.request('C:\\b', undefined, hang)
    expect(second.kind).toBe('needsConfirm') // asked, not silently spawned
    expect(prompts.map((p) => p.path)).toEqual(['C:\\b'])

    // And it is a window, not a leak: the term goes away when the spawn returns.
    release()
    expect(await spawning).toEqual({ kind: 'spawned' })
    expect(guard.inFlight).toBe(0)
  })

  it('a Deny still silences the next ask even when the allowance has room', async () => {
    // The cooldown outranks the free path. Otherwise a user's refusal is walked
    // around by one tab closing: the very next call would spawn SILENTLY,
    // giving the agent by default what it was just told it could not have.
    let live = 8
    const { guard, spawnCalls, advance } = harness({
      liveCount: () => live, allowance: () => 8, cooldownMs: 10_000,
    })
    const spawn = async (p: string) => { spawnCalls.push(p) }
    const token = needsToken(await guard.request('C:\\a', undefined, spawn)) // at 8 of 8: asked
    guard.answer(token, false)

    live = 0 // a tab closed: there is now room for eight free spawns
    const denied = await guard.request('C:\\a', undefined, spawn)
    expect(denied.kind).toBe('refused')
    expect(refusal(denied)).toMatch(/denied the last request/i)
    expect(spawnCalls).toEqual([]) // and nothing started behind the refusal

    // The control, and the reason this is not merely asserting a constant: the
    // same guard with the same room spawns freely once the cooldown wears off.
    advance(10_000)
    expect(await guard.request('C:\\a', undefined, spawn)).toEqual({ kind: 'spawned' })
    expect(spawnCalls).toEqual(['C:\\a'])
  })
})

// KAN-64's reap. Every case here is about WHICH tabs may be closed and WHEN —
// the risk the ticket calls "the whole risk", because a dead tab and a dormant
// restored one both have no live process and only one of them is disposable.
// This file owns the WHEN (the guard never reaps unless a spawn needs the
// room); mcp.ts owns the WHICH, and the harness owns proving it on real tabs.
describe('spawnguard reap', () => {
  it('is not called at all while there is room', async () => {
    let reaps = 0
    const { guard, spawnCalls } = harness({
      liveCount: () => 3,
      allowance: () => 8,
      reap: async () => { reaps++; return 0 },
    })
    const r = await guard.request('C:\\a', undefined, async (p) => { spawnCalls.push(p) })
    expect(r).toEqual({ kind: 'spawned' })
    expect(reaps).toBe(0) // nothing disappears while the user is merely using the app
  })

  it('runs when a spawn would cross the allowance, and a freed slot means no prompt', async () => {
    let reaps = 0
    const { guard, prompts, spawnCalls } = harness({
      liveCount: () => 8,
      allowance: () => 8,
      // Two dead tabs closed: the snapshot had 8 agent tabs, 6 are left.
      reap: async () => { reaps++; return 6 },
    })
    const r = await guard.request('C:\\a', undefined, async (p) => { spawnCalls.push(p) })
    expect(reaps).toBe(1)
    expect(r).toEqual({ kind: 'spawned' })
    expect(prompts).toEqual([]) // the user was never asked — the room was already theirs
    expect(spawnCalls).toEqual(['C:\\a'])
  })

  it('prompts, not refuses, when the reap frees nothing', async () => {
    const { guard, prompts, spawnCalls } = harness({
      liveCount: () => 8,
      allowance: () => 8,
      reap: async () => 8, // every agent tab is alive or dormant; none was closed
    })
    const r = await guard.request('C:\\a', undefined, async (p) => { spawnCalls.push(p) })
    expect(r.kind).toBe('needsConfirm')
    expect(prompts.length).toBe(1)
    expect(spawnCalls).toEqual([])
  })

  it('treats a reap that could not tell (no window, a timeout) as no room freed', async () => {
    const { guard, prompts } = harness({
      liveCount: () => 8, allowance: () => 8, reap: async () => null,
    })
    const r = await guard.request('C:\\a', undefined, async () => {})
    expect(r.kind).toBe('needsConfirm')
    expect(prompts.length).toBe(1)
  })

  it('reads the room from the reap\'s own snapshot, not a re-poll of liveCount', async () => {
    // liveCount is Math.max(live, persisted), and the persisted half reads
    // stale-high until the renderer's immediate-persist lands. If the guard
    // re-polled it after the reap, the slot the reap had just freed would be
    // invisible and the user would be asked about a session that fits.
    const { guard, prompts } = harness({
      liveCount: () => 8, // never moves, exactly like a stale persisted count
      allowance: () => 8,
      reap: async () => 7,
    })
    expect(await guard.request('C:\\a', undefined, async () => {})).toEqual({ kind: 'spawned' })
    expect(prompts).toEqual([])
  })

  it('does not reap at an allowance of 0 — no count there can ever make room', async () => {
    let reaps = 0
    const { guard } = harness({
      liveCount: () => 0, allowance: () => 0, reap: async () => { reaps++; return 0 },
    })
    expect((await guard.request('C:\\a', undefined, async () => {})).kind).toBe('needsConfirm')
    expect(reaps).toBe(0) // closing tabs to make room that cannot exist is pure loss
  })

  it('two requests that reap concurrently still leave exactly one prompt up', async () => {
    // The reap introduced an `await` between the pending check and the mint. If
    // the guard does not re-check after it, two calls that both crossed the
    // allowance both mint — the second clobbers the first's pending record, the
    // user sees two dialogs, and answering one settles a token nothing holds.
    let release = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const { guard, prompts } = harness({
      liveCount: () => 8,
      allowance: () => 8,
      reap: async () => { await gate; return 8 },
    })
    const a = guard.request('C:\\a', undefined, async () => {})
    const b = guard.request('C:\\b', undefined, async () => {})
    release()
    const [ra, rb] = await Promise.all([a, b])

    expect(prompts.length).toBe(1) // ONE dialog for ONE outstanding confirmation
    expect([ra.kind, rb.kind].sort()).toEqual(['needsConfirm', 'refused'])
    expect(refusal(ra.kind === 'refused' ? ra : rb)).toMatch(/already asking/i)
    expect(guard.pending?.path).toBe(prompts[0].path) // the record IS the dialog on screen
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
