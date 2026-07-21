import { rename as fsRename, mkdir as fsMkdirp, writeFile, cp, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { uniqueName, winBasename } from '../shared/pathutil'

async function dirNames(dir: string): Promise<string[]> {
  try { return await readdir(dir) } catch { return [] }
}

export async function rename(from: string, to: string): Promise<void> {
  await fsRename(from, to)
}

export async function mkdir(path: string): Promise<string> {
  const dir = path.slice(0, path.lastIndexOf('\\'))
  const name = winBasename(path)
  const finalName = uniqueName(await dirNames(dir), name)
  const finalPath = join(dir, finalName)
  await fsMkdirp(finalPath)
  return finalPath
}

export async function newFile(path: string): Promise<string> {
  const dir = path.slice(0, path.lastIndexOf('\\'))
  const finalName = uniqueName(await dirNames(dir), winBasename(path))
  const finalPath = join(dir, finalName)
  await writeFile(finalPath, '', { flag: 'wx' })
  return finalPath
}

export async function copy(src: string, destDir: string): Promise<string> {
  const finalName = uniqueName(await dirNames(destDir), winBasename(src))
  const finalPath = join(destDir, finalName)
  await cp(src, finalPath, { recursive: true, errorOnExist: true, force: false })
  return finalPath
}

export async function move(src: string, destDir: string): Promise<string> {
  const finalName = uniqueName(await dirNames(destDir), winBasename(src))
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
