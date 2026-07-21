import type { DirEntry, RecentFolder, ClaudeSession, TrashRecord } from './types'

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
  // --- v2 file operations ---
  fsRename: 'fs:rename',
  fsMkdir: 'fs:mkdir',
  fsNewFile: 'fs:newFile',
  fsCopy: 'fs:copy', // returns final dest path (after collision resolution)
  fsMove: 'fs:move', // returns final dest path
  fsDelete: 'fs:delete', // -> TrashRecord[]
  fsRestore: 'fs:restore', // TrashRecord[] -> void
  fsExists: 'fs:exists',
  openPath: 'shell:openPath',
  revealPath: 'shell:reveal',
  recentsRemove: 'recents:remove',
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
  // --- v2 file operations ---
  fsRename(from: string, to: string): Promise<void>
  fsMkdir(path: string): Promise<string> // returns created dir path (collision-resolved)
  fsNewFile(path: string): Promise<string> // returns created file path (collision-resolved)
  fsCopy(src: string, destDir: string): Promise<string> // returns final path
  fsMove(src: string, destDir: string): Promise<string> // returns final path
  fsDelete(paths: string[]): Promise<TrashRecord[]>
  fsRestore(records: TrashRecord[]): Promise<void>
  fsExists(path: string): Promise<boolean>
  openPath(path: string): Promise<void>
  revealPath(path: string): Promise<void>
  recentsRemove(path: string): Promise<void>
}
