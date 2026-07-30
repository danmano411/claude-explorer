import { useEffect, useRef, useState } from 'react'
import { acceleratorLabel, canDeleteSpace } from './SpaceMenu'
import './SpaceMenu.css'

/**
 * Props for SpaceMenu — the named button + dropdown at the left edge of the
 * tab strip that switches between Spaces.
 *
 * Fully props-driven, no App state of its own, so wiring it into App.tsx
 * later is mechanical. `tabCount` on each space is what the delete-confirm
 * message names ("Delete «M4 work» and close its 5 tabs?"); it's carried
 * per-space rather than looked up elsewhere because this component must not
 * import tabs.ts (owned by another M5 ticket this milestone).
 *
 * Rename and Delete act on the CURRENT space (`activeSpaceId`) — same as the
 * per-space "Rename"/"Close" the tab context menu already offers for the
 * current tab, not a picker over every space in the list.
 *
 * Does NOT implement the Ctrl+1..9 global shortcut — see integration note in
 * the file's task description. This component renders the accelerator
 * LABELS only ("Ctrl+1" etc, via `acceleratorLabel`); wiring the actual
 * keydown listener is a window-level concern for the integrator, who must
 * make it not fire while a terminal / address bar / search overlay / rename
 * input has focus (a terminal needs to receive Ctrl+1 itself).
 */
export interface SpaceMenuProps {
  spaces: { id: string; name: string; tabCount: number }[]
  activeSpaceId: string
  onSwitch: (id: string) => void
  onCreate: (name: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  onSaveAs: (name: string) => void
}

export function SpaceMenu({
  spaces, activeSpaceId, onSwitch, onCreate, onRename, onDelete, onSaveAs,
}: SpaceMenuProps) {
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [adding, setAdding] = useState<'new' | 'saveas' | null>(null)
  const [addDraft, setAddDraft] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLElement | null)[]>([])
  itemRefs.current = []
  const registerItem = (el: HTMLElement | null) => { if (el) itemRefs.current.push(el) }

  const active = spaces.find((s) => s.id === activeSpaceId)

  const close = () => {
    setOpen(false)
    setRenaming(false)
    setAdding(null)
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

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const items = itemRefs.current
      if (items.length === 0) return
      let idx = items.indexOf(document.activeElement as HTMLElement)
      idx = e.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length
      items[idx]?.focus()
    }
  }

  const startRename = () => {
    if (!active) return
    setRenameDraft(active.name)
    setAdding(null)
    setRenaming(true)
  }
  const commitRename = () => {
    const name = renameDraft.trim()
    if (name && active) onRename(active.id, name)
    close()
  }

  const startAdd = (mode: 'new' | 'saveas') => {
    setAddDraft('')
    setRenaming(false)
    setAdding(mode)
  }
  const commitAdd = () => {
    const name = addDraft.trim()
    if (name) (adding === 'new' ? onCreate : onSaveAs)(name)
    close()
  }

  return (
    <div className="spacemenu" ref={ref}>
      <button
        className="spacemenu-btn"
        onClick={() => setOpen((o) => !o)}
        title={active?.name}
      >
        <span className="spacemenu-name">{active?.name ?? 'Space'}</span> ▾
      </button>

      {open && (
        <div className="spacemenu-dropdown" onKeyDown={onMenuKeyDown}>
          <ul className="spacemenu-list">
            {spaces.map((s, i) => (
              <li key={s.id}>
                {renaming && s.id === activeSpaceId ? (
                  <input
                    ref={(el) => registerItem(el)}
                    className="spacemenu-rename"
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
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
              {adding === 'saveas' ? (
                <input
                  ref={(el) => registerItem(el)}
                  className="spacemenu-rename"
                  autoFocus
                  value={addDraft}
                  placeholder="Space name"
                  onChange={(e) => setAddDraft(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={commitAdd}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); commitAdd() }
                    if (e.key === 'Escape') { e.preventDefault(); close() }
                  }}
                />
              ) : (
                <button ref={(el) => registerItem(el)} className="spacemenu-item" onClick={() => startAdd('saveas')}>
                  Save as…
                </button>
              )}
            </li>
            <li>
              {adding === 'new' ? (
                <input
                  ref={(el) => registerItem(el)}
                  className="spacemenu-rename"
                  autoFocus
                  value={addDraft}
                  placeholder="Space name"
                  onChange={(e) => setAddDraft(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={commitAdd}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); commitAdd() }
                    if (e.key === 'Escape') { e.preventDefault(); close() }
                  }}
                />
              ) : (
                <button ref={(el) => registerItem(el)} className="spacemenu-item" onClick={() => startAdd('new')}>
                  New empty space
                </button>
              )}
            </li>
            <li>
              <button ref={(el) => registerItem(el)} className="spacemenu-item" onClick={startRename}>
                Rename
              </button>
            </li>
            {canDeleteSpace(spaces.length) && (
              <li>
                <button
                  ref={(el) => registerItem(el)}
                  className="spacemenu-item"
                  onClick={() => { if (active) setConfirmDeleteId(active.id); close() }}
                >
                  Delete
                </button>
              </li>
            )}
          </ul>
        </div>
      )}

      {confirmDeleteId && (() => {
        const target = spaces.find((s) => s.id === confirmDeleteId)
        if (!target) return null
        return (
          <div className="modal-backdrop" onClick={() => setConfirmDeleteId(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <p>Delete «{target.name}» and close its {target.tabCount} tab{target.tabCount === 1 ? '' : 's'}?</p>
              <div className="modal-actions">
                <button onClick={() => setConfirmDeleteId(null)}>Cancel</button>
                <button
                  className="danger"
                  onClick={() => { onDelete(target.id); setConfirmDeleteId(null) }}
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
