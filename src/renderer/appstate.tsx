import { createContext, useContext, useRef, useState, useCallback, type ReactNode } from 'react'
import { UndoStack } from './undo'

export type Clipboard = { mode: 'cut' | 'copy'; paths: string[] } | null
export type DragPayload = { paths: string[]; sourceTabId: string } | null

export interface AppState {
  clipboard: Clipboard
  setClipboard(c: Clipboard): void
  drag: DragPayload
  setDrag(d: DragPayload): void
  isBusy(path: string): boolean
  withGuard<T>(paths: string[], fn: () => Promise<T>): Promise<T>
  undo: UndoStack
}

const AppStateContext = createContext<AppState | null>(null)

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [clipboard, setClipboard] = useState<Clipboard>(null)
  const [drag, setDrag] = useState<DragPayload>(null)
  const busyRef = useRef<Set<string>>(new Set())
  const undoRef = useRef<UndoStack>(new UndoStack(100))

  const isBusy = useCallback((path: string) => busyRef.current.has(path), [])

  const withGuard = useCallback(async <T,>(paths: string[], fn: () => Promise<T>): Promise<T> => {
    if (paths.some((p) => busyRef.current.has(p))) throw new Error('busy')
    paths.forEach((p) => busyRef.current.add(p))
    try {
      return await fn()
    } finally {
      paths.forEach((p) => busyRef.current.delete(p))
    }
  }, [])

  const value: AppState = {
    clipboard,
    setClipboard,
    drag,
    setDrag,
    isBusy,
    withGuard,
    undo: undoRef.current,
  }

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>
}

export function useAppState(): AppState {
  const ctx = useContext(AppStateContext)
  if (!ctx) throw new Error('useAppState must be used within AppStateProvider')
  return ctx
}
