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
 * rather than a rewrite. `meta` was carried from the start even before
 * anything bound it, precisely so KAN-91 would have somewhere to put Cmd
 * without touching this type — see `primaryMod`/`primaryMods` below, which is
 * that ticket's actual seam.
 *
 * KAN-91's answer for what a STORED `{ ctrl: true }` means on macOS: exactly
 * what it says, the physical Ctrl key, on every platform, never aliased to
 * Cmd. `modsMatch` compares every field exactly as written — there is no
 * platform branch inside it at all — so a settings.json (or workspace.json)
 * carried over from Windows keeps meaning literal Ctrl on a Mac, unchanged.
 * Only the SHIPPED DEFAULT differs by platform (`primaryMods`,
 * `DEFAULT_SPACE_KEYBINDS`): an untouched install gets Cmd on macOS; a
 * binding the user actually typed keeps meaning whatever they pressed.
 */
export interface Mods {
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
  meta?: boolean
}

/**
 * KAN-91. THE primitive this ticket introduces: "is the platform's primary
 * accelerator modifier down" — Cmd on macOS, Ctrl everywhere else. Read fresh
 * on every call (`process.platform` at call time, like main/external.ts's
 * `openExternalTerminal`) rather than cached at module load: there is no
 * per-call cost worth avoiding here, and it means every function below is
 * exercisable in a test with nothing more than the existing
 * `Object.defineProperty(process, 'platform', …)` trick — no `vi.resetModules`
 * dance, unlike `DEFAULT_SPACE_KEYBINDS` below (a real module-level constant,
 * which does need it).
 *
 * Deliberately NOT "ctrl OR meta" anywhere in this module — that is the exact
 * trap the ticket names: it would make Cmd+1 AND Ctrl+1 both switch spaces on
 * a Mac, and Ctrl is a genuinely distinct modifier there that the TERMINAL
 * owns (Ctrl+C, Ctrl+D). Every caller below picks exactly one of the two,
 * decided once, here.
 */
export function isMac(): boolean {
  // MUST be guarded. This file is RENDERER code, and the renderer runs with
  // `contextIsolation: true` / `nodeIntegration: false` — there is no `process`
  // global there at all, so a bare `process.platform` is a ReferenceError, not
  // an undefined read. `DEFAULT_SPACE_KEYBINDS` below calls this at module
  // evaluation time, so that throw happened before React ever mounted and took
  // the ENTIRE APP down: `#root` stayed empty and every harness timed out
  // waiting for `.app`.
  //
  // `npm test` cannot catch this — vitest runs in node, where `process` exists.
  // Only launching the real app does. Same shape, same reason, and the same
  // fallback as `detectWindows()` in shared/pathutil.ts; keep the two in step.
  if (typeof process !== 'undefined' && typeof process.platform === 'string') {
    return process.platform === 'darwin'
  }
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  return /Macintosh|Mac OS X/i.test(ua)
}

/**
 * `e.ctrlKey` on Windows/Linux, `e.metaKey` on macOS — a straight swap-in for
 * every raw `e.ctrlKey` check that used to assume Ctrl was the only
 * accelerator modifier anyone would press. Deliberately as LOOSE as the
 * `e.ctrlKey` checks it replaces (it says nothing about Shift/Alt/whichever-
 * other-modifier being down or up) so swapping it in changes NOTHING about
 * which chords match beyond "which physical key is the accelerator" — no
 * Windows behaviour moves by taking this seam. FileBrowser's copy/cut/paste/
 * undo/redo/select-all/find/new-folder row, Terminal's paste and Ctrl+Enter
 * newline, and GridPicker's move-pane arrow all read this instead of
 * `e.ctrlKey` directly now.
 */
export function primaryMod(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return isMac() ? e.metaKey : e.ctrlKey
}

/**
 * The EXACT-match counterpart to `primaryMod`, for the one caller
 * (App.tsx's Ctrl+Shift+G grid picker) that hand-checks all four modifiers
 * rather than asking one loose boolean — building a `Mods` for `modsMatch`
 * to compare against needs a platform-correct base to add `shift` onto.
 * `{ meta: true, ...extra }` on macOS, `{ ctrl: true, ...extra }` elsewhere.
 *
 * Also what `DEFAULT_SPACE_KEYBINDS` below builds `switchUnpinned`/
 * `switchPinned` from, so "the platform's primary modifier" is spelled in
 * exactly one place for both the loose and the exact callers.
 */
export function primaryMods(extra?: Partial<Mods>): Mods {
  return isMac() ? { meta: true, ...extra } : { ctrl: true, ...extra }
}

