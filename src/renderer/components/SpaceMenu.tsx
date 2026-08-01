import { useEffect, useRef, useState } from 'react'
import type { Space, SpaceColor } from '../../shared/types'
import { acceleratorLabel, canDeleteSpace, nextFocusIndex } from '../spacemenu'
import { deleteSpaceReason, type CloseRisk } from '../closeguard'
import { ConfirmDialog } from './ConfirmDialog'
import { SpaceColorPicker } from './SpaceColorPicker'
import { GROUP_MIME, TAB_MIME, COLOR_NAMES } from '../TabBar'
import { GROUP_COLORS } from '../../shared/groups'
// Styles live in index.css (the .spacemenu block, next to .recentmenu), matching
// every other component here — the separate stylesheet only existed because
// index.css was owned by a parallel M5 ticket during the fan-out.

/**
 * Props for SpaceMenu — the named button + dropdown at the left edge of the
 * tab strip that switches between Spaces.
 *
 * Fully props-driven, no App state of its own, so wiring it into App.tsx
 * later is mechanical. Takes `Space` straight from the shared contract
 * (`src/shared/types.ts`) — `tabIds.length` is the tab count the
 * delete-confirm message names, no synthetic shape or `tabs.ts` import
 * needed.
 *
 * Invariant App must uphold: `activeSpaceId` must name a member of `spaces`
 * (or `spaces` may briefly be empty during a delete, before App re-picks
 * one). If it doesn't — a load in progress, or a delete whose caller hasn't
 * updated `activeSpaceId` yet — the trigger falls back to the generic label
 * "Space" and Rename/Delete render disabled rather than acting on nothing.
 * Picking the new active id after `onDelete` fires is App's job, same as
 * every other space-list mutation here: this component only reports intent.
 *
 * Rename and Delete act on the CURRENT space (`activeSpaceId`) — same as the
 * per-space "Rename"/"Close" the tab context menu already offers for the
 * current tab, not a picker over every space in the list.
 *
 * No "Save as…" / duplicate-space action: a tab is a member of exactly one
 * space (`Space.tabIds`), so there is no coherent "duplicate this space"
 * operation without a tab living in two spaces at once. "New empty space"
 * covers starting a second one.
 *
 * Does NOT implement the Ctrl+1..9 global shortcut; it renders the accelerator
 * LABELS only ("Ctrl+1" etc, via `acceleratorLabel`). The keydown listener is a
 * window-level concern and lives in App.tsx (KAN-45), matching on `spaceIndex`
 * and declining only for `isTextBox` (renderer/keys.ts). KAN-59: it fires while
 * a TERMINAL has focus, which it did not use to — the terminal's own job is just
 * to stop xterm sending the corresponding control byte (Terminal.tsx). The app's
 * address bar / search box / rename inputs still decline.
 */
export interface SpaceMenuProps {
  spaces: Space[]
  activeSpaceId: string
  onSwitch: (id: string) => void
  onCreate: (name: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  /** Pin / unpin a space (KAN-57). Gates exactly one operation — Delete — and
   *  says nothing at all about the space's TABS. */
  onTogglePin: (id: string, pinned: boolean) => void
  /** Set or clear (`undefined`) a space's ambient wash color (KAN-84/85). */
  onSetColor: (id: string, color: SpaceColor | undefined) => void
  /** What the delete confirm has to say about a space's tabs (KAN-57): the
   *  live-work risk of each, and how many are PINNED — a space delete closes
   *  those too, and the sentence has to admit it. App owns the join because
   *  `status` is keyed by ptyId, not by tab id; this component only renders the
   *  answer. */
  tabsOf: (spaceId: string) => { risks: CloseRisk[]; pinnedCount: number }
  /** Drop a dragged tab / group onto a space row (KAN-66) — the gesture people
   *  reach for before they find the context menu. The SAME App handlers the
   *  strip's "Move Tab to ▸" calls, so the confirm rule, the source-pane
   *  cleanup and the focus re-pick cannot drift between the two routes. */
  onMoveTab: (tabId: string, spaceId: string) => void
  onMoveGroup: (groupId: string, spaceId: string) => void
}

/** Is this drag something a space row can accept? `getData` is blocked during
 *  `dragover`, but `types` is readable — which is all the decision needs. */
const movable = (t: DataTransfer) => t.types.includes(TAB_MIME) || t.types.includes(GROUP_MIME)

export function SpaceMenu({
  spaces, activeSpaceId, onSwitch, onCreate, onRename, onDelete, onTogglePin, onSetColor, tabsOf,
  onMoveTab, onMoveGroup,
}: SpaceMenuProps) {
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const [addDraft, setAddDraft] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  // KAN-85: the space whose custom-color dialog is open, or null. Kept as an
  // id, not a boolean, so `active` (which can change under an open dropdown
  // exactly like `confirmDeleteId` above) is re-resolved on every render
  // rather than captured stale at the moment "Custom…" was clicked.
  const [customColorId, setCustomColorId] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLElement | null)[]>([])
  itemRefs.current = []
  const registerItem = (el: HTMLElement | null) => { if (el) itemRefs.current.push(el) }

