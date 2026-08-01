import { describe, it, expect, vi } from 'vitest'

/**
 * KAN-91. macOS `Cmd` support in the renderer. The trap the ticket itself
 * names: a test asserting a binding matches `ctrl OR meta` passes on BOTH
 * platforms while the app is wrong on one of them. Every assertion below is
 * therefore FORCED to one specific platform and checks an EXACT boolean or
 * an EXACT shape — never an OR of the two chords — so a future "fix" that
 * quietly widens `primaryMod`/`modsMatch` back into an OR would show up here
 * as a false positive going true, not as a passing test staying green.
 *
 * `isMac`/`primaryMod`/`primaryMods`/`formatMods` all read `process.platform`
 * at CALL time (see keys.ts's own doc on `isMac`), the same way
 * main/external.ts's `openExternalTerminal` does — so forcing the platform
 * with `Object.defineProperty` per call needs no `vi.resetModules()`.
 *
 * `DEFAULT_SPACE_KEYBINDS` is different: a real module-level `const`, baked
 * in at import time (same shape as policy.ts's `DEFAULT_SYSTEM_ROOTS`), so
 * exercising its macOS shape needs the full force-platform + resetModules +
 * re-import dance policy.posix.test.ts already uses for that reason.
 *
 * NONE OF THIS WAS RUN. The shared node_modules this worktree needs was
 * destroyed before this ticket started (see the task brief) — `npm test`
 * cannot execute here at all. Every assertion below was hand-traced against
 * keys.ts as written, both on this branch and by re-reading what shipped on
 * `main` before it, but CI on a clean checkout is the only thing that will
 * actually run this file.
 */

function withPlatform<T>(platform: string, fn: () => T): T {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', real)
  }
}

async function loadKeysAs(platform: string) {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  vi.resetModules()
  const mod = await import('../src/renderer/keys')
  Object.defineProperty(process, 'platform', real)
  vi.resetModules()
  return mod
}

const { isMac, primaryMod, primaryMods, formatMods, modsMatch, knownAppShortcut } = await import(
  '../src/renderer/keys'
)

/** Structural `KeyboardEvent` shape, matching test/keys.test.ts's own `key()` —
 *  vitest here runs in `environment: 'node'`, so there is no real DOM
 *  `KeyboardEvent` constructor. */
const key = (
  mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {},
  k = 'g',
  code = 'KeyG',
): KeyboardEvent =>
  ({
    key: k,
    code,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    metaKey: !!mods.meta,
  }) as KeyboardEvent

describe('isMac', () => {
  // New function — did not exist on main at all, so every call here is red
  // against an unmodified checkout (there is nothing to import).
  it('is true only on darwin', () => {
    expect(withPlatform('darwin', () => isMac())).toBe(true)
    expect(withPlatform('win32', () => isMac())).toBe(false)
    expect(withPlatform('linux', () => isMac())).toBe(false)
  })
})

describe('primaryMod — NOT "ctrl OR meta", the exact trap this ticket names', () => {
  it('on macOS, Cmd alone is the accelerator and Ctrl alone is NOT', () => {
    expect(withPlatform('darwin', () => primaryMod(key({ meta: true })))).toBe(true)
    expect(withPlatform('darwin', () => primaryMod(key({ ctrl: true })))).toBe(false)
  })
  it('on Windows, Ctrl alone is the accelerator and Cmd alone is NOT', () => {
    expect(withPlatform('win32', () => primaryMod(key({ ctrl: true })))).toBe(true)
    expect(withPlatform('win32', () => primaryMod(key({ meta: true })))).toBe(false)
  })
  it('on Linux, same as Windows', () => {
    expect(withPlatform('linux', () => primaryMod(key({ ctrl: true })))).toBe(true)
    expect(withPlatform('linux', () => primaryMod(key({ meta: true })))).toBe(false)
  })
  it('is false with neither held, on every platform', () => {
    expect(withPlatform('darwin', () => primaryMod(key()))).toBe(false)
    expect(withPlatform('win32', () => primaryMod(key()))).toBe(false)
  })
})

