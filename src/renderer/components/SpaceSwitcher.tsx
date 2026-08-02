import type { Space } from '../../shared/types'

/**
 * The Alt-Tab-style panel shown while Ctrl+Tab / Ctrl+Shift+Tab is held
 * (KAN-101). Presentational only — App.tsx owns all state (the hold timer,
 * the highlighted id, the keydown/keyup/pointerdown listeners) and mounts
 * this component only once the grace period has elapsed. No state, no
 * effects, no handlers, no `focus()`, no backdrop: this is a pure render of
 * whatever App has already decided.
 *
 * `spaces` arrives already in `orderSpaces()` order (pinned run, then
 * unpinned, each preserving the user's arrangement) — rendered top-to-bottom
 * exactly as given. Never re-sorted here: doing so would let this component
 * silently disagree with the order Ctrl+Tab actually cycles in.
 */
export function SpaceSwitcher(props: {
  /** Already in orderSpaces() order — render top-to-bottom as given. Do not re-sort. */
  spaces: Space[]
  /** id of the highlighted row */
  highlightId: string
}) {
  return (
    <div className="spaceswitch" role="presentation">
      {props.spaces.map((s) => (
        <div
          key={s.id}
          className={s.id === props.highlightId ? 'spaceswitch-row is-active' : 'spaceswitch-row'}
          data-space-id={s.id}
        >
          <span className="spaceswitch-name">{s.name}</span>
          {/* KAN-81's marker, echoed from SpaceMenu — a visual note only, never
              a reorder: order is entirely the caller's to decide. */}
          {s.pinned && <span className="spaceswitch-pin" aria-hidden="true">📌</span>}
        </div>
      ))}
    </div>
  )
}
