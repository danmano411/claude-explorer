/**
 * The one guard every window-level shortcut in the renderer asks before acting.
 *
 * `true` when the keystroke landed in something that owns its own keys and must
 * receive them unmodified: a terminal (xterm's focus sink is a
 * `.xterm-helper-textarea`), the NavBar address bar, the search overlay's box,
 * and the tab / group / space rename inputs — all of which are plain `<input>`s.
 *
 * Extracted from FileBrowser's keydown handler (which had it inline as `typing`)
 * so there is ONE predicate rather than two that drift. Deliberately tag-based
 * and not a `.terminal`/`.address` closest() walk: every one of those surfaces
 * is a real form control already, and a list of class names is a list to forget
 * to update.
 *
 * KAN-59: this used to gate App's Ctrl+1..9 space switch too, which is exactly
 * why that shortcut was dead whenever a terminal had focus — the terminal is the
 * one caller that must NOT be lumped in with the rest. That switch now asks
 * `isTextBox` instead. FileBrowser's Backspace / Delete / F2 / Ctrl+A row still
 * asks this one, because those ARE keys a focused text field owns.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const tag = (target as HTMLElement | null)?.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA'
}

/**
 * The app's own text boxes — the address bar, the search box, the tab / group /
 * space rename inputs — and NOT a terminal, whose focus sink is a `<textarea>`.
 *
 * The difference from `isTypingTarget` is deliberate and is the whole reason
 * there are two predicates: that one answers "does this surface own the key?",
 * to which a terminal says yes; this one answers "is this one of OUR fields?",
 * to which a terminal says no. So a shortcut the app is entitled to take even
 * over a terminal asks this one, and there are now two:
 *
 *  - Ctrl+Shift+G, the grid picker. Ctrl+Shift+<letter> is not a distinct
 *    control code — xterm sends the same ^G for Ctrl+G and Ctrl+Shift+G — which
 *    is precisely why every terminal emulator (Windows Terminal, VS Code, GNOME
 *    Terminal) reserves that row for the app.
 *  - Ctrl+1..9, the space switcher (KAN-59). Those DO have control codes and we
 *    take them anyway; `spaceIndex` and Terminal.tsx carry that argument.
 *
 * Either way the app's own inputs still decline, because a keystroke that
 * relocates the UI under a rename box the user is mid-edit in is a state nobody
 * asked for.
 */
export function isTextBox(target: EventTarget | null): boolean {
  return (target as HTMLElement | null)?.tagName === 'INPUT'
}

/**
 * Which space a Ctrl+1..9 press selects — 0-based — or null for every other
 * keystroke. Modifier-exact: Ctrl only, so Ctrl+Shift+3 and Alt+3 are not ours.
 *
 * ONE predicate because TWO listeners have to agree on it (KAN-59). App.tsx's
 * window handler does the switching; Terminal.tsx's
 * `attachCustomKeyEventHandler` stops xterm putting the corresponding control
 * byte on the wire for the same press. Split them into two hand-written tests
 * and the failure is silent and asymmetric: a terminal that eats a digit the app
 * never acts on, or a space switch that also sends ESC/FS/GS/RS/US/DEL to the
 * pty on its way out.
 *
 * Answers only "which space is this press asking for" — WHERE the press landed
 * is not its business, and the two callers want different answers to that.
 * Terminal.tsx suppresses unconditionally (if it is running, the press is in a
 * terminal); App.tsx additionally declines for `isTextBox`. Folding the target
 * check in here would therefore have to fold in the disagreement too.
 */
export function spaceIndex(e: KeyboardEvent): number | null {
  if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return null
  const n = Number(e.key)
  return Number.isInteger(n) && n >= 1 && n <= 9 ? n - 1 : null
}
