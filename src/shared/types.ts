export interface DirEntry {
  name: string
  path: string // absolute
  isDirectory: boolean
  hidden: boolean // dotfile or known Windows noise
  isSymlink: boolean // junction / symlink / reparse point
}

export interface RecentFolder {
  path: string // absolute
  name: string // basename
  lastOpened: number // epoch ms
}

export interface ClaudeSession {
  id: string // session UUID (jsonl filename without extension)
  folderPath: string // absolute cwd this session belongs to
  title: string // first user prompt, truncated to 80 chars, or "(untitled)"
  updated: number // epoch ms of newest line's timestamp (fallback: file mtime)
}

export type TabView = 'files' | 'terminal' | 'viewer'

export interface TrashRecord {
  original: string // absolute path the item was deleted from
  staged: string // absolute path in the same-drive trash staging dir
  name: string // basename, for display
}

/** A batch of staged items that could not be handed to the Recycle Bin (no
 *  Recycle Bin on that volume — network share, removable media). Not data
 *  loss: the items stay staged on disk and a later sweep retries them.
 *  `volume` is null when the batch spans more than one drive/share. */
export interface TrashWarn {
  count: number
  volume: string | null
}

export type FileMode = 'explorer' | 'developer'

export interface Settings {
  ideCommand: string // e.g. "code"; launched as `<ideCommand> <folder>`
  mode: FileMode // 'explorer' (default) hides risk; 'developer' unlocks it
  /** Auto-link a tab opened FROM another tab into that tab's group (KAN-47).
   *  Default true: opening a file from a grouped repo tab keeps them together,
   *  which is the whole point of the grouping. */
  groupWithSource: boolean
  /** The agent-control surface (KAN-42): the in-process MCP server, and the
   *  --mcp-config + bearer token handed to Claude sessions this app launches.
   *  Default true. False stops the server immediately and injects nothing into
   *  the NEXT spawn — it is NOT retroactive: a session already running has the
   *  token in its environment and nothing reaches into that process. */
  agentControl: boolean
  /**
   * KAN-64. How many Claude sessions the MCP spawn tool may open WITHOUT
   * asking. A FREE ALLOWANCE, not a cap: at or above it the user is asked, and
   * an approval opens the session anyway. There is no count at which the tool
   * stops working — it throttles, it never blocks. "Never" is already
   * `agentControl: false`, which takes the whole surface away; this must not
   * become a second spelling of it.
   *
   * One of AGENT_FREE_SESSION_CHOICES; anything else read off disk is
   * normalized back to DEFAULT_AGENT_FREE_SESSIONS (settings.ts). Never to
   * "unlimited" and never to a value that skips the prompt entirely — a
   * hand-edited `"agentFreeSessions": 9999` must not be a way to disable the
   * human gate.
   */
  agentFreeSessions: number
}

/**
 * The only reachable values for `Settings.agentFreeSessions`, and the order the
 * Settings modal offers them in. A fixed set rather than a free number field:
 * the interesting decision is "ask every time / a few / the default / a lot",
 * and a text box invites a 500 that nobody meant and that no UI can explain.
 * 16 is deliberately the largest offered.
 */
export const AGENT_FREE_SESSION_CHOICES = [0, 4, 8, 16] as const

/** KAN-64's default, stated once. A security-relevant loosening on upgrade —
 *  eight sessions used to cost eight human clicks and now cost none — chosen
 *  deliberately with that in front of us; 0 keeps the old behaviour exactly. */
export const DEFAULT_AGENT_FREE_SESSIONS = 8

/**
 * Result of a policy-gated mutating operation. A union, not a thrown Error:
 * ipcMain.handle serialises thrown Errors into a string-prefixed message, so
 * structured data (which code? typed confirm?) does not survive a throw.
 */
export type OpResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'DENIED'; reason: string }
  | { ok: false; code: 'NEEDS_CONFIRM'; reason: string; typed: boolean }
  | { ok: false; code: 'ERROR'; reason: string }

/** Directory listing: a folder that cannot be read reports why instead of throwing. */
export type ListResult = { ok: true; entries: DirEntry[] } | { ok: false; reason: string }

/**
 * File text for the read-only viewer (also carries `git diff` output).
 * `kind` is load-bearing: 'binary' and 'toolarge' are NORMAL outcomes with their
 * own UI ("this is a PNG"), not failures — only 'error' is an actual fault.
 */
