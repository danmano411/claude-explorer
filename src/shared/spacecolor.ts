/**
 * KAN-84/85: pure logic for a space's ambient wash color. Shared between main
 * (sanitize() validates what's on disk) and renderer (App.tsx resolves it to
 * CSS, SpaceColorPicker.tsx builds a custom pair) — same reason shared/groups.ts
 * is imported from both.
 */
import type { SpaceColor } from './types'

// Chars a CSS color token or a `var(--name)` reference can legitimately use:
// hex, rgb()/rgba()/hsl(), percentages, decimals. A hand-edited value outside
// this set is not a color this app ever wrote, and gets coerced away rather
// than trusted into an inline style — the `int()` precedent in
// src/main/workspace.ts, applied to strings instead of numbers.
const SAFE_COLOR = /^[#a-zA-Z0-9(),.\-\s%]{1,64}$/

function validColor(v: unknown): v is string {
  return typeof v === 'string' && SAFE_COLOR.test(v)
}

/**
 * Coerces a value read off disk into a `SpaceColor`, or undefined. Follows the
 * `pinned: s.pinned === true ? true : undefined` pattern (src/main/workspace.ts)
 * rather than letting `Space.color` ride the `{...s}` spread.
 */
export function sanitizeSpaceColor(v: unknown): SpaceColor | undefined {
  if (validColor(v)) return v
  if (v && typeof v === 'object') {
    const o = v as { light?: unknown; dark?: unknown }
    if (validColor(o.light) && validColor(o.dark)) return { light: o.light, dark: o.dark }
  }
  return undefined
}

/**
 * The two inline custom properties the chrome band resolves under
 * `prefers-color-scheme` (`.app-colored` in index.css). A preset (a single
 * `var()` name string) sets both to the SAME name, which itself repaints
 * under dark mode for free — presets and custom colors share this one render
 * path, which is the whole point of KAN-84's design (KAN-85's custom pair is
 * a small addition on top, not a parallel implementation).
 *
 * Returns `{}` for an uncolored space, so React emits no inline style at all
 * and `.app-colored` (which never gets applied for such a space — see
 * App.tsx) never runs a color-mix() that would otherwise subtly change the
 * chrome's alpha even at "no tint".
 */
export function spaceColorStyle(color: SpaceColor | undefined): Record<string, string> {
  if (color === undefined) return {}
  const light = typeof color === 'string' ? color : color.light
  const dark = typeof color === 'string' ? color : color.dark
  return { '--space-color-light': light, '--space-color-dark': dark }
}

/** Clay, opaque — the picker's starting point when there is no existing
 *  custom pair to reopen (a preset, or no color at all). Matches :root's
 *  `--clay` (index.css) so "Custom…" starts near a color already in the app,
 *  not an arbitrary one. */
const DEFAULT_HEX = '#C15F3C'

/** Packs a native `<input type=color>` hex plus an alpha `<input type=range>`
 *  (0-1) into the ONE resolved CSS color string KAN-85 stores — an 8-digit
 *  hex, which `color-mix()` accepts exactly like any other `<color>`. */
export function encodeHexAlpha(hex: string, alpha: number): string {
  const n = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
  return `${hex}${n.toString(16).padStart(2, '0')}`
}

/** The inverse, for reopening the picker on an existing custom color. Anything
 *  that isn't an 8- or 6-digit hex (a preset `var()` name, or nothing yet)
 *  starts the picker at DEFAULT_HEX, opaque, rather than throwing. */
export function decodeHexAlpha(v: string | undefined): { hex: string; alpha: number } {
  if (v && /^#[0-9a-fA-F]{8}$/.test(v)) {
    return { hex: v.slice(0, 7), alpha: parseInt(v.slice(7, 9), 16) / 255 }
  }
  if (v && /^#[0-9a-fA-F]{6}$/.test(v)) return { hex: v, alpha: 1 }
  return { hex: DEFAULT_HEX, alpha: 1 }
}
