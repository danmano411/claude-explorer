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