export type ReadResult =
  | { ok: true; content: string; truncated: boolean; lines: number }
  | { ok: false; reason: string; kind: 'binary' | 'toolarge' | 'error' }

export interface GitFileStatus {
  path: string // absolute
  status: 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed'
}

/**
 * Working-tree status for a folder. Like ReadResult, the failure `kind`s are
 * mostly normal: 'notrepo' (plain folder) and 'nogit' (git not installed) each
 * want their own empty state, not an error toast.
 */
export type GitStatusResult =
  | { ok: true; repoRoot: string; files: GitFileStatus[] }
  | { ok: false; reason: string; kind: 'notrepo' | 'nogit' | 'error' }

export type PtyStatus = 'running' | 'waiting' | 'stopped'

// --- M3 search -------------------------------------------------------------

/**
 * One match. `line`/`column`/`preview` are absent for a filename-only hit —
 * that is the difference between "this file is called foo" and "this file
 * contains foo on line 12", and the overlay renders the two differently.
 */
export interface SearchHit {
  path: string // absolute
  name: string // basename, for display
  isDirectory: boolean
  line?: number // 1-based
  column?: number // 1-based, byte offset within the line as ripgrep reports it
  preview?: string // the matching line, trimmed and length-capped
}

export interface SearchQuery {
  root: string // folder to search under
  query: string
  content: boolean // false = match names only, true = search inside files
  regex: boolean // false = literal (rg --fixed-strings)
  caseSensitive: boolean // false = rg --ignore-case
  /** Developer mode searches everything (rg -uu); Explorer mode honours
   *  .gitignore and skips hidden files, which is ripgrep's default. */
  includeIgnored: boolean
}

/**
 * Why a search stopped. 'cancelled' is the common case — every keystroke
 * supersedes the previous search — and must never surface as an error.
 */
// --- M5 spaces, tab folders, split view ------------------------------------

/**
 * A "tab folder". Deliberately NOT derived from a directory: Dan's answer 5 was
 * "free form, disk vs application should be separate", which is what lets one
 * group hold a repo folder, a Claude session and a viewer on a file from
 * somewhere else entirely.
 */
export interface TabGroup {
  id: string
  name: string
  color: string // one of the Retro Claude accents, see GROUP_COLORS
  collapsed: boolean
}

/**
 * One pane of a split view: a window-like region with its OWN ordered set of
 * tabs and its own strip (KAN-56). Rectangles rather than a left/right binary
 * or a split tree, so `colSpan`/`rowSpan` let an m x n block sit anywhere in an
 * N x N grid. Maps straight onto CSS Grid, which is why there is no layout
 * maths anywhere.
 *
 * INVARIANT, enforced by sanitize() (src/main/workspace.ts) and by
 * gridPlacement() at render: with a layout present, every member of
 * `Space.tabIds` is in EXACTLY ONE cell's `tabIds`. A tab in no cell is
 * unreachable — it renders nowhere and no strip lists it. `layout: null` is
 * shorthand for "one pane holding every tab of the space", which is why the
 * classic single-strip path needs no cells at all.
 *
 * PERSISTED SHAPE CHANGE: 0.7.0 wrote one tab per cell as a single
 * `{ tabId, col, row, colSpan, rowSpan }`. Those files are migrated forward in
 * sanitize() by shape detection — `Workspace.version` stays 1, since the cell
 * is self-describing and a downgrade degrades to `layout: null` rather than
 * corrupting. Without that migration the membership filter reads `undefined`
 * for every old cell and silently drops the whole layout.
 */
export interface GridCell {
  /** Ordered — THIS pane's strip order. Never empty: a cell that loses its
   *  last tab is removed and its rectangle absorbed. */
  tabIds: string[]
  /** Which of `tabIds` this pane shows. Always a member. Per-pane memory;
   *  `Space.activeTabId` is the global focus and names the FOCUSED pane's
   *  active tab, so the focused pane is derived, never stored. */
  activeTabId: string
  col: number // 0-based
  row: number
  colSpan: number
  rowSpan: number
}

export interface GridLayout {
  cols: number
  rows: number
  /** Fewer than 2 cells is not a split: every write chokepoint collapses such
   *  a layout to `null` rather than leaving two ways to express one state. */
  cells: GridCell[]
}

