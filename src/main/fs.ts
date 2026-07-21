import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { DirEntry } from '../shared/types'

export async function listDir(path: string): Promise<DirEntry[]> {
  const entries = await readdir(path, { withFileTypes: true })
  return entries
    .map((e): DirEntry => ({
      name: e.name,
      path: join(path, e.name),
      isDirectory: e.isDirectory(),
    }))
    .sort((a, b) =>
      a.isDirectory === b.isDirectory
        ? a.name.localeCompare(b.name)
        : a.isDirectory
          ? -1
          : 1,
    )
}
