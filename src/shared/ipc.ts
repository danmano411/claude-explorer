import type {
  RecentFolder,
  ClaudeSession,
  TrashRecord,
  Settings,
  OpResult,
  ListResult,
  ReadResult,
  GitStatusResult,
  SearchHit,
  SearchQuery,
  SearchDone,
  Workspace,
  TrashWarn,
} from './types'

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
  trashWarn: 'trash:warn', // main -> renderer event: a flush (startup sweep or quit) couldn't reach the Recycle Bin
  fsExists: 'fs:exists',
  openPath: 'shell:openPath',
  revealPath: 'shell:reveal',
  recentsRemove: 'recents:remove',
  ideOpen: 'ide:open',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  menuCommand: 'menu:command', // main -> renderer event (File/Settings menu items)
  // --- M2 viewer + diff (read-only) ---
  fsRead: 'fs:read',
  gitStatus: 'git:status',
  gitDiff: 'git:diff',
  // --- M3 search. A stream, not a request/response: ripgrep emits matches
  // progressively over seconds on a large tree, and the overlay shows them as
  // they land. Cancellation is part of the contract, not an afterthought —
  // every keystroke supersedes a child process that may still be walking.
  searchStart: 'search:start',
  searchCancel: 'search:cancel',
  searchHits: 'search:hits', // main -> renderer event (batched)
  searchDone: 'search:done', // main -> renderer event
  // --- M5 workspace: spaces, tab folders, split layouts. Whole-document
  // read/write like settings, not per-entity CRUD — the renderer already holds
  // the authoritative tree in React state, and a document write cannot leave
  // groups referencing tabs that no longer exist.
  workspaceGet: 'workspace:get',
  workspaceSet: 'workspace:set',
} as const

// invoke (renderer -> main -> Promise) signatures
export interface Api {
  fsList(path: string): Promise<ListResult>
  fsHome(): Promise<string>
  recentsList(): Promise<RecentFolder[]>
  recentsAdd(path: string): Promise<void>
  sessionsList(path: string): Promise<ClaudeSession[]>
  externalOpen(path: string): Promise<void>
  // `sessionId` NAMES a new Claude conversation (`--session-id`) so the tab that
  // owns it can `--resume` that exact conversation after a restart; `resumeId`
  // picks up one that already has a transcript. Mutually exclusive.
  ptySpawn(opts: {
    path: string; resumeId?: string; shell?: boolean; sessionId?: string
  }): Promise<string> // returns ptyId
  ptyWrite(ptyId: string, data: string): void
  ptyResize(ptyId: string, cols: number, rows: number): void
  ptyKill(ptyId: string): void
  onPtyData(cb: (ptyId: string, data: string) => void): () => void // returns unsubscribe
  onPtyExit(cb: (ptyId: string, code: number) => void): () => void
  // --- v2 file operations ---
  // Mutating ops are policy-gated in main; `confirm` carries the typed word on retry.
  fsRename(from: string, to: string, confirm?: string): Promise<OpResult<void>>
  fsMkdir(path: string, confirm?: string): Promise<OpResult<string>> // created dir path (collision-resolved)
  fsNewFile(path: string, confirm?: string): Promise<OpResult<string>> // created file path (collision-resolved)
  fsCopy(src: string, destDir: string, confirm?: string): Promise<OpResult<string>> // final path
  fsMove(src: string, destDir: string, confirm?: string): Promise<OpResult<string>> // final path
  fsDelete(
    paths: string[],
    opts?: { permanent?: boolean; confirm?: string },
  ): Promise<OpResult<TrashRecord[]>>
  // Policy-gated like every other mutation: restore renames caller-supplied
  // paths, so it is an arbitrary-move primitive if left ungated.
  fsRestore(records: TrashRecord[], confirm?: string): Promise<OpResult<void>>
  // Fires when staged items could not reach the Recycle Bin — startup retry is
  // the common case, since that is the one point main can be sure a window is
  // listening (see sendPendingTrashWarn in main/index.ts).
  onTrashWarn(cb: (warn: TrashWarn) => void): () => void
  fsExists(path: string): Promise<boolean>
  openPath(path: string): Promise<void>
  revealPath(path: string): Promise<void>
  recentsRemove(path: string): Promise<void>
  ideOpen(path: string): Promise<void>
  settingsGet(): Promise<Settings>
  settingsSet(patch: Partial<Settings>): Promise<Settings> // returns merged settings
  clipboardReadText(): string // sync; clipboard is reachable from the preload process
  // `arg` carries the path for the CLI/Explorer entry point ('open-path' |
  // 'open-file'); the menu-click commands never set it.
  onMenuCommand(cb: (cmd: string, arg?: string) => void): () => void
  // 'new-tab' | 'close-tab' | 'open-settings' | 'toggle-mode' | 'open-path' | 'open-file'
  // --- M2 viewer + diff. Read-only: no policy gate, no OpResult, nothing throws;
  // every refusal (binary / too large / not a repo / no git) is a typed union arm.
  fsRead(path: string): Promise<ReadResult>
  gitStatus(dir: string): Promise<GitStatusResult> // dir = any path inside the repo
  gitDiff(path: string): Promise<ReadResult> // unified diff of one file, as text
  // --- M3 search. Read-only, so no policy gate. searchStart resolves with the
  // id of the run; hits arrive on the event channels until searchDone fires.
  // Starting a search supersedes any earlier one from the same window.
  searchStart(q: SearchQuery): Promise<string> // returns searchId
  searchCancel(searchId: string): void
  onSearchHits(cb: (searchId: string, hits: SearchHit[]) => void): () => void
  onSearchDone(cb: (searchId: string, done: SearchDone) => void): () => void
  // --- M5 workspace. Returns a valid empty workspace rather than null when
  // there is nothing saved, so the renderer never branches on "first run".
  workspaceGet(): Promise<Workspace>
  workspaceSet(w: Workspace): Promise<void>
}