/** Top-level switching. `layout: null` means classic single-pane tabs, so
 *  nothing changes for anyone who never opens split view. */
export interface Space {
  id: string
  name: string
  /** Ordered; membership of this space. Authoritative for strip ORDER only
   *  while `layout === null` — with a layout present it is kept equal to the
   *  cells' `tabIds` concatenated in reading order, so there is exactly one
   *  order truth and collapsing back to `layout: null` is free (KAN-56). */
  tabIds: string[]
  // A cell naming a tab that has left this space is pruned in TWO places, both
  // of them chokepoints, so no caller carries the obligation (KAN-45
  // integration review #4): `sanitize()` (src/main/workspace.ts) drops it on
  // every read and write, and App.tsx re-tiles the layout it RENDERS against
  // the space's live membership. That is why neither `closeTab` nor
  // `spaces.ts`'s `withoutTab` touches `layout` — keeping spaces.ts a leaf that
  // never imports gridlayout was worth more than repairing the same thing in a
  // third place.
  layout: GridLayout | null
  /**
   * Track sizes from divider drags, one entry per column / row of `layout`.
   *
   * Beside `layout` rather than inside it because every `gridlayout` op returns
   * a rebuilt layout and would have to thread these through as well. The
   * length is the only coupling: `splitgrid.normalizeFractions` falls back to
   * an even split the moment it stops matching `layout.cols`/`rows`, which is
   * exactly what a split or a pane close should do to sizes the user set for a
   * different number of tracks.
   */
  colFractions?: number[]
  rowFractions?: number[]
  /** The tab that had focus when this space was last left, so a restart lands
   *  where you were instead of on tab 1. Optional: a workspace.json written by
   *  v0.4.0 has no such field and must still load. sanitize() guarantees it
   *  names a member of `tabIds` (or is absent). */
  activeTabId?: string
  /**
   * KAN-57: deleting this space is refused while true. Absent, not `false`, for
   * an unpinned space — a workspace.json written before KAN-57 has no such
   * field and must load unchanged, and `JSON.stringify` drops `undefined`, so an
   * unpinned space writes no key back either.
   *
   * Says nothing about this space's TABS: it gates exactly one operation.
   */
  pinned?: boolean
}

/**
 * A tab as it survives a restart. `ptyId` is deliberately absent: it is a live
 * handle to a running process and cannot be restored. A Claude tab carries
 * `resumeSessionId` instead, so the conversation itself comes back.
 */
export interface PersistedTab {
  id: string
  view: TabView
  cwd: string
  title: string
  renamed?: boolean
  groupId?: string
  /** KAN-53. Absent, not `false`, for an unpinned tab — a v0.5.0 workspace.json
   *  has no such field and must still load, so absent has to be the norm.
   *  Mutually exclusive with `groupId`; `sanitize()` enforces that on read. */
  pinned?: boolean
  terminalKind?: 'claude' | 'shell'
  resumeSessionId?: string
  filePath?: string
  viewerMode?: 'file' | 'diff'
  /** KAN-41. Provenance, not preference: a session an agent asked for stays a
   *  worker across a restart. Absent (never `false`) so an older workspace.json
   *  still loads. Without it, restarting launders every agent-spawned session
   *  into one that gets the MCP tools — and the spawn tool — back. */
  agentSpawned?: true
}

export interface Workspace {
  version: 1
  spaces: Space[]
  groups: TabGroup[]
  tabs: PersistedTab[]
  activeSpaceId: string
}

export type SearchDone =
  | { ok: true; count: number; truncated: boolean }
  | { ok: false; reason: string; kind: 'cancelled' | 'norg' | 'badpattern' | 'error' }

// --- KAN-39 control channel ------------------------------------------------

/**
 * One tab as `listTabs` reports it. NOT `Tab` and not `PersistedTab`: `Tab`
 * lives in the renderer, and `PersistedTab` is a disk snapshot with no `ptyId`
 * and no live status in it — which is the whole reason this channel exists
 * rather than reusing `workspace:get`.
 *
 * `ptyId` is here because it is the only INJECTABLE correlation key. A tab id
 * is minted in the renderer after the spawn resolves, so nothing outside the
 * renderer can be handed one in advance; a ptyId can be, so a caller that
 * knows its own pty can join itself to a tab.
 *
 * Deliberately no `groupId`: tab folders are M5's model and this channel does
 * not speak it. `status` is absent for a tab with no process (files/viewer)
 * and for a terminal tab whose pty has not emitted an event yet.
 */
