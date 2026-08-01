import { describe, it, expect } from 'vitest'
import {
  decodeHexAlpha,
  encodeHexAlpha,
  sanitizeSpaceColor,
  spaceColorStyle,
} from '../src/shared/spacecolor'

describe('sanitizeSpaceColor', () => {
  it('accepts a preset var() string', () => {
    expect(sanitizeSpaceColor('var(--clay)')).toBe('var(--clay)')
  })
  it('accepts a valid custom light/dark pair', () => {
    expect(sanitizeSpaceColor({ light: '#C15F3Cff', dark: '#D2795A80' }))
      .toEqual({ light: '#C15F3Cff', dark: '#D2795A80' })
  })
  it('drops undefined/null/non-string/non-object garbage to undefined', () => {
    for (const v of [undefined, null, 1, true, [], () => {}]) {
      expect(sanitizeSpaceColor(v)).toBeUndefined()
    }
  })
  it('rejects an empty string', () => {
    expect(sanitizeSpaceColor('')).toBeUndefined()
  })
  it('rejects a string carrying characters no CSS color/var() token uses', () => {
    // A value this app never wrote — e.g. an attempt to break out of the
    // custom-property value with a semicolon or braces — is coerced away,
    // not trusted into an inline style.
    expect(sanitizeSpaceColor('red; } .app { display:none')).toBeUndefined()
  })
  it('rejects an oversized string', () => {
    expect(sanitizeSpaceColor('#'.repeat(65))).toBeUndefined()
  })
  it('rejects a pair missing either half', () => {
    expect(sanitizeSpaceColor({ light: '#C15F3Cff' })).toBeUndefined()
    expect(sanitizeSpaceColor({ dark: '#C15F3Cff' })).toBeUndefined()
  })
  it('rejects a pair with one invalid half, not just drops that half', () => {
    expect(sanitizeSpaceColor({ light: '#C15F3Cff', dark: 123 })).toBeUndefined()
  })
})

describe('spaceColorStyle', () => {
  it('returns no inline properties at all for an uncolored space', () => {
    // Not "set to transparent" — genuinely absent, so `.app-colored` (which
    // gates on the CLASS, not on these properties resolving to something)
    // never runs a color-mix() for this render.
    expect(spaceColorStyle(undefined)).toEqual({})
  })
  it('sets BOTH properties to the SAME value for a preset — one render path', () => {
    const style = spaceColorStyle('var(--clay)')
    expect(style['--space-color-light']).toBe('var(--clay)')
    expect(style['--space-color-dark']).toBe('var(--clay)')
  })
  it('sets each property to its own half for a custom pair', () => {
    const style = spaceColorStyle({ light: '#C15F3Cff', dark: '#D2795A80' })
    expect(style['--space-color-light']).toBe('#C15F3Cff')
    expect(style['--space-color-dark']).toBe('#D2795A80')
  })
  it('two DIFFERENT presets resolve to two DIFFERENT styles — not a self-comparison', () => {
    const clay = spaceColorStyle('var(--clay)')
    const sage = spaceColorStyle('var(--diff-add)')
    expect(clay['--space-color-light']).not.toBe(sage['--space-color-light'])
  })
  it('a custom pair whose two halves differ resolves to two DIFFERENT properties', () => {
    const style = spaceColorStyle({ light: '#C15F3Cff', dark: '#D2795A80' })
    expect(style['--space-color-light']).not.toBe(style['--space-color-dark'])
  })
})

describe('encodeHexAlpha / decodeHexAlpha (KAN-85)', () => {
  it('round-trips a hex + alpha through the stored 8-digit form', () => {
    const stored = encodeHexAlpha('#C15F3C', 0.5)
    expect(stored).toMatch(/^#c15f3c[0-9a-f]{2}$/i)
    const back = decodeHexAlpha(stored)
    expect(back.hex.toLowerCase()).toBe('#c15f3c')
    expect(back.alpha).toBeCloseTo(0.5, 1)
  })
  it('full opacity encodes to ff and decodes back to 1', () => {
    expect(encodeHexAlpha('#C15F3C', 1).toLowerCase()).toBe('#c15f3cff')
    expect(decodeHexAlpha('#C15F3Cff').alpha).toBe(1)
  })
  it('zero opacity encodes to 00 and decodes back to 0', () => {
    expect(encodeHexAlpha('#C15F3C', 0).toLowerCase()).toBe('#c15f3c00')
    expect(decodeHexAlpha('#C15F3C00').alpha).toBe(0)
  })
  it('clamps out-of-range alpha rather than producing a garbage byte', () => {
    expect(encodeHexAlpha('#C15F3C', 5).toLowerCase()).toBe('#c15f3cff')
    expect(encodeHexAlpha('#C15F3C', -5).toLowerCase()).toBe('#c15f3c00')
  })
  it('decodes a bare 6-digit hex as fully opaque (a hand-set / legacy value)', () => {
    expect(decodeHexAlpha('#C15F3C')).toEqual({ hex: '#C15F3C', alpha: 1 })
  })
  it('falls back to the Clay default for a preset var() name or nothing at all', () => {
    expect(decodeHexAlpha('var(--clay)').hex).toBe('#C15F3C')
    expect(decodeHexAlpha(undefined).hex).toBe('#C15F3C')
  })
  it('two different light/dark picks decode to two different results — not self-comparing', () => {
    const light = decodeHexAlpha('#C15F3Cff')
    const dark = decodeHexAlpha('#22201Bff')
    expect(light.hex).not.toBe(dark.hex)
  })
})
