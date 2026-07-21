export interface DirEntry {
  name: string
  path: string // absolute
  isDirectory: boolean
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

export type TabView = 'files' | 'terminal'