describe('primaryMods', () => {
  it('builds { meta: true, ...extra } on macOS', () => {
    expect(withPlatform('darwin', () => primaryMods({ shift: true }))).toEqual({ meta: true, shift: true })
    expect(withPlatform('darwin', () => primaryMods())).toEqual({ meta: true })
  })
  it('builds { ctrl: true, ...extra } on Windows/Linux, unchanged from the pre-ticket literal', () => {
    expect(withPlatform('win32', () => primaryMods({ shift: true }))).toEqual({ ctrl: true, shift: true })
    expect(withPlatform('linux', () => primaryMods())).toEqual({ ctrl: true })
  })
})

// App.tsx's Ctrl+Shift+G grid picker used to hand-check all four modifiers
// itself; it now asks `modsMatch(e, primaryMods({ shift: true }))`. `modsMatch`
// existed on main too, but as a MODULE-PRIVATE function — not exported — so
// importing it by name is itself new (red on main: the import binds to
// `undefined`, and calling it throws).
describe('the grid-picker chord: modsMatch(e, primaryMods({ shift: true }))', () => {
  it('on macOS, Cmd+Shift+G matches and plain Ctrl+Shift+G does not', () => {
    withPlatform('darwin', () => {
      const chord = primaryMods({ shift: true })
      expect(modsMatch(key({ meta: true, shift: true }), chord)).toBe(true)
      expect(modsMatch(key({ ctrl: true, shift: true }), chord)).toBe(false)
    })
  })
  it('on Windows, only Ctrl+Shift+G matches — exactly the pre-ticket behaviour', () => {
    withPlatform('win32', () => {
      const chord = primaryMods({ shift: true })
      expect(modsMatch(key({ ctrl: true, shift: true }), chord)).toBe(true)
      expect(modsMatch(key({ meta: true, shift: true }), chord)).toBe(false)
    })
  })
})

describe('formatMods renders the platform\'s own symbols', () => {
  // Red on main: the old formatMods had no platform branch at all and always
  // emitted the literal text 'Meta' for `{ meta: true }`, on every platform.
  it('renders ⌘ on darwin for a meta-only binding', () => {
    expect(withPlatform('darwin', () => formatMods({ meta: true }))).toBe('⌘')
  })
  it('renders all four mac symbols in Apple\'s own canonical order (Control, Option, Shift, Command)', () => {
    expect(withPlatform('darwin', () => formatMods({ ctrl: true, alt: true, shift: true, meta: true }))).toBe(
      '⌃+⌥+⇧+⌘',
    )
  })
  // Not red on main (main already rendered 'Ctrl' for a ctrl-only binding on
  // every platform) — this is the "Windows is untouched" half every KAN-90
  // posix test file pairs with its new-platform assertions, proving this
  // ticket did not also change the Windows text/order while it was in here.
  it('renders Ctrl on win32 for a ctrl-only binding — unchanged', () => {
    expect(withPlatform('win32', () => formatMods({ ctrl: true }))).toBe('Ctrl')
  })
  it('keeps the Windows order (Ctrl, Shift, Alt, Meta) and text — unchanged', () => {
    expect(withPlatform('win32', () => formatMods({ meta: true, alt: true, shift: true, ctrl: true }))).toBe(
      'Ctrl+Shift+Alt+Meta',
    )
  })
})