  // Dedupe defensively: a duplicate id would otherwise produce duplicate
  // React keys and an autoFocus rename input on every matching row.
  const uniqueSpaces = spaces.filter((s, i) => spaces.findIndex((x) => x.id === s.id) === i)
  const active = uniqueSpaces.find((s) => s.id === activeSpaceId)

  const close = () => {
    setOpen(false)
    setRenaming(false)
    setAdding(false)
  }

  /**
   * SPRING-LOAD (KAN-66): hovering the switcher with a tab in hand opens it.
   *
   * Without this the drag gesture is unreachable, not merely awkward — the
   * dropdown closes on any outside `mousedown`, and the mousedown that starts a
   * tab drag is one, so a menu opened first is already shut before the drag
   * begins.
   *
   * A WINDOW listener testing GEOMETRY, not a React `onDragOver` on this
   * element, and that is the whole subtlety: TabBar TRANSLATES the dragged tab
   * to follow the pointer, so the thing under the cursor for the entire drag is
   * the tab itself. Every `dragover` therefore targets that tab and never
   * enters this subtree at all — measured, not assumed: `elementFromPoint` over
   * the trigger mid-drag returns `.tab-icon`. Events still BUBBLE to the
   * window, so a rect compare here sees what hit-testing cannot.
   *
   * (`pointer-events: none` on the dragged tab was the obvious alternative and
   * is a trap: it hangs Chromium's drag loop on Windows outright — the first
   * `mouse.move` after `mousedown` never returns.)
   *
   * The rect is the TRIGGER only: the open dropdown is absolutely positioned,
   * so it contributes nothing to this element's border box — and it hangs below
   * the strip, where the dragged tab (which is only ever translated on X) can
   * never cover a row. So the rows keep working by ordinary hit-testing.
   */
  useEffect(() => {
    const over = (e: DragEvent) => {
      const el = ref.current
      if (!el || open || !e.dataTransfer || !movable(e.dataTransfer)) return
      const r = el.getBoundingClientRect()
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom)
        setOpen(true)
    }
    window.addEventListener('dragover', over)
    return () => window.removeEventListener('dragover', over)
  }, [open])

  // Close on outside click — same approach as RecentMenu.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // On the outer container (not the dropdown) — opening the menu leaves
  // focus on the trigger button, a SIBLING of the dropdown, so a handler on
  // the dropdown alone never sees the keydown.
  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return
    if (e.key === 'Escape') { e.preventDefault(); close(); return }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const items = itemRefs.current
      const idx = items.indexOf(document.activeElement as HTMLElement)
      const next = nextFocusIndex(idx, e.key, items.length)
      if (next >= 0) items[next]?.focus()
    }
  }

  // Clicking another menu item while a rename/add input is focused would
  // otherwise blur the input first — committing it and closing the menu —
  // before the click on the sibling item ever lands. Suppressing the
  // browser's default focus-shift on mousedown skips that blur; the click
  // still fires normally. Input clicks (repositioning the caret) are exempt.
  const onDropdownMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).tagName !== 'INPUT') e.preventDefault()
  }

  const startRename = () => {
    if (!active) return
    setRenameDraft(active.name)
    setAdding(false)
    setRenaming(true)
  }
  const commitRename = () => {
    const name = renameDraft.trim()
    if (name && active) onRename(active.id, name)
    close()
  }

  const startAdd = () => {
    setAddDraft('')
    setRenaming(false)
    setAdding(true)
  }
  const commitAdd = () => {
    const name = addDraft.trim()
    if (name) onCreate(name)
    close()
  }

  return (
    <div
      className="spacemenu"
      ref={ref}
      onKeyDown={onMenuKeyDown}
      // What actually LICENSES a drop: a drop only fires where the preceding
      // dragover was defaultPrevented. This is the bubbling path from an open
      // dropdown's rows, which nothing covers (see the spring-load effect above
      // for why the TRIGGER needs a window listener instead).
      //
      // stopPropagation as well: this element is INSIDE `.tabbar`, whose own
      // dragover would otherwise read the pointer as a reorder and slide the
      // strip around under a menu the user is aiming at.
      onDragOver={(e) => {
        if (!movable(e.dataTransfer)) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
      }}
      // A drop that MISSES a row (the trigger button, the separator, the
      // New/Rename/Delete rows) is swallowed here rather than left to bubble:
      // `.tabbar`'s drop handler would otherwise commit a reorder using the
      // last insert index it computed before the pointer arrived over this menu.
      onDrop={(e) => {
        if (!movable(e.dataTransfer)) return
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <button
        className="spacemenu-btn"
        onClick={() => setOpen((o) => !o)}
        title={active?.name}
      >
        <span className="spacemenu-name">{active?.name ?? 'Space'}</span> ▾
      </button>

      {open && (
        <div className="spacemenu-dropdown" onMouseDown={onDropdownMouseDown}>
          <ul className="spacemenu-list">
            {uniqueSpaces.map((s, i) => (
              <li key={s.id}>
                {renaming && s.id === activeSpaceId ? (
                  <input
                    ref={(el) => registerItem(el)}
                    className="spacemenu-rename"
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                      if (e.key === 'Escape') { e.preventDefault(); close() }
                    }}
                  />
                ) : (
                  <button
                    ref={(el) => registerItem(el)}
                    className={s.id === activeSpaceId ? 'spacemenu-item active' : 'spacemenu-item'}
                    onClick={() => { onSwitch(s.id); close() }}
                    // KAN-66: the row is the drop target. Only the drop is
                    // handled here — the container above already accepts the
                    // dragover for the whole menu, so a row inherits it and the
                    // highlight it gives is the button's own `:hover`.
                    //
                    // Note what does NOT happen: `onSwitch`. Dropping a tab into
                    // another space is not a request to go and look at it.
                    onDrop={(e) => {
                      const tabId = e.dataTransfer.getData(TAB_MIME)
                      const groupId = e.dataTransfer.getData(GROUP_MIME)
                      if (!tabId && !groupId) return
                      e.preventDefault()
                      e.stopPropagation()
                      if (tabId) onMoveTab(tabId, s.id)
                      else onMoveGroup(groupId, s.id)
                      close()
                    }}
                  >
                    <span className="spacemenu-check">{s.id === activeSpaceId ? '✓' : ''}</span>
                    <span className="spacemenu-item-name" title={s.name}>{s.name}</span>
                    {acceleratorLabel(i) && <span className="spacemenu-accel">{acceleratorLabel(i)}</span>}
                  </button>
                )}
              </li>
            ))}
          </ul>

          <div className="spacemenu-sep" />

          <ul className="spacemenu-list">
            <li>
              {adding ? (
                <input
                  ref={(el) => registerItem(el)}
                  className="spacemenu-rename"
                  autoFocus
                  value={addDraft}
                  placeholder="Space name"
                  onChange={(e) => setAddDraft(e.target.value)}
                  onBlur={commitAdd}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); commitAdd() }
                    if (e.key === 'Escape') { e.preventDefault(); close() }
                  }}
                />
              ) : (
                <button ref={(el) => registerItem(el)} className="spacemenu-item" onClick={startAdd}>
                  New empty space
                </button>
              )}
            </li>
            <li>
              <button
                ref={(el) => registerItem(el)}
                className="spacemenu-item"
                onClick={startRename}
                disabled={!active}
              >
                Rename
              </button>
            </li>
            {active && (
              <li>
                <button
                  ref={(el) => registerItem(el)}
                  className="spacemenu-item"
                  onClick={() => { onTogglePin(active.id, !active.pinned); close() }}
                >
                  {active.pinned ? 'Unpin space' : 'Pin space'}
                </button>
              </li>
            )}
            {/* KAN-84/85: the existing ContextMenu swatch pattern (TabBar.tsx's
                group recolor menu / ContextMenu.tsx), reused verbatim as a hover
                submenu nested in THIS dropdown rather than a second floating
                menu — a second `.ctx-backdrop` here would fight this dropdown's
                own z-index for no benefit. Not registered with `registerItem`
                (unlike every other row): like TabBar's own ContextMenu
                submenus, this is a hover-only affordance with no arrow-key
                traversal, so it must not eat a slot in the ArrowUp/ArrowDown
                cycle with nothing for Enter to do. */}
            {active && (
              <li className="ctx-item ctx-sub">
                Color
                <span className="ctx-caret">▸</span>
                <ul className="ctx-menu">
                  {GROUP_COLORS.map((c, i) => (
                    <li key={c} className="ctx-item" onClick={() => { onSetColor(active.id, c); close() }}>
                      <span className="ctx-swatch" style={{ background: c }} />
                      {COLOR_NAMES[i] ?? `Color ${i + 1}`}
                    </li>
                  ))}
                  <li className="ctx-sep" />
                  <li className="ctx-item" onClick={() => { setCustomColorId(active.id); close() }}>
                    Custom…
                  </li>
                  {active.color !== undefined && (
                    <li className="ctx-item" onClick={() => { onSetColor(active.id, undefined); close() }}>
                      No color
                    </li>
                  )}
                </ul>
              </li>
            )}
            {active && canDeleteSpace(uniqueSpaces.length, active.pinned) && (
              <li>
                <button
                  ref={(el) => registerItem(el)}
                  className="spacemenu-item"
                  onClick={() => { setConfirmDeleteId(active.id); close() }}
                >
                  Delete
                </button>
              </li>
            )}
          </ul>
        </div>
      )}

      {/* The shared ConfirmDialog (KAN-57), not a fourth hand-rolled
          `.modal-backdrop`. `target` is resolved on every render, so a space
          deleted or renamed underneath this modal is reflected in it — and a
          space that has gone entirely renders nothing at all, rather than
          leaving a dialog naming something that no longer exists. */}
      {confirmDeleteId && (() => {
        const target = uniqueSpaces.find((s) => s.id === confirmDeleteId)
        if (!target) return null
        const { risks, pinnedCount } = tabsOf(target.id)
        return (
          <ConfirmDialog
            request={{
              reason: deleteSpaceReason(target.name, target.tabIds.length, risks, pinnedCount),
              confirmLabel: 'Delete',
              confirm: () => {
                // Re-check: the menu item that opens this modal is gated on
                // canDeleteSpace too, but `spaces` can shrink to 1 — or this
                // space can be pinned — while the modal is still open (another
                // path acting concurrently). Never delete the last one, and
                // never one the user has since pinned.
                if (canDeleteSpace(uniqueSpaces.length, target.pinned)) onDelete(target.id)
              },
            }}
            onClose={() => setConfirmDeleteId(null)}
          />
        )
      })()}

      {/* KAN-85. Same "resolve the target fresh on every render" discipline as
          the delete confirm above: a space renamed or deleted while this is
          open is reflected (or, if it's gone, the dialog simply stops
          rendering) rather than acting on a stale snapshot. */}
      {customColorId && (() => {
        const target = uniqueSpaces.find((s) => s.id === customColorId)
        if (!target) return null
        return (
          <SpaceColorPicker
            initial={typeof target.color === 'object' ? target.color : undefined}
            onApply={(color) => { onSetColor(target.id, color); setCustomColorId(null) }}
            onCancel={() => setCustomColorId(null)}
          />
        )
      })()}
    </div>
  )
}
