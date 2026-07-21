export interface History { back: string[]; current: string; forward: string[] }
export const initHistory = (path: string): History => ({ back: [], current: path, forward: [] })
export const canBack = (h: History) => h.back.length > 0
export const canForward = (h: History) => h.forward.length > 0
export function navigate(h: History, path: string): History {
  if (path === h.current) return h
  return { back: [...h.back, h.current], current: path, forward: [] }
}
export function goBack(h: History): History {
  if (!canBack(h)) return h
  const prev = h.back[h.back.length - 1]
  return { back: h.back.slice(0, -1), current: prev, forward: [h.current, ...h.forward] }
}
export function goForward(h: History): History {
  if (!canForward(h)) return h
  const next = h.forward[0]
  return { back: [...h.back, h.current], current: next, forward: h.forward.slice(1) }
}
