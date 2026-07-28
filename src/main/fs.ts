import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DirEntry, ListResult } from '../shared/types'

// ponytail: name-based hidden detection, not real FILE_ATTRIBUTE_HIDDEN.
// Reading true Win32 attributes needs a native dep or an `attrib` spawn per
// listing. Upgrade behind this same function; no call sites change.
const NOISE = new Set([
  '$recycle.bin',
  'system volume information',
  'pagefile.sys',
  'hiberfil.sys',
  'swapfile.sys',
  'desktop.ini',
  'thumbs.db',
  '.claude-explorer-trash',
])

export function isHidden(name: string): boolean {
  return name.startsWith('.') || NOISE.has(name.toLowerCase())
}

export function humanizeFsError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return 'Access denied'
    case 'ENOENT':
      return 'No longer exists'
    case 'EBUSY':
      return 'In use by another program'
    case 'ENOTDIR':
      return 'Not a folder'
    default:
      return code ? `Could not read this folder (${code})` : 'Could not read this folder'
  }
}

export async function listDir(path: string): Promise<ListResult> {
  let raw
  try {
    raw = await readdir(path, { withFileTypes: true })
  } catch (err) {
    return { ok: false, reason: humanizeFsError(err) }
  }

  const entries = await Promise.all(
    raw.map(async (e): Promise<DirEntry> => {
      const full = join(path, e.name)
      const isSymlink = e.isSymbolicLink()
      let isDirectory = e.isDirectory()
      // Dirent reports junctions/symlinks as neither file nor directory, so a
      // junction to a folder would otherwise render as a file. stat() follows
      // the link; a dangling target falls back to "not a directory".
      if (isSymlink) {
        try {
          isDirectory = (await stat(full)).isDirectory()
        } catch {
          isDirectory = false
        }
      }
      return { name: e.name, path: full, isDirectory, isSymlink, hidden: isHidden(e.name) }
    }),
  )

  entries.sort((a, b) =>
    a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1,
  )
  return { ok: true, entries }
}
