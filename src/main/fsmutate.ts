import { rename as fsRename, mkdir as fsMkdirp, writeFile, cp, rm, readdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { uniqueName, winBasename, winDirname } from '../shared/pathutil'

async function dirNames(dir: string): Promise<string[]> {
  try { return await readdir(dir) } catch { return [] }
}

function errno(code: string, message: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(message)
  err.code = code
  return err
}

/** lstat, not access: a dangling symlink at the destination is still something
 *  rename would destroy. */
const exists = (p: string) => lstat(p).then(() => true, () => false)

const samePath = (a: string, b: string) =>
  a.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() ===
  b.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

/** '.' and '..' are not item names. path.join collapses them, so the write
 *  would land OUTSIDE the directory the policy gate approved — and uniqueName
 *  can't catch it because readdir never returns them. */
function destName(src: string): string {
  const name = winBasename(src)
  if (name === '.' || name === '..') throw errno('EINVAL', `Invalid source path: ${src}`)
  return name
}

/** Windows' rename REPLACES an existing target (libuv passes
 *  MOVEFILE_REPLACE_EXISTING): no prompt, no trash staging, no Recycle Bin, no
 *  undo. Fail loudly rather than falling back to uniqueName like
 *  mkdir/newFile/copy/move do — rename is asked for an EXACT name (F2, and
 *  undo restoring the original), so silently landing on "notes (2).txt" would
 *  make undo lie about what it restored.
 *  samePath keeps case-only renames working: on a case-insensitive volume
 *  "Notes.txt" already "exists" but IS the source. */
export async function rename(from: string, to: string): Promise<void> {
  if (!samePath(from, to) && await exists(to)) throw errno('EEXIST', `Already exists: ${to}`)
  await fsRename(from, to)
}

export async function mkdir(path: string): Promise<string> {
  const dir = winDirname(path)
  const name = winBasename(path)
  const finalName = uniqueName(await dirNames(dir), name)
  const finalPath = join(dir, finalName)
  await fsMkdirp(finalPath)
  return finalPath
}

export async function newFile(path: string): Promise<string> {
  const dir = winDirname(path)
  const finalName = uniqueName(await dirNames(dir), winBasename(path))
  const finalPath = join(dir, finalName)
  await writeFile(finalPath, '', { flag: 'wx' })
  return finalPath
}

export async function copy(src: string, destDir: string): Promise<string> {
  const finalName = uniqueName(await dirNames(destDir), destName(src))
  const finalPath = join(destDir, finalName)
  await cp(src, finalPath, { recursive: true, errorOnExist: true, force: false })
  return finalPath
}

export async function move(src: string, destDir: string): Promise<string> {
  const finalName = uniqueName(await dirNames(destDir), destName(src))
  const finalPath = join(destDir, finalName)
  try {
    await fsRename(src, finalPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      await cp(src, finalPath, { recursive: true, errorOnExist: true, force: false })
      await rm(src, { recursive: true, force: true })
    } else {
      throw err
    }
  }
  return finalPath
}
