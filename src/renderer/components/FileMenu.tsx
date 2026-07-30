import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ClaudeSession, RecentFolder } from '../../shared/types'
import { nextFocusIndex } from '../spacemenu'
import { relTime, topSessions } from '../filemenu'
// Styles live in index.css (the .filemenu block, where .recentmenu used to be).

/**
 * The File menu — the tab strip's top-left button, sitting beside the spaces
 * switcher (KAN-54). It replaces the standalone "Open Recent ▾" button, which
 * read badly as a second dropdown next to the one KAN-45 put there.
 *
 * Three levels, and only three:
 *
 *   File ▾
 *     New Tab
 *     Open Recent ▸   C:\repo\claude-explorer ▸   fix the tab strip alignment  2h ago
 *
 * Deliberately NOT a general menu framework, and deliberately not built on
 * ContextMenu: that component is a right-click backdrop menu positioned at a
 * click point with a flat `MenuItem[]`, and giving it nesting would have meant
 * a recursive item type and a hover state machine for the sake of one caller.
 * This is a dropdown, like SpaceMenu, so it is shaped like SpaceMenu.
 *
 * Interaction model — one code path for mouse and keyboard: **hover focuses,
 * focus opens**. A row's flyout opens when the row takes focus, and hovering a
 * row focuses it, so there is a single `onFocus` per level rather than a
 * hover-state machine plus a parallel keyboard one.
 *
 * The two verbs a project row has are split the way the ticket asks for:
 * activating it (click or Enter — a `<button>`, so those are the same event)
 * opens a FILE tab on the folder, exactly as Open Recent does today, while
 * ArrowRight steps into the sessions flyout that focusing the row already
 * opened. Escape/ArrowLeft walks back out one level and closes the whole menu
 * at the top.
 *
 * Sessions are fetched only when a project's flyout opens — `sessions:list`
 * reads and parses every jsonl in `~/.claude/projects/<slug>`, so doing it for
 * a dozen recents on menu-open would stall the click.
 */
export interface FileMenuProps {
  onNewTab: () => void
  onOpenFolder: (path: string) => void
  /** `resumeId` omitted means "start a fresh session" — the New session row
   *  below calls this with no second argument, same as the old RecentMenu's
   *  `New` button did (KAN-54 review: that action was dropped by omission). */
  onOpenSession: (path: string, resumeId?: string) => void
}

/**
 * A cascading flyout, positioned in viewport coordinates off its parent row.
 *
 * `position: fixed` rather than `absolute` for two reasons at once: it flips to
 * the row's left when opening rightward would run off screen, and it escapes
 * the parent flyout's `overflow-y: auto` — a nested absolute child of a
 * scrollable box gets clipped on BOTH axes (an `overflow-y` that isn't
 * `visible` forces `overflow-x` to compute to `auto`), which would have sliced
 * the sessions flyout off at the recents list's edge.
 *
 * The measurement is taken from the ROW, not from the flyout: the row does not
 * move when the flyout is repositioned, so the effect is idempotent. Measuring
 * the flyout's own right edge would flip it back on the next pass and oscillate.
 */
function Flyout({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    const row = el?.parentElement
    if (!el || !row) return
    const r = row.getBoundingClientRect()
    const w = el.offsetWidth
    const h = el.offsetHeight
    const flip = r.right + w > window.innerWidth - 4
    const left = flip ? Math.max(4, r.left - w) : r.right
    const top = Math.min(Math.max(4, r.top - 4), Math.max(4, window.innerHeight - h - 4))
    // No dependency array — content arrives asynchronously (the lazy session
    // fetch) and changes the box. Bail out when nothing moved or this re-render
    // loops forever on a fresh object identity.
    setPos((p) => (p && p.left === left && p.top === top ? p : { left, top }))
  })

  // Resizing the window, and scrolling a long recents list, both move the row
  // without changing the React tree — so nothing above would re-run and a fixed
  // flyout would sit where the row used to be. Snapping a window while a menu is
  // open is a normal Windows gesture, not a contrived one. Dropping the position
  // back to null re-enters the measure pass on the next render.
  useEffect(() => {
    const remeasure = () => setPos(null)
    window.addEventListener('resize', remeasure)
    document.addEventListener('scroll', remeasure, true) // capture: scroll doesn't bubble
    return () => {
      window.removeEventListener('resize', remeasure)
      document.removeEventListener('scroll', remeasure, true)
    }
  }, [])

  return (
    <div
      ref={ref}
      className="filemenu-flyout"
      // Rendered off-screen-invisible for exactly one layout pass so it can be
      // measured. useLayoutEffect runs before paint, so nothing flickers.
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      {children}
    </div>
  )
}

