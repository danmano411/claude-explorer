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
  ControlRequest,
  ControlReply,
  SpawnConfirmRequest,
  ClaudeState,
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
  // --- KAN-100: is a foreground command running in these SHELL ptys right now?
  // The close guard's missing signal. Claude tabs got a real one in KAN-73
  // (hook-reported ClaudeState); a shell never had one, so `closeRisk` measured
  // risk as "a pty exists and has not exited" — true for the whole life of the
  // tab — and every shell close was confirmed. Confirming every close is the
  // failure mode closeguard.ts exists to prevent.
  //
  // ON DEMAND, not an event, and that is the point: this is asked ONCE per close
  // decision, for the whole batch, and never otherwise. A pty:data-style
  // broadcast would put a forked process behind every keystroke, and a polled
  // one would burn a process every interval for a question nobody asked. It is
  // also why it is not folded into pty:data — inferring session state from byte
  // traffic is exactly the mistake KAN-73 removed (a silent `npm run dev` reads
  // as idle on bytes, and that is the one case worth protecting).
  //
  // TAKES A LIST, returns a record keyed by ptyId. One round trip closes a
  // group of eight shells; a per-tab channel would fork eight agents in series
  // behind a modal the user is waiting for.
  //
  // ABSENCE MEANS UNKNOWN — the same rule as pty:exit-derived status and
  // claude:state. A ptyId missing from the answer (unknown id, dead pty, a
  // Claude tab, the probe timing out) is NOT "idle": the renderer must warn.
  // Defaulting the other way silently kills processes.
  ptyBusy: 'pty:busy',
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
  // KAN-55 "Open Recent" rows in the native File menu. A SEPARATE channel from
  // menuCommand on purpose, and it is not an arbitrary refactor: menu:command
  // is reachable from argv — main/index.ts sendPendingCli() forwards a
  // CLI-supplied path down it, and any local process can say
  // `"Claude Explorer.exe" --open <path>` with no authentication whatsoever.
  // menu:session DOES spawn Claude Code in the named folder, which inherits the
  // user's own config (hooks, .mcp.json, CLAUDE.md) at the user's privilege.
  // Keeping it on its own channel — sent ONLY from src/main/menu.ts, never from
  // the CLI path — keeps "no spawn from argv" structural rather than a check
  // someone can delete. See main/cli.ts:81-110 and applyCli in App.tsx.
  menuSession: 'menu:session', // main -> renderer event (Open Recent rows)
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
  // --- KAN-39 control channel: the only main -> renderer REQUEST/RESPONSE
  // path in the app. Two channels because the two halves travel in opposite
  // directions — `control:request` is an event main sends (same shape as
  // menu:command), `control:reply` is a renderer -> main send (same shape as
  // pty:write) that main matches back to a pending promise by id. The live tab
  // list is renderer React state; workspace:get is a debounced disk snapshot
  // with no ptyId and no pty status in it, so it cannot answer for it.
  //
  // openClaudeSession rides THIS channel and not menu:command because it
  // SPAWNS, and menu:command is reachable from argv (sendPendingCli in
  // main/index.ts) with no authentication of any kind. Same structural
  // reasoning as menuSession above; see main/cli.ts. There is no external
  // caller of control:request yet — KAN-40 adds the first one.
  controlRequest: 'control:request', // main -> renderer event
  controlReply: 'control:reply',
  // --- KAN-41: the human in front of the one MCP tool that spawns. Its own
  // channel pair rather than a fifth control op, for three reasons that are all
  // about control:request's shape: it dies at a 15s deadline (a human takes
  // longer than that to read a path), the renderer drains it ONE OP PER COMMIT
  // (so a modal awaiting a click would starve every listTabs behind it), and it
  // is request -> one reply correlated by id, where this is notify-now /
  // answer-later correlated by TOKEN. Same "this one spawns, so it gets its own
  // channel" split as menuSession above.
  spawnConfirm: 'spawn:confirm', // main -> renderer event
  spawnConfirmAnswer: 'spawn:confirm-answer',
  // --- KAN-73: what a Claude session is actually doing, from Claude Code's own
  // hooks. A main -> renderer EVENT, keyed by ptyId, deliberately the same
  // shape and the same addressing as pty:data / pty:exit — it is broadcast for
  // every ptyId and consumers filter by id, so a second subscription model does
  // not appear next to the one Terminal.tsx and usePtyStatus already use.
  //
  // Keyed by ptyId and NOT by Claude session id even though the hook reports
  // the session id, because the renderer already joins tabs to ptys and nothing
  // else in the tree addresses a session id at runtime. main resolves
  // session -> pty from what PtyManager recorded at spawn, which also means an
  // id main never spawned is dropped in main rather than reaching the renderer.
  //
  // NEVER CARRIES 'stopped'. A dead process cannot POST its own death, so that
  // arm of ClaudeState comes from the pty:exit event above — which is also the
  // only signal a session with no hooks at all ever produces. Anything that
  // folds this channel into a state map must fold pty:exit in as well, or a
  // finished session sits on its last hook state forever.
  claudeState: 'claude:state', // main -> renderer event
  // --- KAN-79. Clicking a desktop toast is "the one legitimate focus-steal,
  // because the user clicked" (the ticket's own words). The toast itself is
  // constructed in the RENDERER (src/renderer/notify.ts's showToast) — it
  // already has everything else the click needs (which space, which tab) —
  // but only MAIN can reliably un-minimize and bring the OS window forward
  // (same restore()-then-focus() shape as the second-instance handler in
  // main/index.ts), so the click asks main to do that one thing and switches
  // the tab itself, renderer-side, with no round trip needed for that part.
  notifyFocusWindow: 'notify:focus-window',
  // --- KAN-78: the desktop/taskbar unread indicator. Renderer -> main, one-way,
  // ONE BOOLEAN — "does anything need attention right now" — never the
  // ClaudeState map itself and never a transition history. The renderer already
  // owns every input the decision needs (claudeState, which tab is visible,
  // whether the window has focus — see src/renderer/attention.ts's
  // `attentionNeeded`), so main is not handed the state map to re-derive the
  // same answer a second way; it is handed the answer. main's only job is the
  // OS call (src/main/badge.ts) — Windows setOverlayIcon/flashFrame today,
  // macOS/Linux behind their own platform guard once M9 exists.
  setAttention: 'app:attention',
  // --- KAN-89: "are these two paths on the same volume?", the one path
  // question the renderer cannot answer for itself. On Windows it is a string
  // compare of drive letters, but on POSIX it is an st_dev compare — and
  // src/shared is bundled into the renderer, which has no fs. So the drop
  // handler's move-vs-copy decision comes over IPC rather than being computed
  // in place. Read-only and stat-only: no gate, and it mutates nothing.
  sameVolume: 'path:sameVolume',
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
    /** KAN-41 recursion guard. True for a session the MCP spawn tool asked for:
     *  main gives that child no --mcp-config and no token, plus
     *  --strict-mcp-config, so it cannot spawn in turn and cannot see the target
     *  folder's .mcp.json. Set by App.tsx's control executor and carried back by
     *  restore of a tab that had it — provenance survives a restart. */
    agentSpawned?: boolean
  }): Promise<string> // returns ptyId
  ptyWrite(ptyId: string, data: string): void
  ptyResize(ptyId: string, cols: number, rows: number): void
  ptyKill(ptyId: string): void
  /** KAN-100. Which of these SHELL ptys are running a foreground command right
   *  now — the close guard's one question about a shell.
   *
   *  A ptyId is present in the answer only when main could actually decide.
   *  Missing means UNKNOWN and the caller must treat it as at-risk: an id main
   *  has no handle for, a Claude pty (their signal is claude:state, which is
   *  better), a probe that timed out, or a platform arm that could not answer.
   *  See the CH.ptyBusy comment for why absence is never optimistic. */
  ptyBusy(ptyIds: readonly string[]): Promise<Record<string, boolean>>
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
  // KAN-60. Only "is there a bitmap on it", never the pixels: Claude Code reads
  // the Windows clipboard itself, so all the renderer needs is which branch of
  // its Ctrl+V arm to take. Like clipboardReadText this is a plain preload
  // function, NOT a channel — two of the usual four contract pieces (CH constant,
  // main handler) do not apply, because electron's `clipboard` is reachable from
  // the preload directly.
  clipboardHasImage(): boolean
  // KAN-62. Sync, same reason as the two above: this is a plain preload
  // function, not a channel. Used by the file pane's Copy/Cut so a path can be
  // pasted into a Claude tab (term.paste brackets it, and Claude Code attaches
  // an image path itself — see Terminal.tsx) or into any other text field.
  clipboardWriteText(text: string): void
  // KAN-62 finding #2. Sync, same reason as the three above. Whether the OS
  // clipboard already holds something that looks like a real file-drop
  // (Explorer's CF_HDROP, which Chromium's clipboard abstraction surfaces as
  // a uri-list/filename-shaped format) — used to skip clipboardWriteText
  // rather than blow away a pending real Explorer copy/paste.
  clipboardHasFileDrop(): boolean
  // `arg` carries the path for the CLI/Explorer entry point ('open-path' |
  // 'open-file'); the menu-click commands never set it.
  onMenuCommand(cb: (cmd: string, arg?: string) => void): () => void
  // 'new-tab' | 'close-tab' | 'open-settings' | 'toggle-mode' | 'open-path' | 'open-file'
  // KAN-55: an "Open Recent" row was clicked — open a terminal tab on `path`,
  // resuming `resumeId` when present and starting a fresh session when it is
  // omitted. Separate from onMenuCommand because this one spawns; only
  // src/main/menu.ts may send it (see the CH.menuSession comment).
  onMenuSession(cb: (path: string, resumeId?: string) => void): () => void
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
  // --- KAN-39 control channel. Main asks, the renderer answers.
  onControlRequest(cb: (req: ControlRequest) => void): () => void
  /** Exactly once per request id. Fire-and-forget `send`, not `invoke`: this
   *  IS the response, so awaiting it would be a second round trip. Main drops
   *  a reply whose id it no longer has pending (timed out, or a duplicate). */
  controlReply(reply: ControlReply): void
  // --- KAN-41 agent spawn confirmation.
  /** An agent asked to start Claude Code in `req.path`. Show the prompt; at most
   *  one is ever outstanding. The renderer holds no authority here — it displays
   *  a token main minted and hands the answer back. */
  onSpawnConfirm(cb: (req: SpawnConfirmRequest) => void): () => void
  /** The user's answer. Fire-and-forget `send`, like controlReply: main drops an
   *  answer for a token it no longer holds (expired, already answered, or from a
   *  prompt an older window put up). Escape and the backdrop are a DENY, not
   *  silence — the tool is waiting, and silence costs it the full timeout. */
  spawnConfirmAnswer(token: string, allow: boolean): void
  // --- KAN-73 session state.
  /** Claude Code reported what the session in `ptyId` is doing. Broadcast for
   *  every pty, like onPtyData/onPtyExit, so a consumer filters by id.
   *
   *  A pty that has never been heard from is UNKNOWN and must render as
   *  unknown: no state is optimistic, and plenty of legitimate sessions never
   *  report (started by hand in a shell tab, launched while `agentControl` was
   *  off, or running under the user's own `disableAllHooks` / `--bare`).
   *
   *  'stopped' never arrives here — see the CH.claudeState comment. */
  onClaudeState(cb: (ptyId: string, state: ClaudeState) => void): () => void
  // --- KAN-79 toast click.
  /** A desktop toast was clicked. Fire-and-forget `send`, like ptyWrite: main
   *  un-minimizes/shows/focuses its one window; the renderer switches the tab
   *  itself with no reply to wait for. */
  notifyFocusWindow(): void
  // --- KAN-78 desktop/taskbar unread indicator.
  /** Fire-and-forget `send`, like ptyWrite/controlReply/spawnConfirmAnswer:
   *  this IS the notification, not a request with an answer. Called by
   *  App.tsx whenever `attentionNeeded()` flips — see the CH.setAttention
   *  comment in ipc.ts for why main gets exactly this one boolean. */
  setAttention(needsAttention: boolean): void
  // --- KAN-89 cross-platform volume identity.
  /** Same volume => a drop without Ctrl is a move; different volumes => a copy.
   *  Async because POSIX has to stat both paths (st_dev); on Windows main
   *  answers from the strings alone and never touches the filesystem.
   *  Answers false — copy, which keeps the source — if either path cannot be
   *  stat'ed. */
  sameVolume(a: string, b: string): Promise<boolean>
}
