import { useState, useRef, useEffect } from 'react'
import type { RecentFolder, ClaudeSession } from '../../shared/types'

const SESSIONS_PREVIEW = 3

export function RecentMenu({ onOpen, onOpenFolder }: {
  onOpen: (path: string, resumeId?: string) => void
  onOpenFolder: (path: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [recents, setRecents] = useState<RecentFolder[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [sessions, setSessions] = useState<ClaudeSession[]>([])
  const [showAll, setShowAll] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const close = () => {
    setOpen(false)
    setExpanded(null)
    setShowAll(false)
  }

  const toggle = async () => {
    if (open) return close()
    setRecents(await window.api.recentsList())
    setOpen(true)
  }

  // Sessions button toggles the list open/closed for a folder.
  const toggleSessions = async (path: string) => {
    if (expanded === path) {
      setExpanded(null)
      return
    }
    setShowAll(false)
    setExpanded(path)
    setSessions(await window.api.sessionsList(path))
  }

  // Close when clicking anywhere outside the menu.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const shown = showAll ? sessions : sessions.slice(0, SESSIONS_PREVIEW)

  return (
    <div className="recentmenu" ref={ref}>
      <button onClick={toggle}>Open Recent ▾</button>
      {open && (
        <ul className="recent-list">
          {recents.length === 0 && <li className="empty">No recent folders</li>}
          {recents.map((r) => (
            <li key={r.path}>
              <div className="recent-row">
                <span onClick={() => { onOpenFolder(r.path); close() }}>{r.name}</span>
                <button onClick={() => { onOpen(r.path); close() }}>New</button>
                <button
                  className={expanded === r.path ? 'active' : ''}
                  onClick={() => toggleSessions(r.path)}
                >
                  Sessions
                </button>
              </div>
              {expanded === r.path && (
                <ul className="session-list">
                  {sessions.length === 0 && <li className="empty">No sessions</li>}
                  {shown.map((s) => (
                    <li key={s.id} onClick={() => { onOpen(r.path, s.id); close() }}>
                      {s.title} <span className="ts">{new Date(s.updated).toLocaleString()}</span>
                    </li>
                  ))}
                  {!showAll && sessions.length > SESSIONS_PREVIEW && (
                    <li
                      className="show-more"
                      onClick={(e) => { e.stopPropagation(); setShowAll(true) }}
                    >
                      Show {sessions.length - SESSIONS_PREVIEW} more…
                    </li>
                  )}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