/**
 * KAN-95. The text a menu shows for a `Mods` — "Ctrl+Shift" for
 * `{ ctrl: true, shift: true }`, "" for none (never actually emitted: every
 * space action requires at least one modifier). Fixed order (Ctrl, Shift,
 * Alt, Meta) so the same binding never prints two different ways.
 *
 * KAN-91: on macOS this renders Apple's own symbols (⌃⌥⇧⌘) in Apple's own
 * canonical display order (Control, Option, Shift, Command — the order every
 * macOS menu itself uses), rather than the Ctrl/Shift/Alt/Meta text and order
 * Windows/Linux keep unchanged. Still joined with "+": `acceleratorLabel`
 * (spacemenu.ts) appends its digit as `${formatMods(mods)}+${index + 1}`, and
 * that template is the one thing this ticket was told not to have to touch —
 * so "⌘+1" ships instead of the pixel-perfect "⌘1" Apple's own HIG would
 * write. ponytail: a real per-platform accelerator-label template (no "+"
 * before a trailing digit on macOS) is a cosmetic upgrade, not a correctness
 * one; revisit if a Mac user actually notices.
 */
export function formatMods(mods: Mods): string {
  if (isMac()) {
    const parts: string[] = []
    if (mods.ctrl) parts.push('⌃')
    if (mods.alt) parts.push('⌥')
    if (mods.shift) parts.push('⇧')
    if (mods.meta) parts.push('⌘')
    return parts.join('+')
  }
  const parts: string[] = []
  if (mods.ctrl) parts.push('Ctrl')
  if (mods.shift) parts.push('Shift')
  if (mods.alt) parts.push('Alt')
  if (mods.meta) parts.push('Meta')
  return parts.join('+')
}

/** Every modifier `mods` doesn't name must be up, not merely "don't care" —
 *  that asymmetry is the whole reason a shared helper exists at all.
 *
 *  KAN-91: exported (was module-private) so App.tsx's grid-picker shortcut
 *  can match an EXACT chord built from `primaryMods` instead of hand-rolling
 *  its own four-modifier check the way it did before this ticket. */
export function modsMatch(e: KeyboardEvent, mods: Mods): boolean {
  return (
    e.ctrlKey === !!mods.ctrl &&
    e.shiftKey === !!mods.shift &&
    e.altKey === !!mods.alt &&
    e.metaKey === !!mods.meta
  )
}

/** Object-to-object version of the same comparison `modsMatch` does against a
 *  live event — needed once a binding can be compared to ANOTHER binding
 *  (KAN-83's conflict check) rather than only to a keystroke. */
function modsEqual(a: Mods, b: Mods): boolean {
  return !!a.ctrl === !!b.ctrl && !!a.shift === !!b.shift && !!a.alt === !!b.alt && !!a.meta === !!b.meta
}

/**
 * KAN-83. A cycle action's binding is a real key, not a digit — Tab today,
 * but nothing here says it has to stay Tab, unlike the switch actions below
 * whose "key" is never stored because it IS the target space (see
 * `SpaceKeybinds`'s doc). `key` is an `e.key` value, compared case-
 * insensitively so a captured letter still matches with or without Shift.
 */
export interface KeyBinding {
  mods: Mods
  key: string
}

/**
 * The four space actions KAN-83 makes customizable, in the fixed order every
 * function below that has to consider "the other three" iterates them in
 * (`findSpaceBindingConflict`, `normalizeSpaceKeybinds` in settings.ts).
 *
 * The switch actions store ONLY a `Mods`: which SPACE a press selects comes
 * from the physical digit key itself (`spaceIndex` reads `e.key`,
 * `pinnedSpaceIndex` reads `e.code` — unchanged by this ticket), so there is
 * no tenth "which key" case to invent for a binding that already covers nine
 * keys by construction. The cycle actions store a `KeyBinding` (`Mods` AND a
 * key) because Tab itself is the configurable part there — nothing else
 * tells `spaceCycle` which physical key means "next".
 */
export interface SpaceKeybinds {
  switchUnpinned: Mods
  switchPinned: Mods
  cycleNext: KeyBinding
  cyclePrev: KeyBinding
}

/** Today's hardcoded shortcuts, restated as the defaults KAN-83's Settings
 *  field falls back to when a value is absent or fails validation — the
 *  exact chords `spaceIndex`/`pinnedSpaceIndex`/`spaceCycle` matched before
 *  KAN-83, so an untouched settings.json changes nothing.
 *
 *  KAN-95: `spacemenu.ts`'s `acceleratorLabel` now formats from the resolved
 *  binding (via `formatMods` above) rather than reading these as literals, so
 *  a rebind no longer leaves the dropdown label stale.
 *
 *  KAN-91: `switchUnpinned`/`switchPinned` are built from `primaryMods` —
 *  Cmd+1..9 / Cmd+Shift+1..9 on a fresh macOS install, unchanged Ctrl+1..9 /
 *  Ctrl+Shift+1..9 everywhere else — matching how Chrome/Safari themselves
 *  switch to tab N on each platform.
 *
 *  `cycleNext`/`cyclePrev` deliberately do NOT follow the same swap and stay
 *  Ctrl+Tab / Ctrl+Shift+Tab on macOS too: Cmd+Tab is the OS's own app
 *  switcher, resolved before any window's JS ever sees the keystroke, so
 *  defaulting to it would ship a shortcut that is silently dead on every Mac.
 *  This is the same reason Chrome and Safari both keep Ctrl+Tab for in-app
 *  tab cycling on macOS instead of Cmd+Tab. */
