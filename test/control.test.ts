// KAN-39 — pending-map / correlation core for the main -> renderer control
// channel, tested as a pure module (no electron import anywhere in this file).
//
// Every path here is exercised two ways depending on what it needs:
//  - the "timeout elapses for real" path uses vitest fake timers over the
//    module's DEFAULT schedule (setTimeout/clearTimeout), because that is the
//    path production actually runs (control.handlers.ts never overrides
//    `schedule`).
//  - "was the timer cancelled" is asserted with an INJECTED schedule fake
//    (the module's own DI seam) instead of spying on global clearTimeout,
//    because that is a direct, unambiguous signal rather than an inference.
//
// CLAUDE.md rule: an assertion only earns its place if it fails against the
// unmodified build. Every assertion below was proven red by mutating
// src/main/control.ts, then restored — see the report accompanying this file.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createControlChannel, ControlError, CONTROL_TIMEOUT_MS } from '../src/main/control'
import type { ControlChannelOpts } from '../src/main/control'
import type { ControlReply, ControlRequest } from '../src/shared/types'

type SchedCall = { fn: () => void; ms: number; cancelled: boolean }

function harness(overrides: { send?: ControlChannelOpts['send']; realSchedule?: boolean } = {}) {
  const sent: ControlRequest[] = []
  const scheduled: SchedCall[] = []
  let n = 0
  const opts: ControlChannelOpts = {
    send: overrides.send ?? ((r) => sent.push(r)),
    newId: () => `id${++n}`,
  }
  if (!overrides.realSchedule) {
    // Injected schedule: `cancelled` flips true iff the returned Cancel ran.
    opts.schedule = (fn, ms) => {
      const call: SchedCall = { fn, ms, cancelled: false }
      scheduled.push(call)
      return () => {
        call.cancelled = true
      }
    }
  }
  return { ch: createControlChannel(opts), sent, scheduled }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('control channel correlation core', () => {
  it('does not cross two interleaved replies', async () => {
    const { ch, sent } = harness()
    const a = ch.request({ op: 'listTabs' })
    const b = ch.request({ op: 'closeTab', args: { tabId: 't1' } })
    expect(sent.map((s) => s.id)).toEqual(['id1', 'id2'])
    // Settle out of order: id2 (the second request) answers first.
    ch.settle({ id: 'id2', ok: true, result: null })
    ch.settle({ id: 'id1', ok: true, result: [{ id: 't1', view: 'files', cwd: 'C:\\', title: 'C' }] })
    await expect(b).resolves.toBe(null)
    await expect(a).resolves.toEqual([{ id: 't1', view: 'files', cwd: 'C:\\', title: 'C' }])
    expect(ch.inFlight).toBe(0)
  })

  it('ignores a reply for an unknown id without throwing, and leaves the real request pending', async () => {
    const { ch } = harness()
    const p = ch.request({ op: 'listTabs' })
    expect(() => ch.settle({ id: 'not-a-real-id', ok: true, result: [] })).not.toThrow()
    // The unknown-id reply must not have been mistaken for id1's answer.
    expect(ch.inFlight).toBe(1)
    ch.settle({ id: 'id1', ok: true, result: [] })
    await expect(p).resolves.toEqual([])
  })

  it('ignores a duplicate reply for an already-settled id without throwing', async () => {
    const { ch } = harness()
    const p = ch.request({ op: 'listTabs' })
    ch.settle({ id: 'id1', ok: true, result: [] })
    expect(ch.inFlight).toBe(0)
    // A second reply for the same id (even one that disagrees, ok:false) must
    // be a silent no-op, not a throw out of the ipcMain.on listener.
    expect(() => ch.settle({ id: 'id1', ok: false, error: 'late' })).not.toThrow()
    expect(ch.inFlight).toBe(0)
    await expect(p).resolves.toEqual([])
  })

  it('rejects immediately with a no-window ControlError when send throws, leaking nothing', async () => {
    const { ch } = harness({ send: () => { throw new Error('boom') } })
    const p = ch.request({ op: 'listTabs' })
    await expect(p).rejects.toBeInstanceOf(ControlError)
    await expect(p).rejects.toMatchObject({ code: 'no-window' })
    expect(ch.inFlight).toBe(0)
  })

  it('rejects with a timeout when nothing replies, and a later reply is dropped (not resurrected, not a double-settle)', async () => {
    const { ch } = harness({ realSchedule: true }) // exercise the real setTimeout/clearTimeout path
    const p = ch.request({ op: 'openClaudeSession', args: { cwd: 'C:\\x' } })
    const assertion = expect(p).rejects.toMatchObject({
      code: 'timeout',
      message: 'control: openClaudeSession timed out',
    })
    await vi.advanceTimersByTimeAsync(CONTROL_TIMEOUT_MS)
    await assertion
    // The map must be clean the instant the timeout fires, not only once a
    // (possibly never-arriving) late reply happens to show up.
    expect(ch.inFlight).toBe(0)
    expect(() => ch.settle({ id: 'id1', ok: true, result: null })).not.toThrow()
    expect(ch.inFlight).toBe(0)
  })

  it('cancels the timer on the resolve path', async () => {
    const { ch, scheduled } = harness()
    const p = ch.request({ op: 'listTabs' })
    ch.settle({ id: 'id1', ok: true, result: [] })
    await p
    expect(scheduled[0].cancelled).toBe(true)
    expect(ch.inFlight).toBe(0)
  })

  it('cancels the timer on the renderer-error path and surfaces a typed rejection', async () => {
    const { ch, scheduled } = harness()
    const p = ch.request({ op: 'closeTab', args: { tabId: 'ghost' } })
    ch.settle({ id: 'id1', ok: false, error: 'control: unknown tab ghost' })
    await expect(p).rejects.toMatchObject({ code: 'renderer', message: 'control: unknown tab ghost' })
    expect(scheduled[0].cancelled).toBe(true)
    expect(ch.inFlight).toBe(0)
  })

  it('drops a malformed reply instead of throwing out of the ipcMain listener', async () => {
    // `channel.settle(reply)` IS the body of ipcMain.on('control:reply'), which
    // has nobody to catch for it: a throw there is an unhandled main-process
    // error, and the renderer is the one thing sending on that channel — a
    // reload mid-send, or KAN-40's future second sender, is all it takes.
    const { ch } = harness()
    const p = ch.request({ op: 'listTabs' })
    expect(() => ch.settle(undefined)).not.toThrow()
    expect(() => ch.settle(null as unknown as ControlReply)).not.toThrow()
    expect(() => ch.settle({} as ControlReply)).not.toThrow() // no id at all
    // …and the real request is untouched by any of them.
    expect(ch.inFlight).toBe(1)
    ch.settle({ id: 'id1', ok: true, result: [] })
    await expect(p).resolves.toEqual([])
  })

  it('stamps every request with the instant main gives up on it', async () => {
    // The renderer refuses to START a request past its `deadline` (App.tsx
    // runControl), which is the only thing stopping a request that sat in the
    // queue through the timeout from running for nobody — and, if the caller
    // retried, twice. An unstamped request silently never expires:
    // `Date.now() > undefined` is false, forever. So the field must be there
    // and must be the same instant the timer above is armed for.
    const { ch, sent } = harness()
    const p = ch.request({ op: 'openClaudeSession', args: { cwd: 'C:\\x' } })
    expect(sent[0].deadline).toBe(Date.now() + CONTROL_TIMEOUT_MS) // fake timers: frozen clock
    ch.settle({ id: 'id1', ok: true, result: null })
    await expect(p).resolves.toBe(null)
  })

  it('surfaces unknown-op and unknown-tab renderer replies as typed renderer-coded errors, verbatim', async () => {
    const { ch } = harness()
    const opReq = ch.request({ op: 'listTabs' }) // id1 — the op name is irrelevant to correlation
    const tabReq = ch.request({ op: 'closeTab', args: { tabId: 'ghost' } }) // id2
    ch.settle({ id: 'id1', ok: false, error: 'control: unknown op bogus' })
    ch.settle({ id: 'id2', ok: false, error: 'control: unknown tab ghost' })
    await expect(opReq).rejects.toMatchObject({ code: 'renderer', message: 'control: unknown op bogus' })
    await expect(tabReq).rejects.toMatchObject({ code: 'renderer', message: 'control: unknown tab ghost' })
  })
})
