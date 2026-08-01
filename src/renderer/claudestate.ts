import { useEffect, useState } from 'react'
import type { ClaudeState } from '../shared/types'

/**
 * KAN-74/KAN-76. The renderer-side consumer of the KAN-73 signal
 * (`CH.claudeState`), deliberately parallel in shape to `ptystatus.ts`'s
 * `applyEvent` / `usePtyStatus`: a pure transition function plus a thin hook,
 * so both the dot (TabBar.tsx) and the cross-space markers (SpaceMenu.tsx via
 * App.tsx) read ONE map instead of each keeping their own — a second
 * subscription to `claude:state` is a second map that can silently drift from
 * the first, which is exactly the kind of bug this ticket exists to remove.
 *
 * THE STRUCTURAL FIX FOR THE DOT BUGS: this hook does NOT listen to
 * `onPtyData`, at all. That is not an oversight — it is the entire reason
 * typing and tab-switching can no longer move the dot. `usePtyStatus` has to
 * watch bytes because `PtyStatus` has no better signal for a shell; a Claude
 * tab now has one, and once a consumer stops reading bytes for it, a
 * keystroke echo and a resize-triggered ConPTY repaint (see TabBar.tsx / the
 * amber-flicker note in claudestate.mjs) both become invisible to it BY
 * CONSTRUCTION, not because either byte source got quieter.
 */

type Event = { id: string; kind: 'state'; state: ClaudeState } | { id: string; kind: 'exit' }

/**
 * Pure transition. Returns the SAME map reference when nothing changes, same
 * discipline as `ptystatus.ts`'s `applyEvent` — state events are far rarer
 * than `pty:data`, but a consumer (TabBar, SpaceMenu) still should not
 * re-render on one that changes nothing.
 *
 * 'stopped' is the terminal state and, like `applyEvent`, latches: once a
 * pty has exited nothing revives it. This is also the ONLY place 'stopped'
 * is ever written to this map — `CH.claudeState` itself never carries it (a
 * dead process cannot POST its own death; see the CH.claudeState comment in
 * ipc.ts), so folding `pty:exit` in here is what makes 'stopped' reachable at
 * all, for every Claude tab including ones that never got a single hook
 * event (agentSpawned workers, `agentControl: false`, `disableAllHooks`).
 * Those tabs sit with NO entry in this map while alive — honest unknown,
 * never a guessed 'working' — and gain 'stopped' the moment they actually
 * exit, from this same fold-in.
 */
export function applyClaudeEvent(prev: Map<string, ClaudeState>, ev: Event): Map<string, ClaudeState> {
  if (prev.get(ev.id) === 'stopped') return prev // terminal state
  const next: ClaudeState = ev.kind === 'exit' ? 'stopped' : ev.state
  if (next === prev.get(ev.id)) return prev
  const m = new Map(prev)
  m.set(ev.id, next)
  return m
}

/**
 * `Map<ptyId, ClaudeState>`. Absence means unknown — see `applyClaudeEvent`
 * and the `ClaudeState` doc comment in shared/types.ts — and there is no
 * default anywhere in this file for the same reason `usePtyStatus` has none:
 * an optimistic guess here is the KAN-74 bug reappearing one file over.
 */
export function useClaudeState(): Map<string, ClaudeState> {
  const [map, setMap] = useState<Map<string, ClaudeState>>(new Map())

  useEffect(() => {
    const offState = window.api.onClaudeState((id, state) =>
      setMap((m) => applyClaudeEvent(m, { id, kind: 'state', state })),
    )
    // The fold-in. Without this arm a finished/killed session sits on its
    // last hook state forever — 'working' or 'awaiting-input' would never
    // leave, which is worse than the byte-based bug this replaces.
    const offExit = window.api.onPtyExit((id) => setMap((m) => applyClaudeEvent(m, { id, kind: 'exit' })))
    return () => {
      offState()
      offExit()
    }
  }, [])

  return map
}