export const DEFAULT_SPACE_KEYBINDS: SpaceKeybinds = {
  switchUnpinned: primaryMods(),
  switchPinned: primaryMods({ shift: true }),
  cycleNext: { mods: { ctrl: true }, key: 'Tab' },
  cyclePrev: { mods: { ctrl: true, shift: true }, key: 'Tab' },
}

export type SpaceAction = keyof SpaceKeybinds

/** Fills in defaults for whichever of the four `Settings.spaceKeybinds`
 *  leaves unset — each key is independently optional there (the `pinned?` /
 *  `agentSpawned?` precedent: an old settings.json has none of them and must
 *  still load), so every caller that MATCHES against a binding resolves
 *  through here first rather than repeating four `?? DEFAULT` fallbacks. */
export function resolveSpaceKeybinds(stored?: Partial<SpaceKeybinds>): SpaceKeybinds {
  return {
    switchUnpinned: stored?.switchUnpinned ?? DEFAULT_SPACE_KEYBINDS.switchUnpinned,
    switchPinned: stored?.switchPinned ?? DEFAULT_SPACE_KEYBINDS.switchPinned,
    cycleNext: stored?.cycleNext ?? DEFAULT_SPACE_KEYBINDS.cycleNext,
    cyclePrev: stored?.cyclePrev ?? DEFAULT_SPACE_KEYBINDS.cyclePrev,
  }
}

/**
 * KAN-83 acceptance #5: refuse a binding already claimed by one of the OTHER
 * three space actions — "unambiguous, cheap", not a general keybind
 * registry. `candidate` is a bare `Mods` for a switch action or a full
 * `KeyBinding` for a cycle action, matching what each accepts above.
 *
 * A switch action's real match domain is "these mods plus ANY digit 1-9",
 * not a specific key, which is why it is stored without one — but that also
 * means a conflict check comparing mods alone would miss the one case a
 * fully-generic cycle rebind opens up: pointing `cycleNext`/`cyclePrev` at a
 * digit key. `keyDomain` below makes that comparable: `null` for a switch
 * action's "any digit", a lower-cased literal for a cycle action's specific
 * key. Two `null`s collide (same mods, same "any digit" domain — the
 * ordinary switchUnpinned/switchPinned case); a `null` and a digit literal
 * collide (the cycle-onto-a-digit edge case); two literals collide only if
 * equal.
 */
export function findSpaceBindingConflict(
  action: SpaceAction,
  candidate: Mods | KeyBinding,
  current: SpaceKeybinds,
): SpaceAction | null {
  const isKeyBinding = (v: Mods | KeyBinding): v is KeyBinding => 'key' in v
  const keyDomain = (v: Mods | KeyBinding): string | null => (isKeyBinding(v) ? v.key.toLowerCase() : null)
  const domainsCollide = (a: string | null, b: string | null): boolean => {
    if (a === null && b === null) return true
    if (a === null) return /^[1-9]$/.test(b!)
    if (b === null) return /^[1-9]$/.test(a)
    return a === b
  }
  const cMods = isKeyBinding(candidate) ? candidate.mods : candidate
  const cKey = keyDomain(candidate)
  for (const other of Object.keys(current) as SpaceAction[]) {
    if (other === action) continue
    const b = current[other]
    if (modsEqual(cMods, isKeyBinding(b) ? b.mods : b) && domainsCollide(cKey, keyDomain(b))) return other
  }
  return null
}

