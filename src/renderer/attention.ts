/**
 * KAN-78. Pure decision for the desktop/taskbar unread indicator: does the
 * OS-level call (Windows `setOverlayIcon`/`flashFrame`, macOS
 * `setBadgeCount`/`dock.bounce` — src/main/badge.ts) need to be ON right now?
 *
 * Root-level like spacemenu.ts / gridlayout.ts, not colocated with a
 * component, for the same reason: unit-testable without a React test runner
 * (this repo has none), and this is exactly the kind of logic KAN-78's own
 * ticket warns about — "an assertion that merely proves setOverlayIcon was
 * called passes whether or not the logic deciding WHEN is correct."
 */

import type { ClaudeState } from '../shared/types'

/**
 * Same "blocked" definition TabBar.tsx's `.needs-input` class and
 * spacemenu.ts's `spaceNeedsInput` already use: only `'awaiting-input'`
 * counts. `'idle'` is deliberately excluded even though it can read like
 * "needs input" in English — it means the turn ended and Claude is ready for
 * your NEXT message, not that anyone is blocked on you — and the ticket is
 * explicit that idle must never flash the taskbar. `'working'` and
 * `'stopped'` were never in question.
 *
 * `focused` is the app window's OS focus and `visiblePtyId` is the ptyId of
 * the tab currently on screen (App.tsx's `active`, resolved to a ptyId). A
 * blocked session stops counting only when BOTH hold — the window has focus
 * AND that exact tab is the one showing ("you are already looking at it").
 * When the window does not have focus at all, EVERY blocked session counts,
 * regardless of which tab happens to be nominally active — switching tabs
 * while alt-tabbed away must not silently clear the indicator.
 *
 * ponytail: `visiblePtyId` is a single id, not the set of panes split view
 * (KAN-56) can show at once (each `GridCell.activeTabId`). A blocked session
 * sitting in a second, non-focused pane still counts as "needs attention"
 * even though it is technically on screen too. Widen to a
 * `ReadonlySet<string>` if split-view users report the false-positive badge.
 */
export function attentionNeeded(
  states: ReadonlyMap<string, ClaudeState>,
  focused: boolean,
  visiblePtyId: string | null,
): boolean {
  for (const [ptyId, state] of states) {
    if (state !== 'awaiting-input') continue
    if (focused && ptyId === visiblePtyId) continue
    return true
  }
  return false
}
