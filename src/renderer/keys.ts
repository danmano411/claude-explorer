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
 * A binding's modifier requirement, exact in both directions: every modifier
 * named `true` must be down, and — just as load-bearing — every modifier left
 * out must be UP. `spaceIndex` used to re-derive this by hand
 * (`!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey`) and every new predicate
 * was one more chance to get the negation wrong or forget a modifier entirely.
 *
 * This is also the primitive KAN-83 (customizable keybinds) and KAN-91 (Cmd on
 * macOS) build on: a binding becomes DATA — this shape — instead of a
 * hand-written boolean chain, which is what makes both of those additive
 * rather than a rewrite. `meta` is carried today even though nothing yet binds
 * it, precisely so KAN-91 has somewhere to put Cmd without touching this type.
 */
export interface Mods {
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
  meta?: boolean
}

/** Every modifier `mods` doesn't name must be up, not merely "don't care" —
 *  that asymmetry is the whole reason a shared helper exists at all. */
function modsMatch(e: KeyboardEvent, mods: Mods): boolean {
  return (
    e.ctrlKey === !!mods.ctrl &&
    e.shiftKey === !!mods.shift &&
    e.altKey === !!mods.alt &&
    e.metaKey === !!mods.meta
  )
}

/**
 * Which space a Ctrl+1..9 press selects — 0-based — or null for every other
 * keystroke. Modifier-exact: Ctrl only, so Ctrl+Shift+3 and Alt+3 are not ours
 * (KAN-82 gives Ctrl+Shift+1..9 to `pinnedSpaceIndex` instead — a DIFFERENT
 * group of spaces, not a wider match here).
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
 *
 * The RESULT is the digit's index among the app's own array (`spaces`), but
 * which spaces that array means is App's call, not this function's — since
 * KAN-82 that pool is the UNPINNED spaces, group-relative, matching
 * `acceleratorLabel`'s "Ctrl+1" labels.
 */
export function spaceIndex(e: KeyboardEvent): number | null {
  if (!modsMatch(e, { ctrl: true })) return null
  const n = Number(e.key)
  return Number.isInteger(n) && n >= 1 && n <= 9 ? n - 1 : null
}

/**
 * Which PINNED space a Ctrl+Shift+1..9 press selects — 0-based, group-relative
 * to the pinned run only (KAN-82) — or null for every other keystroke.
 *
 * Reads `e.code` (`Digit1`..`Digit9`), NOT `e.key` like `spaceIndex` does:
 * Shift changes what the key reports — `Ctrl+Shift+1` is `e.key === '!'`, not
 * `'1'` — so `spaceIndex`'s `Number(e.key)` cannot be reused here no matter how
 * the modifier check changes. `code` names the physical key regardless of
 * what Shift did to its printed character.
 *
 * Same two-halves obligation as `spaceIndex` (KAN-59, KAN-82): App.tsx's
 * window handler switches on it, and Terminal.tsx's
 * `attachCustomKeyEventHandler` suppresses the identical press so xterm cannot
 * act on it either — see that file for why xterm was never going to send a
 * byte for this one anyway, and why the suppression is still there.
 */
export function pinnedSpaceIndex(e: KeyboardEvent): number | null {
  if (!modsMatch(e, { ctrl: true, shift: true })) return null
  const m = /^Digit([1-9])$/.exec(e.code)
  return m ? Number(m[1]) - 1 : null
}

/**
 * Ctrl+Tab / Ctrl+Shift+Tab — step to the next/previous space in DISPLAY order
 * (`spaces.orderSpaces`: pinned run, then unpinned), wrapping at both ends
 * (KAN-82). `1` forward, `-1` backward, `null` for every other keystroke.
 *
 * Two-halves like the predicates above, with one difference a caller must not
 * miss: Tab's browser default is a focus move, and unlike a ctrl-digit there
 * genuinely IS something to cancel. `spaceIndex`/`pinnedSpaceIndex` name no
 * default because none exists for a ctrl-modified digit; whichever handler
 * acts on a non-null result from THIS function must call `preventDefault()`
 * itself. See Terminal.tsx's arm for the measurement against xterm's own
 * Tab handling that makes this non-optional.
 */
export function spaceCycle(e: KeyboardEvent): 1 | -1 | null {
  if (e.key !== 'Tab') return null
  if (modsMatch(e, { ctrl: true })) return 1
  if (modsMatch(e, { ctrl: true, shift: true })) return -1
  return null
}
