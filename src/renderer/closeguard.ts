/**
 * WHAT IS ACTUALLY UNRECOVERABLE ABOUT CLOSING A TAB (KAN-57).
 *
 * Pure, no React and no IPC — the `spacemenu.ts` / `groups.ts` precedent — so
 * the rule can be tested without a renderer and so there is exactly one copy of
 * it behind the tab close, the group close and the space delete.
 *
 * THE SELECTIVITY RULE. Confirming every close trains people to click through
 * the confirm, which is worse than having none: the one time it matters, the
 * dialog has already been made invisible by habit. So a close is only ever
 * questioned when something dies with it that nothing on disk can bring back:
 *
 *   Claude, mid-turn        → the live turn dies and the xterm scrollback is
 *   (working/awaiting-input)  not serialised anywhere (Terminal.tsx disposes
 *                             the instance)
 *   Claude, idle/stopped    → nothing; the transcript is on disk and Open
 *                             Recent reopens the conversation
 *   shell                   → nothing about a shell is written anywhere, ever
 *   files / viewer          → nothing to kill
 *
 * Closing the last tab of a PANE also destroys that pane's rectangle (KAN-56).
 * Deliberately not a risk: a rectangle is one drag to recreate, no process and
 * no buffer go with it, and prompting about layout is exactly the click-through
 * training above. Nothing here mentions panes, and neither does the copy.
 *
 * KAN-75. "Claude, idle" used to read as "running or waiting" — the only
 * signal this file had was pty bytes (ptystatus.ts), and silence at an idle
 * prompt is indistinguishable from silence mid-turn on bytes alone. Claude
 * Code's own hook-reported state (claudestate.ts) can tell them apart, so idle
 * now joins stopped in the "nothing" row above. Scrollback is still lost
 * either way, on purpose: the transcript is the recoverable artifact, and
 * confirming a close to protect a RENDERING of it is exactly the click-through
 * training this file exists to avoid.
 */

import type { ClaudeState, PtyStatus, TabView } from '../shared/types'

export type CloseRisk = 'none' | 'claude' | 'shell'

/** The minimal tab shape this module needs (the `Grouped` precedent). `Tab`
 *  satisfies it structurally. */
export type Closeable = {
  view: TabView
  terminalKind?: 'claude' | 'shell'
  ptyId?: string
  pinned?: boolean
}

/**
 * `status` is keyed by ptyId, NOT by tab id, and `usePtyStatus` only ever
 * writes an entry once that pty has spoken — so the three states are decided on
 * the PRESENCE of a ptyId, never on a default:
 *
 *  - no ptyId at all (a restored terminal that has never been activated, the
 *    single most common close right after a restart): no process exists yet, so
 *    there is nothing to kill. This is why TabBar's `status.get(t.ptyId!) ??
 *    'running'` must not be reused here — that default is an optimistic dot,
 *    and applied to a tab with no pty it would nag on every restored tab.
 *  - ptyId present, no map entry: the process exists and has not said anything
 *    yet. A pty that exists is alive; only `exit` says otherwise.
 *  - 'stopped': `pty:exit` has fired. The process is already gone.
 *
 * `claudeState` (KAN-73/75) answers a narrower question, ONLY for a Claude pty
 * `status` has not already called stopped: is the session sitting idle at the
 * prompt? Same absence rule as `status` — a ptyId missing from the map is
 * UNKNOWN, never an optimistic default — which is exactly what covers every
 * session with no hook state: an `agentSpawned` worker gets none by deliberate
 * security decision, nor does a session this app did not launch, nor one
 * spawned under `agentControl: false`. Those degrade to today's behaviour
 * (unknown -> 'claude', the pre-KAN-75 default) rather than going silent.
 * Only an explicit 'idle' clears the risk; 'working' and 'awaiting-input' both
 * still mean a turn is in flight, and 'stopped' never arrives on this channel
 * at all (see claudestate.ts) — that arm is handled above, off `status`.
 */
export function closeRisk(
  t: Closeable,
  status: ReadonlyMap<string, PtyStatus>,
  claudeState: ReadonlyMap<string, ClaudeState> = new Map(),
): CloseRisk {
  if (t.view !== 'terminal' || !t.ptyId) return 'none'
  if (status.get(t.ptyId) === 'stopped') return 'none'
  if (t.terminalKind === 'shell') return 'shell'
  return claudeState.get(t.ptyId) === 'idle' ? 'none' : 'claude'
}

