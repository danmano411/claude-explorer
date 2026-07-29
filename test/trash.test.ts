import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, mkdirSync,
  utimesSync, statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// Knobs the fs mocks below read. Hoisted so the mock factories can close over them.
const io = vi.hoisted(() => ({
  exdev: false, readdirCode: '', userData: '', trashFails: false, trashed: [] as string[],
}))
const errno = (code: string) => Object.assign(new Error(code), { code })

vi.mock('electron', () => ({
  app: { getPath: () => io.userData },
  shell: {
    trashItem: async (p: string) => {
      // A volume with no Recycle Bin (network share, removable) rejects here.
      if (io.trashFails) throw new Error('no recycle bin on this volume')
      io.trashed.push(p)
    },
  },
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

const { stageInto, restore, driveRootOf, trashItems, flush, sweep } = await import('../src/main/trash')

let work: string
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'ce-trash-'))
  io.exdev = false
  io.readdirCode = ''
  io.userData = work
  io.trashFails = false
  io.trashed = []
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

// The bucket dir and its sibling manifest, from a record.
const bucketOf = (staged: string) => dirname(staged)
const manifestOf = (staged: string) => dirname(staged) + '.json'

// D1: the registry of what is staged lived ONLY in process memory, drained
// solely by the will-quit flush. Kill the app from Task Manager after a delete
// and the files are in no location the user can reach — not the original path,
// not the Recycle Bin, not the undo stack — and policy then refuses to let them
// move the bucket back out.
describe('D1 — staged items survive an unclean exit', () => {
  it('stageInto records the original path in a manifest beside the bucket', async () => {
    const src = join(work, 'a.txt')
    writeFileSync(src, 'hello')
    const [rec] = await stageInto(join(work, '.trash'), [src])
    expect(JSON.parse(readFileSync(manifestOf(rec.staged), 'utf8'))).toEqual(rec)
  })

  it('sweep flushes a bucket orphaned by a previous run to the Recycle Bin', async () => {
    const src = join(work, 'a.txt')
    writeFileSync(src, 'hello')
    const trashRoot = join(work, '.trash')
    const [rec] = await stageInto(trashRoot, [src])
    // No flush, no restore: this is exactly what a kill from Task Manager leaves.
    expect(await sweep([trashRoot])).toEqual([src]) // reports the ORIGINAL path
    expect(io.trashed).toEqual([rec.staged])
    expect(existsSync(bucketOf(rec.staged))).toBe(false)
    expect(existsSync(manifestOf(rec.staged))).toBe(false)
  })

  it('sweeps a manifest-less bucket left by an older build', async () => {
    const trashRoot = join(work, '.trash')
    const bucket = join(trashRoot, 'deadbeef')
    mkdirSync(bucket, { recursive: true })
    writeFileSync(join(bucket, 'orphan.txt'), 'x')
    expect(await sweep([trashRoot])).toEqual([bucket])
    expect(io.trashed).toEqual([join(bucket, 'orphan.txt')])
    expect(existsSync(bucket)).toBe(false)
  })

  it('finds the orphaned root without being told where it is', async () => {
    const a = join(work, 'a.txt')
    writeFileSync(a, 'A')
    await trashItems([a]) // records the staging root it chose
    expect(await sweep()).toEqual([a]) // a fresh run has no idea which volume
  })

  it('is a no-op when staging is empty or absent', async () => {
    expect(await sweep([join(work, 'nope')])).toEqual([])
    expect(io.trashed).toEqual([])
  })
})

// D2: flush() swallowed trashItem failures and then unconditionally dropped the
// record, so on a volume with no Recycle Bin every delete leaked a staging
// bucket the user was never told about and could not remove through the app.
describe('D2 — staging must not leak where there is no Recycle Bin', () => {
  const staged = async () => {
    const src = join(work, 'a.txt')
    writeFileSync(src, 'hello')
    const [rec] = await stageInto(join(work, '.trash'), [src])
    return rec
  }

  it('flush keeps the record and its manifest when the Recycle Bin refuses', async () => {
    const rec = await staged()
    io.trashFails = true
    expect(await flush([rec])).toEqual([rec]) // surfaced, not silently dropped
    expect(existsSync(rec.staged)).toBe(true)
    expect(existsSync(manifestOf(rec.staged))).toBe(true)
  })

  it('leaves the bucket recoverable, so a later sweep retries it', async () => {
    const rec = await staged()
    io.trashFails = true
    await flush([rec])
    io.trashFails = false
    expect(await sweep([join(work, '.trash')])).toEqual([rec.original])
    expect(io.trashed).toEqual([rec.staged])
  })

  it('clears the bucket and manifest when the Recycle Bin accepts', async () => {
    const rec = await staged()
    expect(await flush([rec])).toEqual([])
    expect(existsSync(bucketOf(rec.staged))).toBe(false)
    expect(existsSync(manifestOf(rec.staged))).toBe(false)
  })
})

// D3: staging/restoring across volumes falls back to fs.cp, whose default
// preserveTimestamps:false leaves the restored file with a fresh access time —
// so a delete+undo round trip silently rewrote metadata a rename preserves.
describe('D3 — the EXDEV fallback preserves timestamps', () => {
  it('restore keeps the timestamps a same-volume rename would have kept', async () => {
    const OLD = new Date('2019-03-04T05:06:07.000Z')
    const src = join(work, 'a.txt')
    writeFileSync(src, 'hello')
    utimesSync(src, OLD, OLD)
    const records = await stageInto(join(work, '.trash'), [src])
    io.exdev = true
    await restore(records)
    const s = statSync(src)
    expect([s.atime.getTime(), s.mtime.getTime()]).toEqual([OLD.getTime(), OLD.getTime()])
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
