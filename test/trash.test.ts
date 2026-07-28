import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Knobs the fs mocks below read. Hoisted so the mock factories can close over them.
const io = vi.hoisted(() => ({ exdev: false, readdirCode: '', userData: '' }))
const errno = (code: string) => Object.assign(new Error(code), { code })

vi.mock('electron', () => ({
  app: { getPath: () => io.userData },
  shell: { trashItem: async () => {} },
}))

// accessSync always fails => trashRootFor takes its userData fallback, so
// trashItems tests stage into a temp dir instead of the real C:\ root.
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>()
  return { ...real, default: real, accessSync: () => { throw errno('EACCES') } }
})

vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>()
  return {
    ...real,
    default: real,
    rename: async (a: string, b: string) => {
      if (io.exdev) throw errno('EXDEV')
      return real.rename(a, b)
    },
    readdir: async (d: string, ...rest: unknown[]) => {
      if (io.readdirCode) throw errno(io.readdirCode)
      return (real.readdir as (...a: unknown[]) => Promise<string[]>)(d, ...rest)
    },
  }
})

const { stageInto, restore, driveRootOf, trashItems } = await import('../src/main/trash')

let work: string
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'ce-trash-'))
  io.exdev = false
  io.readdirCode = ''
  io.userData = work
})
afterEach(() => rmSync(work, { recursive: true, force: true }))

describe('stageInto + restore', () => {
  it('moves a file out then restores it to its original path', async () => {
    const src = join(work, 'a.txt')
    writeFileSync(src, 'hello')
    const trashRoot = join(work, '.trash')
    const records = await stageInto(trashRoot, [src])
    expect(existsSync(src)).toBe(false)
    expect(existsSync(records[0].staged)).toBe(true)
    await restore(records)
    expect(existsSync(src)).toBe(true)
  })
  it('restore collision-renames if the original path is re-occupied', async () => {
    const src = join(work, 'a.txt')
    writeFileSync(src, '1')
    const records = await stageInto(join(work, '.trash'), [src])
    writeFileSync(src, '2') // something new took the name
    await restore(records)
    // both survive: original + a " (2)" sibling
    expect(readdirSync(work).filter((n) => n.startsWith('a')).length).toBe(2)
  })

  // A real cross-volume restore needs a second writable volume, which CI does not
  // have — rename is mocked to raise EXDEV so the fallback branch itself is what
  // gets exercised here.
  it('restore falls back to copy+delete when rename reports EXDEV', async () => {
    const src = join(work, 'a.txt')
    writeFileSync(src, 'hello')
    const records = await stageInto(join(work, '.trash'), [src])
    io.exdev = true
    await restore(records)
    expect(readFileSync(src, 'utf8')).toBe('hello')
    expect(existsSync(records[0].staged)).toBe(false)
  })

  it('restore refuses to guess when the target directory cannot be read', async () => {
    const src = join(work, 'a.txt')
    writeFileSync(src, 'original')
    const records = await stageInto(join(work, '.trash'), [src])
    writeFileSync(src, 'newer') // a real file now holds that name
    io.readdirCode = 'EACCES'
    await expect(restore(records)).rejects.toThrow(/EACCES/)
    expect(readFileSync(src, 'utf8')).toBe('newer') // not clobbered
    expect(existsSync(records[0].staged)).toBe(true) // still recoverable
  })
})

describe('trashItems', () => {
  it('stages every path on the happy path', async () => {
    const a = join(work, 'a.txt')
    writeFileSync(a, 'A')
    const records = await trashItems([a])
    expect(existsSync(a)).toBe(false)
    expect(records).toHaveLength(1)
    expect(existsSync(records[0].staged)).toBe(true)
  })

  it('puts already-staged items back when a later item fails', async () => {
    const a = join(work, 'a.txt')
    const b = join(work, 'b.txt')
    writeFileSync(a, 'A')
    writeFileSync(b, 'B')
    await expect(trashItems([a, b, join(work, 'nope.txt')])).rejects.toThrow()
    expect(readFileSync(a, 'utf8')).toBe('A')
    expect(readFileSync(b, 'utf8')).toBe('B')
  })
})

describe('driveRootOf', () => {
  it('returns the drive root for a local path', () => {
    expect(driveRootOf('C:\\Users\\dan\\f.txt')).toBe('C:\\')
  })
  it('returns the share root for a UNC path', () => {
    expect(driveRootOf('\\\\server\\share\\proj\\f.txt')).toBe('\\\\server\\share')
  })
  it('handles \\\\?\\ long paths', () => {
    expect(driveRootOf('\\\\?\\C:\\deep\\f.txt')).toBe('C:\\')
  })
})
