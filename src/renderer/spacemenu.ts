/**
 * Pure helpers for SpaceMenu, split out so they're unit-testable without a
 * React test runner (this repo has none). Root-level like tabreorder.ts /
 * gridlayout.ts / groups.ts — not colocated with the component, which only
 * resolved before by TS/Vite trying `.ts` ahead of `.tsx`.
 */

/**
 * "Ctrl+1".."Ctrl+9" for the first nine UNPINNED items, "Ctrl+Shift+1"..
 * "Ctrl+Shift+9" for the first nine PINNED ones (KAN-82); null past the ninth
 * of either run — there is no tenth accelerator, the menu just lists the space
 * with none.
 *
 * `index` is GROUP-RELATIVE, not the row's absolute position in the dropdown:
 * the 1st pinned space and the 1st unpinned space both pass `0`, distinguished
 * only by `pinned`. Callers get that index for free from `spaces.orderSpaces`
 * — pinned spaces sort to the front, so a pinned row's position IS its
 * group-relative index, and an unpinned row's is its position minus however
 * many pinned rows precede it.
 */
export function acceleratorLabel(index: number, pinned?: boolean): string | null {
  if (index < 0 || index >= 9) return null
  return pinned ? `Ctrl+Shift+${index + 1}` : `Ctrl+${index + 1}`
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
