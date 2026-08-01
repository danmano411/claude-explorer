import type { ClaudeState, Settings } from '../shared/types'
import { enteredAwaitingInput } from './notify'

/**
 * KAN-80. Pure decision logic for "auto-switch to the session that needs
 * input" — everything here is framework-free and DOM-free by construction
 * (same discipline as notify.ts/attention.ts: this repo has no React test
 * runner, so the whole point is that these are testable with plain values).
 * App.tsx is the only caller and owns every DOM/IPC lookup (`document.
 * activeElement`, `document.hasFocus()`, `settingsGet()`) — nothing here
 * reads any of that itself.
 */

/** How long after the last keystroke a text box or terminal still counts as
 *  "actively being typed into" (suppression rule #1). A bare focus check
 *  isn't enough: a terminal can sit focused for hours doing nothing, and
 *  suppressing auto-switch for the ENTIRE time some pane merely has focus
 *  would make the feature nearly inert in exactly the case it's for — a
 *  Claude tab left open and blocked while the user works in a different one. */
export const TYPING_SUPPRESS_MS = 1500

/**
 * Suppression rule #1, isolated from the DOM so it's provable with plain
 * numbers — same shape as notify.ts's `chimeAllowed`: `now` is a parameter,
 * never a captured `Date.now()`, so the window boundary itself is testable.
 * `onTypingSurface` is "is a text box or terminal focused RIGHT NOW" — the
 * caller answers that with `keys.ts`'s existing `isTypingTarget`, the same
 * predicate that already means "a terminal's hidden textarea counts too".
 */
export function isTypingActive(
  onTypingSurface: boolean,
  lastInputAt: number,
  now: number,
  windowMs = TYPING_SUPPRESS_MS,
): boolean {
  return onTypingSurface && now - lastInputAt < windowMs
}

/**
 * What `shouldAutoSwitch` needs to know about "where the user is right now".
 * Deliberately not React state or a DOM read — the caller derives both
 * fields from things it already tracks (a keydown timestamp ref, the
 * `claudeState` map keyed by the active tab's ptyId).
 */
export interface AutoSwitchFocus {
  /** Suppression rule #1: see `isTypingActive`. */
  typingActive: boolean
  /** ClaudeState of the tab currently on screen, or undefined when it isn't
   *  a Claude tab (or is one claudestate.ts has no report for yet). */
  activeState: ClaudeState | undefined
}

/**
 * The whole KAN-80 decision, as one pure predicate: does THIS transition
 * warrant bringing its tab into view? Composes `enteredAwaitingInput`
 * (notify.ts) rather than re-deriving the edge — the identical transition
 * KAN-77's chime and KAN-79's toast already fire on.
 *
 * Three suppression rules, each a single early return:
 *
 *  - **the setting is off** → never. Acceptance #1 ("default off; existing
 *    users see no behaviour change on upgrade") falls straight out of this:
 *    `Settings.autoSwitchOnInput` already defaults `false` (KAN-77/settings.ts),
 *    so an untouched install always takes this branch.
 *  - **the user is actively typing** (a text box or terminal, focused, with a
 *    keystroke inside the last `TYPING_SUPPRESS_MS`) → never. A view change
 *    mid-keystroke sends the rest of a sentence into a different session's
 *    prompt, which is worse than any missed notification.
 *  - **the tab currently on screen is ITSELF `awaiting-input`** → never.
 *    Moving the user off a prompt they are mid-answer to is a data-loss-shaped
 *    bug even though nothing is written to disk.
 *
 * That last rule is also what makes "several sessions blocking in sequence"
 * switch AT MOST ONCE with no separate "already switched" flag to maintain:
 * the first switch lands the user on a tab that is (by definition — it just
 * entered `awaiting-input`) still blocked, so this same check refuses every
 * later candidate until the user actually leaves that tab — by answering it
 * (its state stops being `awaiting-input`) or by navigating away on their
 * own. The one place that invariant needs help from the caller is a BATCH of
 * several transitions processed in one synchronous pass, before React has
 * re-rendered to reflect an earlier switch from later in the SAME batch —
 * see App.tsx's integration comment, which threads a local
 * `effectiveActiveState` through that loop for exactly this reason.
 */
export function shouldAutoSwitch(
  state: { prev: ClaudeState | undefined; next: ClaudeState },
  settings: Pick<Settings, 'autoSwitchOnInput'>,
  focus: AutoSwitchFocus,
): boolean {
  if (!settings.autoSwitchOnInput) return false
  if (!enteredAwaitingInput(state.prev, state.next)) return false
  if (focus.typingActive) return false
  if (focus.activeState === 'awaiting-input') return false
  return true
}
