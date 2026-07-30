/**
 * Pure helpers for FileMenu, split out so they're unit-testable without a React
 * test runner (this repo has none) — same shape as spacemenu.ts, which FileMenu
 * also borrows `nextFocusIndex` from rather than growing a second copy.
 */
import type { ClaudeSession } from '../shared/types'

/**
 * ponytail: a project's session flyout shows at most 20 conversations. The
 * ceiling is the flyout, not the data — `sessions:list` returns every jsonl in
 * the folder, and a long-lived repo has hundreds. Twenty is roughly a screen;
 * past that a menu is the wrong control. If anyone needs the 300th session,
 * give Open Recent a search field rather than raising this number.
 */
export const SESSION_CAP = 20

/**
 * Newest-first, capped. `listSessions` (src/main/sessions.ts) already sorts,
 * so this is belt-and-braces — but the order is the whole point of the list
 * and re-sorting a ≤20-row array costs nothing, whereas silently rendering an
 * unsorted list if that contract ever changes costs a bug report.
 */
export function topSessions(list: ClaudeSession[], cap = SESSION_CAP): ClaudeSession[] {
  return [...list].sort((a, b) => b.updated - a.updated).slice(0, cap)
}

/**
 * Compact relative time for a menu row: "just now", "9m ago", "2h ago",
 * "yesterday", "3d ago", then a plain date.
 *
 * Hand-rolled rather than Intl.RelativeTimeFormat: that produces "2 hours ago"
 * / "3 days ago", which is twice the width in a column that has to share a row
 * with an ellipsized session title.
 */
export function relTime(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d === 1) return 'yesterday'
  if (d < 7) return `${d}d ago`
  return new Date(ms).toLocaleDateString()
}
