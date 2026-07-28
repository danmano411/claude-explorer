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
