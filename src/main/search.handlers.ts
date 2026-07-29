import { ipcMain, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { CH } from '../shared/ipc'
import { runSearch, warmRg, type RunningSearch } from './search'
import type { SearchQuery } from '../shared/types'

export function registerSearchHandlers(getWindow: () => BrowserWindow | null) {
  const send = (ch: string, ...args: unknown[]) => getWindow()?.webContents.send(ch, ...args)

  // Pay the antivirus first-run cost now, not on the user's first search.
  warmRg()

  // At most one search runs at a time. Starting another supersedes it — the user
  // typed something new, and the old walk over a 50k-file tree is dead weight.
  let live: { id: string; run: RunningSearch } | null = null

  const stop = () => {
    live?.run.cancel()
    live = null
  }

  ipcMain.handle(CH.searchStart, (_e, q: SearchQuery) => {
    stop()
    const id = randomUUID()
    const run = runSearch(
      q,
      (hits) => { if (live?.id === id) send(CH.searchHits, id, hits) },
      (done) => {
        if (live?.id !== id) return // superseded; its 'cancelled' is not news
        live = null
        send(CH.searchDone, id, done)
      },
    )
    live = { id, run }
    return id
  })

  ipcMain.on(CH.searchCancel, (_e, id: string) => {
    if (live?.id === id) stop()
  })

  // A reload would otherwise strand a running rg process with no listener.
  return () => stop()
}
