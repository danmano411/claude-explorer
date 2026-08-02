import { useEffect, useRef } from 'react'
import type { Space } from '../../shared/types'

/**
 * The Alt-Tab-style panel shown while Ctrl+Tab / Ctrl+Shift+Tab is held
 * (KAN-101). Presentational only — App.tsx owns all state (the hold timer,
 * the highlighted id, the keydown/keyup/pointerdown listeners) and mounts
 * this component only once the grace period has elapsed. No state, no
 * handlers, no `focus()`, no backdrop: this is a pure render of whatever App
 * has already decided.
 *
 * The ONE effect here is not state — it is scroll position, which has no
 * declarative spelling. `.spaceswitch` is capped at 70vh (a space list is
 * unbounded, unlike `.gridpick`'s fixed 3x3), so past ~21 spaces the
 * highlighted row can land outside the box. Keeping it in view is the whole
 * reason the cap is safe; without this the user would be holding a gesture
 * whose current pick is invisible and unscrollable.
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
  const activeRow = useRef<HTMLDivElement | null>(null)
  // `block: 'nearest'` so a highlight already on screen does not scroll at all
  // — only one that has fallen outside the capped box moves, and it moves the
  // minimum distance. Re-runs on every highlight change, which is every Tab.
  useEffect(() => {
    activeRow.current?.scrollIntoView({ block: 'nearest' })
  }, [props.highlightId])

  return (
    <div className="spaceswitch" role="presentation">
      {props.spaces.map((s) => (
        <div
          key={s.id}
          ref={s.id === props.highlightId ? activeRow : undefined}
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
