/**
 * Pure helpers for SpaceMenu, split out so they're unit-testable without a
 * React test runner (this repo has none).
 */

/** "Ctrl+1".."Ctrl+9" for the first nine items (index 0-8); null past that —
 *  there is no tenth accelerator, the menu just lists the space with none. */
export function acceleratorLabel(index: number): string | null {
  return index >= 0 && index < 9 ? `Ctrl+${index + 1}` : null
}

/** Delete is refused (by the logic layer) when it's the only space left —
 *  the UI must not offer what will be refused. */
export function canDeleteSpace(spaceCount: number): boolean {
  return spaceCount > 1
}