/**
 * KAN-83 acceptance: "warn but allow" a collision with a shortcut the rest of
 * the app already owns — refusing these would be presumptuous (the ticket's
 * words: the user may genuinely want the collision) so this only NAMES it
 * for a UI warning, unlike `findSpaceBindingConflict` which blocks. Only
 * meaningful for a cycle action's real, capturable key; a switch action's
 * digit can never coincide with a letter shortcut, so callers only need this
 * for `KeyBinding` candidates.
 *
 * The six chords are read out of the files that own them (menu.ts's
 * `CmdOrCtrl+T/W/Shift+D`, App.tsx's Ctrl+Shift+G grid picker, FileBrowser's
 * Ctrl+F search and Ctrl+Shift+N new-folder) — restated here because this
 * ticket was told not to build a real registry those files could publish
 * into instead.
 *
 * ponytail: a hand-maintained list, not a registry every shortcut in the app
 * registers into. Fine at six entries; upgrade to a shared registry (menu.ts,
 * FileBrowser.tsx and here all reading one source) if a second ticket ever
 * needs to enumerate "every shortcut", not just warn about six of them.
 *
 * CAVEAT this ticket cannot fix, only name: Ctrl+T and Ctrl+W are Electron
 * NATIVE menu accelerators (menu.ts's `CmdOrCtrl+T`/`CmdOrCtrl+W`), resolved
 * before the keystroke ever reaches this renderer as a `KeyboardEvent` — so
 * "warn but allow" is honest about SAVING the rebind but cannot make it fire
 * while those two win at the OS/Electron layer first. Out of scope for the
 * same reason OS/terminal collisions are (see the module's Settings-modal
 * caller): undetectable and unfixable from here.
 *
 * KAN-91: all six chords are built from `primaryMods` now, not the literal
 * `{ ctrl: true }` this list hardcoded before this ticket — every one of the
 * six files that actually OWNS a chord (menu.ts's `CmdOrCtrl+T`/`CmdOrCtrl+W`,
 * App.tsx's grid picker, FileBrowser's search/new-folder) switched to Cmd on
 * macOS elsewhere in this same ticket, and a list restating them by hand in
 * literal Ctrl would go stale on a Mac the moment it did: warning a mac user
 * that their Ctrl+Shift+G rebind collides with the grid picker when Cmd+
 * Shift+G is the one that actually fires there now, and MISSING the real
 * collision if they typed Cmd+Shift+G instead.
 */
export function knownAppShortcut(binding: KeyBinding): string | null {
  const KNOWN: { mods: Mods; key: string; label: string }[] = [
    { mods: primaryMods(), key: 't', label: `New Tab (${formatMods(primaryMods())}+T)` },
    { mods: primaryMods(), key: 'w', label: `Close Tab (${formatMods(primaryMods())}+W)` },
    {
      mods: primaryMods({ shift: true }),
      key: 'g',
      label: `the split grid picker (${formatMods(primaryMods({ shift: true }))}+G)`,
    },
    {
      mods: primaryMods({ shift: true }),
      key: 'd',
      label: `Toggle Developer Mode (${formatMods(primaryMods({ shift: true }))}+D)`,
    },
    { mods: primaryMods(), key: 'f', label: `Search (${formatMods(primaryMods())}+F)` },
    {
      mods: primaryMods({ shift: true }),
      key: 'n',
      label: `New Folder (${formatMods(primaryMods({ shift: true }))}+N)`,
    },
  ]
  const hit = KNOWN.find((k) => modsEqual(k.mods, binding.mods) && k.key === binding.key.toLowerCase())
  return hit?.label ?? null
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
 *
 * KAN-83: `mods` defaults to the historical Ctrl-only chord but is now a
 * parameter, not a literal — App.tsx and Terminal.tsx both pass the SAME
 * resolved `Settings.spaceKeybinds.switchUnpinned` (via
 * `resolveSpaceKeybinds`) so a rebind still cannot make the two halves
 * disagree about which press this is. The digit-reading half below is
 * deliberately NOT a parameter — see `SpaceKeybinds`'s doc for why there is
 * no "key" to customize here at all.
 */
export function spaceIndex(e: KeyboardEvent, mods: Mods = DEFAULT_SPACE_KEYBINDS.switchUnpinned): number | null {
  if (!modsMatch(e, mods)) return null
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
 *
 * KAN-83: `mods` is now a parameter (default: the historical Ctrl+Shift
 * chord) for the same reason `spaceIndex`'s is — see that function's doc.
 */
export function pinnedSpaceIndex(e: KeyboardEvent, mods: Mods = DEFAULT_SPACE_KEYBINDS.switchPinned): number | null {
  if (!modsMatch(e, mods)) return null
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
 *
 * KAN-83: `next`/`prev` are now full `KeyBinding`s (mods AND key), defaulting
 * to the historical Ctrl+Tab / Ctrl+Shift+Tab pair — UNLIKE the two functions
 * above, this action's key is genuinely configurable (there is no digit to
 * imply it), so a rebind can move cycling off Tab entirely. Checked as two
 * independent `KeyBinding`s, not "shift toggles direction on one shared key",
 * because KAN-83 lets a user rebind next/previous separately.
 */
export function spaceCycle(
  e: KeyboardEvent,
  next: KeyBinding = DEFAULT_SPACE_KEYBINDS.cycleNext,
  prev: KeyBinding = DEFAULT_SPACE_KEYBINDS.cyclePrev,
): 1 | -1 | null {
  if (e.key === next.key && modsMatch(e, next.mods)) return 1
  if (e.key === prev.key && modsMatch(e, prev.mods)) return -1
  return null
}