export function FileMenu({ onNewTab, onOpenFolder, onOpenSession }: FileMenuProps) {
  const [open, setOpen] = useState(false)
  const [recents, setRecents] = useState<RecentFolder[]>([])
  const [recentOpen, setRecentOpen] = useState(false)
  /** Path of the project whose sessions flyout is open, or null. */
  const [project, setProject] = useState<string | null>(null)
  /** null while the lazy fetch for `project` is in flight. */
  const [sessions, setSessions] = useState<ClaudeSession[] | null>(null)

  const ref = useRef<HTMLDivElement>(null)
  /** Newest requested project — an older, slower sessions:list must not win. */
  const pending = useRef<string | null>(null)
  /** Set while we move focus ourselves, so the onFocus handlers don't reopen
   *  the flyout Escape/ArrowLeft just closed. `focus()` dispatches synchronously,
   *  so clearing it on the next line is safe. */
  const silent = useRef(false)

  const focusSilently = (el: HTMLElement | null | undefined) => {
    silent.current = true
    el?.focus()
    silent.current = false
  }

  const closeSessions = () => { setProject(null); setSessions(null); pending.current = null }
  const closeRecent = () => { setRecentOpen(false); closeSessions() }
  const close = () => { setOpen(false); closeRecent() }

  const toggle = async () => {
    if (open) return close()
    setOpen(true)
    setRecents(await window.api.recentsList())
  }

  const openSessions = async (path: string) => {
    if (silent.current || project === path) return
    setProject(path)
    setSessions(null)
    pending.current = path
    const list = await window.api.sessionsList(path)
    if (pending.current === path) setSessions(list)
  }

  // Close when clicking anywhere outside the menu — same approach as SpaceMenu.
  // The flyouts are fixed-positioned but still DOM children here, so `contains`
  // covers the whole chain without a portal.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const rowsAt = (lvl: number) =>
    Array.from(ref.current?.querySelectorAll<HTMLElement>(`[data-lvl="${lvl}"]`) ?? [])

  /** Escape / ArrowLeft: shut the deepest level and put focus back on its parent. */
  const back = (lvl: number) => {
    if (lvl >= 3) {
      const row = rowsAt(2).find((el) => el.dataset.path === project)
      closeSessions()
      focusSilently(row)
      return
    }
    if (lvl === 2) {
      const parent = ref.current?.querySelector<HTMLElement>('[data-sub="recent"]')
      closeRecent()
      focusSilently(parent)
      return
    }
    close()
    focusSilently(ref.current?.querySelector<HTMLElement>('.filemenu-btn'))
  }

  // On the outer container, not the dropdown: opening the menu leaves focus on
  // the trigger button, a SIBLING of the dropdown (SpaceMenu's note applies).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return
    const el = document.activeElement as HTMLElement | null
    const lvl = Number(el?.dataset?.lvl ?? 0) // 0 = the trigger button itself

    if (e.key === 'Escape' || e.key === 'ArrowLeft') {
      e.preventDefault()
      back(lvl)
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const rows = rowsAt(lvl || 1)
      // lvl 0 means focus is still on the trigger: -1 sends ArrowDown to the
      // first row and ArrowUp to the last, rather than wrapping off by one.
      const next = nextFocusIndex(lvl ? rows.indexOf(el!) : -1, e.key, rows.length)
      if (next >= 0) rows[next]?.focus()
      return
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      // Focusing the row already opened its flyout; this only has to step in.
      rowsAt(lvl + 1)[0]?.focus()
    }
  }

  return (
    <div className="filemenu" ref={ref} onKeyDown={onKeyDown}>
      <button className="filemenu-btn" onClick={toggle} aria-haspopup="menu" aria-expanded={open}>
        File ▾
      </button>

      {open && (
        <div className="filemenu-dropdown">
          <ul className="filemenu-list">
            <li className="filemenu-row">
              <button
                className="filemenu-item"
                data-lvl="1"
                onMouseEnter={(e) => e.currentTarget.focus()}
                onFocus={() => { if (!silent.current) closeRecent() }}
                onClick={() => { onNewTab(); close() }}
              >
                <span className="filemenu-label">New Tab</span>
              </button>
            </li>

            <li className="filemenu-row">
              <button
                className="filemenu-item"
                data-lvl="1"
                data-sub="recent"
                aria-haspopup="menu"
                aria-expanded={recentOpen}
                onMouseEnter={(e) => e.currentTarget.focus()}
                onFocus={() => { if (!silent.current) setRecentOpen(true) }}
                onClick={() => setRecentOpen(true)}
              >
                <span className="filemenu-label">Open Recent</span>
                <span className="filemenu-arrow">▸</span>
              </button>

              {recentOpen && (
                <Flyout>
                  <ul className="filemenu-list filemenu-projects">
                    {recents.length === 0 && <li className="filemenu-empty">No recent folders</li>}
                    {recents.map((r) => (
                      <li className="filemenu-row" key={r.path}>
                        <button
                          className="filemenu-item filemenu-project"
                          data-lvl="2"
                          data-path={r.path}
                          title={r.path}
                          aria-haspopup="menu"
                          aria-expanded={project === r.path}
                          onMouseEnter={(e) => e.currentTarget.focus()}
                          onFocus={() => openSessions(r.path)}
                          onClick={() => { onOpenFolder(r.path); close() }}
                        >
                          <span className="filemenu-label">{r.path}</span>
                          <span className="filemenu-arrow">▸</span>
                        </button>
                        {/* Reachable by Tab and by mouse, but not on the arrow
                            path: `data-lvl` is what ArrowUp/Down walks, and
                            doubling every project row with a destructive
                            neighbour would make the list twice as long to
                            traverse for the action nobody came here for. */}
                        <button
                          className="filemenu-x"
                          title="Remove from recent"
                          onClick={async (e) => {
                            e.stopPropagation()
                            await window.api.recentsRemove(r.path)
                            setRecents(await window.api.recentsList())
                            if (project === r.path) closeSessions()
                          }}
                        >
                          ×
                        </button>

                        {project === r.path && (
                          <Flyout>
                            <ul className="filemenu-list filemenu-sessions">
                              {/* Always first, regardless of load state — starting a
                                  fresh session doesn't depend on what sessions:list
                                  returns. Same data-lvl as the rows below it so
                                  ArrowRight/Up/Down treat it as an ordinary row. */}
                              <li className="filemenu-row">
                                <button
                                  className="filemenu-item filemenu-newsession"
                                  data-lvl="3"
                                  onMouseEnter={(e) => e.currentTarget.focus()}
                                  onClick={() => { onOpenSession(r.path); close() }}
                                >
                                  <span className="filemenu-label">＋ New session</span>
                                </button>
                              </li>
                              <li className="filemenu-sep" aria-hidden />
                              {sessions === null && <li className="filemenu-empty">Loading…</li>}
                              {sessions?.length === 0 && <li className="filemenu-empty">No sessions</li>}
                              {sessions && topSessions(sessions).map((s) => (
                                <li className="filemenu-row" key={s.id}>
                                  <button
                                    className="filemenu-item filemenu-session"
                                    data-lvl="3"
                                    data-session={s.id}
                                    title={s.title}
                                    onMouseEnter={(e) => e.currentTarget.focus()}
                                    onClick={() => { onOpenSession(r.path, s.id); close() }}
                                  >
                                    <span className="filemenu-label">{s.title}</span>
                                    <span className="filemenu-time">{relTime(s.updated)}</span>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          </Flyout>
                        )}
                      </li>
                    ))}
                  </ul>
                </Flyout>
              )}
            </li>
          </ul>
        </div>
      )}
    </div>
  )
}
