/**
 * The one guard every window-level shortcut in the renderer asks before acting.
 *
 * `true` when the keystroke landed in something that owns its own keys and must
 * receive them unmodified: a terminal (xterm's focus sink is a
 * `.xterm-helper-textarea`, so Ctrl+1 reaches the shell instead of switching
 * spaces), the NavBar address bar, the search overlay's box, and the tab / group
 * / space rename inputs — all of which are plain `<input>`s.
 *
 * Extracted from FileBrowser's keydown handler (which had it inline as `typing`)
 * when App gained Ctrl+1..9 for spaces, so there is ONE predicate rather than
 * two that drift. Deliberately tag-based and not a `.terminal`/`.address`
 * closest() walk: every one of those surfaces is a real form control already,
 * and a list of class names is a list to forget to update.
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
 * there are two predicates: that one answers "may I take a plain Ctrl+<key>?",
 * to which a terminal says no; this one answers "may I take a Ctrl+Shift
 * chord?", to which a terminal says yes. Ctrl+Shift+<letter> is not a distinct
 * control code — xterm sends the same ^G for Ctrl+G and Ctrl+Shift+G — which is
 * precisely why every terminal emulator (Windows Terminal, VS Code, GNOME
 * Terminal) reserves that row for the app. See App.tsx's grid-picker keybind.
 */
export function isTextBox(target: EventTarget | null): boolean {
  return (target as HTMLElement | null)?.tagName === 'INPUT'
}
