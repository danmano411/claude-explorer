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
 *   Claude, running/waiting → the live turn dies and the xterm scrollback is
 *                             not serialised anywhere (Terminal.tsx disposes
 *                             the instance)
 *   Claude, stopped         → nothing; the transcript is on disk and Open
 *                             Recent reopens the conversation
 *   shell                   → nothing about a shell is written anywhere, ever
 *   files / viewer          → nothing to kill
 *
 * Closing the last tab of a PANE also destroys that pane's rectangle (KAN-56).
 * Deliberately not a risk: a rectangle is one drag to recreate, no process and
 * no buffer go with it, and prompting about layout is exactly the click-through
 * training above. Nothing here mentions panes, and neither does the copy.
 */

import type { PtyStatus, TabView } from '../shared/types'

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
 */
export function closeRisk(t: Closeable, status: ReadonlyMap<string, PtyStatus>): CloseRisk {
  if (t.view !== 'terminal' || !t.ptyId) return 'none'
  if (status.get(t.ptyId) === 'stopped') return 'none'
  return t.terminalKind === 'shell' ? 'shell' : 'claude'
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
