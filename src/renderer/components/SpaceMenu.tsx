import { useEffect, useRef, useState } from 'react'
import type { Space } from '../../shared/types'
import { acceleratorLabel, canDeleteSpace, nextFocusIndex } from '../spacemenu'
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
 * window-level concern and lives in App.tsx (KAN-45), guarded by
 * `isTypingTarget` (renderer/keys.ts) so it never fires while a terminal /
 * address bar / search overlay / rename input has focus — a terminal needs to
 * receive Ctrl+1 itself.
 */
export interface SpaceMenuProps {
  spaces: Space[]
  activeSpaceId: string
  onSwitch: (id: string) => void
  onCreate: (name: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
}

export function SpaceMenu({
  spaces, activeSpaceId, onSwitch, onCreate, onRename, onDelete,
}: SpaceMenuProps) {
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const [addDraft, setAddDraft] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
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
    <div className="spacemenu" ref={ref} onKeyDown={onMenuKeyDown}>
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
            {active && canDeleteSpace(uniqueSpaces.length) && (
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

      {confirmDeleteId && (() => {
        const target = uniqueSpaces.find((s) => s.id === confirmDeleteId)
        if (!target) return null
        const count = target.tabIds.length
        return (
          <div className="modal-backdrop" onClick={() => setConfirmDeleteId(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <p>Delete «{target.name}» and close its {count} tab{count === 1 ? '' : 's'}?</p>
              <div className="modal-actions">
                <button onClick={() => setConfirmDeleteId(null)}>Cancel</button>
                <button
                  className="danger"
                  onClick={() => {
                    // Re-check: the menu item that opens this modal is
                    // gated on canDeleteSpace too, but `spaces` can shrink
                    // to 1 while the modal is still open (another tab/IPC
                    // path deletes concurrently) — never delete the last one.
                    if (canDeleteSpace(uniqueSpaces.length)) onDelete(target.id)
                    setConfirmDeleteId(null)
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
