/**
 * Pure helpers for SpaceMenu, split out so they're unit-testable without a
 * React test runner (this repo has none). Root-level like tabreorder.ts /
 * gridlayout.ts / groups.ts — not colocated with the component, which only
 * resolved before by TS/Vite trying `.ts` ahead of `.tsx`.
 */

/** "Ctrl+1".."Ctrl+9" for the first nine items (index 0-8); null past that —
 *  there is no tenth accelerator, the menu just lists the space with none. */
export function acceleratorLabel(index: number): string | null {
  return index >= 0 && index < 9 ? `Ctrl+${index + 1}` : null
}

/** Delete is refused when it's the only space left — the UI must not offer,
 *  nor act on, what will be refused. Checked both at the menu-item gate and
 *  again in the confirm modal's Delete handler. */
export function canDeleteSpace(spaceCount: number): boolean {
  return spaceCount > 1
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
