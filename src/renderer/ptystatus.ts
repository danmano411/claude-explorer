import { useEffect, useRef, useState } from 'react'
import type { PtyStatus } from '../shared/types'

export const IDLE_MS = 700

type Event = { id: string; kind: 'data' | 'idle' | 'exit' }

// Pure transition. Returns the SAME map reference when nothing changes so the
// hook can skip re-rendering on the (very frequent) data events.
export function applyEvent(prev: Map<string, PtyStatus>, ev: Event): Map<string, PtyStatus> {
  const cur = prev.get(ev.id)
  if (cur === 'stopped') return prev // terminal state
  const next: PtyStatus | undefined =
    ev.kind === 'exit' ? 'stopped' : ev.kind === 'data' ? 'running' : 'waiting'
  if (next === cur) return prev
  const m = new Map(prev)
  m.set(ev.id, next!)
  return m
}

export function usePtyStatus(): Map<string, PtyStatus> {
  const [map, setMap] = useState<Map<string, PtyStatus>>(new Map())
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    const bump = (id: string) => {
      const t = timers.current.get(id)
      if (t) clearTimeout(t)
      timers.current.set(id, setTimeout(() => setMap((m) => applyEvent(m, { id, kind: 'idle' })), IDLE_MS))
    }
    const offData = window.api.onPtyData((id) => {
      setMap((m) => applyEvent(m, { id, kind: 'data' }))
      bump(id)
    })
    const offExit = window.api.onPtyExit((id) => {
      const t = timers.current.get(id)
      if (t) { clearTimeout(t); timers.current.delete(id) }
      setMap((m) => applyEvent(m, { id, kind: 'exit' }))
    })
    return () => {
      offData(); offExit()
      timers.current.forEach(clearTimeout); timers.current.clear()
    }
  }, [])

  return map
}
