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