export interface ControlTab {
  id: string
  ptyId?: string
  view: TabView
  cwd: string
  title: string
  terminalKind?: 'claude' | 'shell'
  status?: PtyStatus
  /**
   * KAN-64. This tab was opened BY the spawn tool, not by the user. Here
   * because it is half of the only test that can tell a DEAD agent tab (reap
   * it) from a tab the user opened themselves (never reap it) — and this row is
   * the only place `agentSpawned` and `status` are visible together. The other
   * half is `status === 'stopped'`; "no status" is NOT dead (a tab restored
   * from before a restart, and a spawn that has not emitted its first byte,
   * both report none).
   */
  agentSpawned?: true
}

/**
 * The four ops, and nothing else. Every arm names its target explicitly — no
 * op defaults to the active tab. (The renderer MAY accept the literal
 * `'active'` as a `tabId` alias; it must never be the only way to address one.)
 *
 * NEVER AUTO-RETRY A MUTATING OP ON A TIMEOUT. main gives up after
 * CONTROL_TIMEOUT_MS, and a request that was still QUEUED when that happened is
 * guaranteed not to run — the renderer refuses to start one whose `deadline`
 * has passed. But an op that was already EXECUTING cannot be recalled: nothing
 * un-spawns a Claude Code that is halfway up. So a timeout on
 * `openClaudeSession` means "it may or may not have happened", and retrying it
 * is how you end up with two Claude processes on one folder. Ask `listTabs` —
 * idempotent, and the only one of the four safe to retry blindly — and decide
 * from what it says.
 *
 * ponytail: a deadline stamped on the request, not a cancel channel. A real
 * cancel needs main to send a `control:cancel` AND every op to become
 * interruptible, which for `openClaudeSession` means killing a pty it has
 * already been handed. Ceiling: the in-flight window (one op, up to 15s). Build
 * the cancel when an op is slow enough that that window starts costing.
 */
export type ControlOp =
  | { op: 'listTabs'; args?: undefined }
  | { op: 'closeTab'; args: { tabId: string } }
  | { op: 'openViewerTab'; args: { filePath: string; mode?: 'file' | 'diff' } }
  | { op: 'openClaudeSession'; args: { cwd: string; resumeId?: string } }

/** An op plus the correlation id main matches the reply back on, and the wall
 *  clock instant past which the renderer must not START it — the epoch that
 *  keeps a request main has already timed out from running later anyway. Both
 *  processes read the same system clock, so there is no skew to allow for.
 *  Required, not optional: control.ts is the only producer, and an unstamped
 *  request would silently be one that never expires. */
export type ControlRequest = ControlOp & { id: string; deadline: number }

/**
 * ponytail: one result type for all four ops — the rows for `listTabs`, `null`
 * for the three mutating ones. Widen to a per-op result map when a caller
 * actually needs the id of the tab `openViewerTab`/`openClaudeSession` landed
 * on (KAN-40 is the first candidate; nothing needs it today).
 */
export type ControlResult = ControlTab[] | null

/** Exactly one reply per request id. */
export type ControlReply =
  | { id: string; ok: true; result: ControlResult }
  | { id: string; ok: false; error: string }

// --- KAN-41 agent spawn confirmation ---------------------------------------

/**
 * "An agent asked to start Claude Code in `path` — allow it?" There is at most
 * ONE of these outstanding app-wide; main mints the token, holds it, and is the
 * only thing that can redeem it.
 *
 * `path` is already canonical and is shown to the user VERBATIM AND IN FULL —
 * it is the whole of what they are approving, and a middle-elided path is a
 * path a caller can disguise (see `.spawn-path` in index.css).
 *
 * `expiresAt` is epoch ms, and it is on the wire because main has FORGOTTEN the
 * token by then: the prompt must dismiss itself at that instant rather than let
 * a late click send an answer nothing is listening for.
 */
export interface SpawnConfirmRequest {
  token: string
  path: string
  expiresAt: number
}