describe('DEFAULT_SPACE_KEYBINDS is platform-aware at the shipped default', () => {
  it('switchUnpinned/switchPinned are Cmd-based on a fresh macOS install', async () => {
    const mac = await loadKeysAs('darwin')
    expect(mac.DEFAULT_SPACE_KEYBINDS.switchUnpinned).toEqual({ meta: true })
    expect(mac.DEFAULT_SPACE_KEYBINDS.switchPinned).toEqual({ meta: true, shift: true })
  })

  // Deliberately NOT swapped: Cmd+Tab is the OS's own app switcher and never
  // reaches a window's JS, so the cycle actions stay Ctrl+Tab / Ctrl+Shift+Tab
  // on macOS too — the same reason Chrome/Safari do. This half is NOT red
  // against main (main's cycleNext/cyclePrev were already ctrl-only,
  // unconditionally, on every platform) — it is a regression guard proving a
  // later "fix" doesn't swap these onto Cmd by mistake.
  it('cycleNext/cyclePrev stay Ctrl+Tab / Ctrl+Shift+Tab on macOS — Cmd+Tab is the OS app switcher', async () => {
    const mac = await loadKeysAs('darwin')
    expect(mac.DEFAULT_SPACE_KEYBINDS.cycleNext).toEqual({ mods: { ctrl: true }, key: 'Tab' })
    expect(mac.DEFAULT_SPACE_KEYBINDS.cyclePrev).toEqual({ mods: { ctrl: true, shift: true }, key: 'Tab' })
  })

  // Windows untouched, restated in full for this platform-forced re-import
  // specifically (test/keys.test.ts already covers the un-forced default).
  it('is unchanged on win32', async () => {
    const win = await loadKeysAs('win32')
    expect(win.DEFAULT_SPACE_KEYBINDS).toEqual({
      switchUnpinned: { ctrl: true },
      switchPinned: { ctrl: true, shift: true },
      cycleNext: { mods: { ctrl: true }, key: 'Tab' },
      cyclePrev: { mods: { ctrl: true, shift: true }, key: 'Tab' },
    })
  })
})

describe('knownAppShortcut is platform-aware too (KAN-91)', () => {
  // KAN-83's own test/keys.test.ts already proves this list still names
  // Ctrl+Shift+G as the grid picker on win32 (unforced, regex-matched) — these
  // add the platform-forced, EXACT half: red on main, since main's list was
  // hardcoded to `{ ctrl: true }` on every platform and would neither name
  // Cmd+Shift+G nor stay silent about literal Ctrl+Shift+G on a Mac.
  it('on macOS, names Cmd+Shift+G — not Ctrl+Shift+G — as the grid picker', () => {
    withPlatform('darwin', () => {
      const label = knownAppShortcut({ mods: { meta: true, shift: true }, key: 'g' })
      expect(label).toMatch(/grid picker/)
      expect(label).toContain('⇧+⌘+G')
      expect(knownAppShortcut({ mods: { ctrl: true, shift: true }, key: 'g' })).toBeNull()
    })
  })
  it('on Windows, still only Ctrl+Shift+G — unchanged', () => {
    withPlatform('win32', () => {
      expect(knownAppShortcut({ mods: { ctrl: true, shift: true }, key: 'g' })).toMatch(/grid picker/)
      expect(knownAppShortcut({ mods: { meta: true, shift: true }, key: 'g' })).toBeNull()
    })
  })
})

describe('KAN-91: what a STORED { ctrl: true } binding means on macOS', () => {
  // Not red on main (main had no platform branch, so a stored ctrl binding
  // already meant literal Ctrl everywhere) — this locks the ticket's explicit
  // decision in as a regression guard: `modsMatch`/`resolveSpaceKeybinds`
  // never gained a "ctrl means Cmd on a Mac" alias, so a settings.json
  // carried over from Windows keeps behaving exactly as it did there.
  it('resolves to literal Ctrl on a mac install, never remapped to Cmd', async () => {
    const mac = await loadKeysAs('darwin')
    const resolved = mac.resolveSpaceKeybinds({ switchUnpinned: { ctrl: true } })
    expect(resolved.switchUnpinned).toEqual({ ctrl: true })
  })

  it('a literal Ctrl+3 matches that stored binding on macOS, and Cmd+3 does not', async () => {
    const mac = await loadKeysAs('darwin')
    const resolved = mac.resolveSpaceKeybinds({ switchUnpinned: { ctrl: true } })
    const ctrl3 = key({ ctrl: true }, '3', 'Digit3')
    const cmd3 = key({ meta: true }, '3', 'Digit3')
    expect(mac.spaceIndex(ctrl3, resolved.switchUnpinned)).toBe(2)
    expect(mac.spaceIndex(cmd3, resolved.switchUnpinned)).toBeNull()
  })
})
