import type { DirEntry, RecentFolder, ClaudeSession } from './types'

export const CH = {
  fsList: 'fs:list',
  fsHome: 'fs:home',
  recentsList: 'recents:list',
  recentsAdd: 'recents:add',
  sessionsList: 'sessions:list',
  externalOpen: 'external:open',
  ptySpawn: 'pty:spawn',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyKill: 'pty:kill',
  ptyData: 'pty:data', // main -> renderer event
  ptyExit: 'pty:exit', // main -> renderer event
} as const

// invoke (renderer -> main -> Promise) signatures
export interface Api {
  fsList(path: string): Promise<DirEntry[]>
  fsHome(): Promise<string>
  recentsList(): Promise<RecentFolder[]>
  recentsAdd(path: string): Promise<void>
  sessionsList(path: string): Promise<ClaudeSession[]>
  externalOpen(path: string): Promise<void>
  ptySpawn(opts: { path: string; resumeId?: string }): Promise<string> // returns ptyId
  ptyWrite(ptyId: string, data: string): void
  ptyResize(ptyId: string, cols: number, rows: number): void
  ptyKill(ptyId: string): void
  onPtyData(cb: (ptyId: string, data: string) => void): () => void // returns unsubscribe
  onPtyExit(cb: (ptyId: string, code: number) => void): () => void
}
