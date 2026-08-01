import { useState } from 'react'
import type { SpaceColor } from '../../shared/types'
import { decodeHexAlpha, encodeHexAlpha } from '../../shared/spacecolor'

/**
 * KAN-85: the custom space-color dialog. Two rows — light, dark — each a
 * native `<input type="color">` (Windows' own dialog supplies the hex field
 * and a full picker for free, so there is no color library and no custom
 * slider math here) plus an alpha `<input type="range">`. Both resulting
 * previews are shown side by side below the rows, so the pair is chosen and
 * compared AS a pair rather than one theme at a time — the owner decision a
 * single hex cannot repaint per theme, and a derived dark variant would be a
 * color the user never chose.
 *
 * Reuses the shared `.modal`/`.modal-backdrop` shell (ConfirmDialog's, KAN-57
 * review: "no new hand-rolled modal-backdrop"), not a fifth dialog chrome.
 *
 * Pure props in, one `onApply` out: Cancel (or the backdrop, or Escape)
 * changes nothing, matching every other modal in this app.
 */
export function SpaceColorPicker({
  initial,
  onApply,
  onCancel,
}: {
  /** The space's EXISTING custom pair, if it had one — reopens the picker
   *  where it was left. A preset or no color at all starts fresh (there is no
   *  hex to recover from a `var()` name without a DOM round-trip, and
   *  defaulting near Clay is close enough for a starting point). */
  initial: { light: string; dark: string } | undefined
  onApply: (color: SpaceColor) => void
  onCancel: () => void
}) {
  const [light, setLight] = useState(decodeHexAlpha(initial?.light))
  const [dark, setDark] = useState(decodeHexAlpha(initial?.dark))

  const apply = () =>
    onApply({
      light: encodeHexAlpha(light.hex, light.alpha),
      dark: encodeHexAlpha(dark.hex, dark.alpha),
    })

  const rows = [
    { key: 'light', label: 'Light', v: light, set: setLight },
    { key: 'dark', label: 'Dark', v: dark, set: setDark },
  ] as const

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal colorpicker"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); onCancel() }
        }}
      >
        <p>Custom space color</p>
        {rows.map((row) => (
          <div className="colorpicker-row" key={row.key}>
            <span className="colorpicker-label">{row.label}</span>
            <input
              type="color"
              value={row.v.hex}
              onChange={(e) => row.set({ ...row.v, hex: e.target.value })}
            />
            <input
              type="range"
              className="colorpicker-alpha"
              min={0}
              max={1}
              step={0.01}
              value={row.v.alpha}
              onChange={(e) => row.set({ ...row.v, alpha: Number(e.target.value) })}
            />
          </div>
        ))}
        {/* Both previews visible at once, side by side — the whole point,
            per KAN-85: choosing the pair together, not one theme at a time. */}
        <div className="colorpicker-compare">
          {rows.map((row) => (
            <span
              key={row.key}
              className="colorpicker-preview"
              title={row.label}
              style={{ background: encodeHexAlpha(row.v.hex, row.v.alpha) }}
            />
          ))}
        </div>
        <div className="modal-actions">
          <button autoFocus onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={apply}>Apply</button>
        </div>
      </div>
    </div>
  )
}
