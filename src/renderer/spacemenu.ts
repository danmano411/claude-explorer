/**
 * Pure helpers for SpaceMenu, split out so they're unit-testable without a
 * React test runner (this repo has none). Root-level like tabreorder.ts /
 * gridlayout.ts / groups.ts — not colocated with the component, which only
 * resolved before by TS/Vite trying `.ts` ahead of `.tsx`.
 */

import type { ClaudeState } from '../shared/types'
import { formatMods, type Mods } from './keys'

/** The minimal shape `spaceNeedsInput` needs — the `Closeable` precedent in
 *  closeguard.ts. `Tab` (renderer/tabs.ts) satisfies it structurally. */
export type ClaudeMember = { terminalKind?: 'claude' | 'shell'; ptyId?: string }

/**
 * KAN-76. Does ANY tab in this space have a Claude session genuinely blocked
 * on the user right now? Pure and meant to be called AT RENDER, never stored —
 * see the module doc on `useClaudeState` (renderer/claudestate.ts): a second
 * place that remembers "this space needs attention" is a second thing that can
 * disagree with the state signal itself, and disagreeing is exactly the bug
 * the marker must never reproduce (it has to clear the instant the session
 * leaves `awaiting-input`, with nobody visiting the tab to notice).
 *
 * Keyed off `claudeState`, never `PtyStatus`: a shell tab is never "blocked
 * awaiting input" in the sense this feature means (there is no permission
 * dialog for a plain shell), and a Claude tab with no ptyId yet (restored,
 * never activated) or no entry yet (no hooks — see claudestate.ts) has
 * nothing to report either, which `.get(undefined)` / `.get(ptyId) ===
 * 'awaiting-input'` both already refuse without a special case.
 */
export function spaceNeedsInput(
  members: readonly ClaudeMember[],
  claudeState: ReadonlyMap<string, ClaudeState>,
): boolean {
  return members.some(
    (t) => t.terminalKind === 'claude' && t.ptyId !== undefined && claudeState.get(t.ptyId) === 'awaiting-input',
  )
}

/**
 * "Ctrl+1".."Ctrl+9" for the first nine UNPINNED items, "Ctrl+Shift+1"..
 * "Ctrl+Shift+9" for the first nine PINNED ones (KAN-82) BY DEFAULT; null past
 * the ninth of either run — there is no tenth accelerator, the menu just
 * lists the space with none.
 *
 * KAN-95: formats from the caller's `mods` — the RESOLVED binding
 * (`resolveSpaceKeybinds`'s output in keys.ts: `keybinds.switchUnpinned` or
 * `.switchPinned`, whichever the row's `pinned` picks) — via the shared
 * `formatMods`, rather than emitting a hardcoded "Ctrl"/"Ctrl+Shift"
 * constant. So a rebind (KAN-83) is reflected here with no restart, and
 * there is exactly one place ("+", the digit, and `formatMods`) that spells
 * a chord — `formatMods` is also KAN-91's seam for platform symbols, so this
 * function never has to change for that.
 *
 * `index` is GROUP-RELATIVE, not the row's absolute position in the dropdown:
 * the 1st pinned space and the 1st unpinned space both pass `0`, distinguished
 * only by which `mods` the caller passes. Callers get that index for free
 * from `spaces.orderSpaces` — pinned spaces sort to the front, so a pinned
 * row's position IS its group-relative index, and an unpinned row's is its
 * position minus however many pinned rows precede it.
 */
export function acceleratorLabel(index: number, mods: Mods): string | null {
  if (index < 0 || index >= 9) return null
  return `${formatMods(mods)}+${index + 1}`
}

/**
 * Delete is refused when it's the only space left (the structural floor), and
 * — KAN-57 — when the space is PINNED (the user's explicit instruction). The UI
 * must not offer, nor act on, what `deleteSpace` will refuse: checked at the
 * menu-item gate and again in the confirm modal's Delete handler, since either
 * can change while the modal is open.
 *
 * `pinned` is optional so the one-arg call shape still means "count only".
 */
export function canDeleteSpace(spaceCount: number, pinned?: boolean): boolean {
  return spaceCount > 1 && !pinned
}

/**
 * Next item index for ArrowDown/ArrowUp inside the menu list. `current: -1`
 * means nothing in the list is focused yet (focus is still on the trigger
 * button, a sibling of the list) — ArrowDown should land on the first item,
 * ArrowUp on the last, not fall through to the wrap-around math which is
 * off by one for ArrowUp when there is no "current" to subtract from.
 */
export function nextFocusIndex(current: number, key: 'ArrowDown' | 'ArrowUp', count: number): number {
  if (count === 0) return -1
  if (current === -1) return key === 'ArrowDown' ? 0 : count - 1
  return key === 'ArrowDown' ? (current + 1) % count : (current - 1 + count) % count
}