/** "2 have a running Claude session and 1 is a live terminal" — the live tabs
 *  only, which is what makes a mixed batch name a count the user can act on
 *  rather than just the size of the selection. Empty when nothing is live. */
const phraseOf = (risks: readonly CloseRisk[]): string => {
  const c = risks.filter((r) => r === 'claude').length
  const s = risks.filter((r) => r === 'shell').length
  const parts: string[] = []
  if (c) parts.push(`${c} ${c === 1 ? 'has' : 'have'} a running Claude session`)
  if (s) parts.push(`${s} ${s === 1 ? 'is a live terminal' : 'are live terminals'}`)
  return parts.join(' and ')
}

/**
 * The confirm sentence for closing this batch, or **null when nothing is at
 * risk** — and null means the caller must not prompt AT ALL, not that it should
 * prompt with a blank message. Every safe close stays what it is today: one
 * click, no modal.
 */
export function closeReason(risks: readonly CloseRisk[]): string | null {
  const live = risks.filter((r) => r !== 'none')
  if (!live.length) return null
  if (risks.length === 1)
    return live[0] === 'claude'
      ? 'This Claude session is still running. Closing the tab kills the current turn, and the scrollback is not saved.'
      : 'This terminal is still running. Closing the tab ends it, and nothing about this shell is saved anywhere.'
  return `Close ${risks.length} tabs? ${phraseOf(risks)} — that work is not saved anywhere.`
}

/**
 * MOVING A TAB TO ANOTHER SPACE (KAN-66), or **null when the move needs no
 * dialog at all** — the same contract as `closeReason`, and here for the same
 * selectivity rule stated at the top of this file.
 *
 * Exactly one move is questioned, and it is not questioned because it is
 * destructive — nothing dies, the pty keeps running and the scrollback is
 * untouched — but because it silently changes something the user did not ask
 * for: a grouped tab moving ON ITS OWN leaves its group. It has to, since a
 * group is one contiguous run inside ONE strip and a group straddling two
 * spaces would draw as two runs of the same folder, with rename/recolor/
 * ungroup acting on both at once (the cross-space split TabBar's "Add to …"
 * filter already refuses).
 *
 * Everything else moves silently: an ungrouped tab, a pinned tab (a pin governs
 * closing and ordering, not which space a tab lives in), and a WHOLE group —
 * which keeps its members together and so loses nothing at all. Confirming
 * those too would train the click-through that makes the one dialog that
 * matters invisible.
 */
export function moveTabReason(grouped: boolean): string | null {
  return grouped
    ? 'This tab will be removed from the current group and will be moved to that space.'
    : null
}

/**
 * The space-delete sentence. Byte-identical to the pre-KAN-57 wording when
 * nothing in the space is live and nothing in it is pinned, so the common case
 * reads unchanged; the live clause is the part that was missing, and it is the
 * unrecoverable part.
 *
 * THE PINNED CLAUSE (KAN-57 review). Deleting a space closes its pinned tabs —
 * `onDeleteSpace` closes the whole membership and does not route through
 * `requestClose`'s pinned filter. That behaviour is deliberate: a space delete is
 * explicit and already confirmed, and a space you do not want deleted can itself
 * be pinned. What is NOT acceptable is doing it silently, when the same pin
 * refuses every other close route in the app — so the sentence says so, and the
 * user's pin means what the dialog says it means rather than what a comment
 * elsewhere claims.
 */
export function deleteSpaceReason(
  name: string, tabCount: number, risks: readonly CloseRisk[], pinnedCount: number,
): string {
  const base = `Delete «${name}» and close its ${tabCount} tab${tabCount === 1 ? '' : 's'}?`
  const p = phraseOf(risks)
  const clauses = [
    ...(p ? [`${p}, and that work is not saved anywhere.`] : []),
    ...(pinnedCount > 0
      ? [`${pinnedCount} ${pinnedCount === 1 ? 'is pinned' : 'are pinned'} — deleting the space closes ${pinnedCount === 1 ? 'it' : 'them'} anyway.`]
      : []),
  ]
  return clauses.length ? `${base} ${clauses.join(' ')}` : base
}
