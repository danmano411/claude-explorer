import { randomUUID } from 'node:crypto'
import type { ControlOp, ControlReply, ControlRequest, ControlResult } from '../shared/types'

/**
 * KAN-39 request/reply correlation for the main -> renderer control channel.
 *
 * Pure: no electron import, no ambient clock. `send` and the timer are handed
 * in, so correlation / timeout / cleanup are testable without a BrowserWindow.
 * The electron half is control.handlers.ts and stays six lines wide.
 *
 * What this does NOT know: what any op means. WHAT an op does is the
 * renderer's one switch statement — this file must never grow a second one.
 */

/**
 * `no-window`   the window is gone (or went away between check and send)
 * `timeout`     nobody replied in time — usually the renderer is reloading.
 *               DO NOT AUTO-RETRY A MUTATING OP ON THIS. A request still
 *               QUEUED in the renderer when the timeout fired is guaranteed
 *               dead (it carries a `deadline` the renderer checks before
 *               starting it), but one already EXECUTING is not cancellable —
 *               a Claude Code halfway up cannot be un-spawned. So `timeout`
 *               means "may or may not have happened": re-`listTabs`, which is
 *               idempotent, and decide from that. Full note on `ControlOp`.
 * `renderer`    the renderer replied `{ ok: false }`: unknown op, unknown tab
 *               id, a request that expired before it reached the front of the
 *               queue, or a throw it caught. `message` is the renderer's text.
 *
 * A code rather than string-matching a message, because KAN-40 has to map
 * these onto MCP errors and "the window is closed" is a different answer to a
 * caller than "you named a tab that does not exist".
 */
export type ControlErrorCode = 'no-window' | 'timeout' | 'renderer'

export class ControlError extends Error {
  constructor(readonly code: ControlErrorCode, message: string) {
    super(message)
    this.name = 'ControlError'
  }
}

/** The renderer may be mid-reload, in which case nothing will ever reply.
 *  Generous because openClaudeSession spawns Claude Code, which is the slowest
 *  thing this app does. */
export const CONTROL_TIMEOUT_MS = 15000

/** A scheduled timeout, cancelled by calling it. One injectable instead of a
 *  set/clear pair — a fake is then `(fn) => { fired = fn; return cancel }`. */
export type Cancel = () => void

export interface ControlChannelOpts {
  /** Deliver one request. Throwing is a legitimate answer (no window); the
   *  request is settled with it immediately instead of waiting out the timeout. */
  send: (req: ControlRequest) => void
  timeoutMs?: number
  newId?: () => string
  schedule?: (fn: () => void, ms: number) => Cancel
}

export interface ControlChannel {
  /** Resolves with the renderer's result, or REJECTS with a ControlError.
   *  Never resolves `null` on failure — "no answer" must stay distinguishable
   *  from "the op returned nothing", which is what the three mutating ops do. */
  request: (op: ControlOp) => Promise<ControlResult>
  /** Feed in one `control:reply`. Total: a reply for an id that is not in
   *  flight is dropped, never thrown, because the IPC listener calling this has
   *  nobody to catch for it. */
  settle: (reply: ControlReply | undefined) => void
  /** Pending count. Exists for the leak assertion — a settled request must
   *  leave nothing behind on either path. */
  readonly inFlight: number
}

type Pending = {
  resolve: (r: ControlResult) => void
  reject: (e: ControlError) => void
  cancel: Cancel
}

const defaultSchedule = (fn: () => void, ms: number): Cancel => {
  const t = setTimeout(fn, ms)
  return () => clearTimeout(t)
}

/**
 * ponytail: one flat map keyed by request id, no per-window scoping — this app
 * is single-window (single-instance lock in index.ts). Key by webContents id
 * if a second window ever exists.
 */
export function createControlChannel(opts: ControlChannelOpts): ControlChannel {
  const timeoutMs = opts.timeoutMs ?? CONTROL_TIMEOUT_MS
  const newId = opts.newId ?? randomUUID
  const schedule = opts.schedule ?? defaultSchedule
  const pending = new Map<string, Pending>()

  /** Claim an id: whoever gets the entry owns settling it, and the timer is
   *  cancelled here so every exit path clears it exactly once. */
  const take = (id: string): Pending | null => {
    const p = pending.get(id)
    if (!p) return null
    pending.delete(id)
    p.cancel()
    return p
  }

  return {
    request: (op) =>
      new Promise<ControlResult>((resolve, reject) => {
        const id = newId()
        const cancel = schedule(() => {
          pending.delete(id)
          reject(new ControlError('timeout', `control: ${op.op} timed out`))
        }, timeoutMs)
        // Registered BEFORE the send: a reply that comes back in the same tick
        // (a synchronous fake, or a renderer that answers instantly) would
        // otherwise find nothing to match and be dropped as stale.
        pending.set(id, { resolve, reject, cancel })
        try {
          // Same instant the timer above is armed for, so the renderer can
          // refuse a request this side has already given up on instead of
          // running it for nobody — and, if the caller retried, twice.
          opts.send({ ...op, id, deadline: Date.now() + timeoutMs } as ControlRequest)
        } catch (e) {
          take(id)?.reject(
            e instanceof ControlError ? e : new ControlError('no-window', `control: ${String(e)}`),
          )
        }
      }),

    settle: (reply) => {
      if (!reply || typeof reply.id !== 'string') return
      const p = take(reply.id)
      if (!p) return // duplicate, or already timed out: exactly one reply wins
      if (reply.ok) p.resolve(reply.result)
      else p.reject(new ControlError('renderer', reply.error || 'control: renderer error'))
    },

    get inFlight() {
      return pending.size
    },
  }
}
