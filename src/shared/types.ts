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
}

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
 * One cell of a split view. Rectangles rather than a left/right binary, so
 * `colSpan`/`rowSpan` let an m x n block sit anywhere in an N x N grid. Maps
 * straight onto CSS Grid, which is why there is no layout maths anywhere.
 */
export interface GridCell {
  tabId: string
  col: number // 0-based
  row: number
  colSpan: number
  rowSpan: number
}

export interface GridLayout {
  cols: number
  rows: number
  cells: GridCell[]
}

/** Top-level switching. `layout: null` means classic single-pane tabs, so
 *  nothing changes for anyone who never opens split view. */
export interface Space {
  id: string
  name: string
  tabIds: string[] // ordered; membership of this space
  layout: GridLayout | null
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
  terminalKind?: 'claude' | 'shell'
  resumeSessionId?: string
  filePath?: string
  viewerMode?: 'file' | 'diff'
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
