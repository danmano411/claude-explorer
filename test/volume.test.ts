import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isWindows } from '../src/shared/pathutil'
import { sameVolume, volumeRootOf } from '../src/main/volume'

// KAN-89. sameVolume/volumeRootOf are what "same drive is a move, cross-drive
// is a copy" and same-volume trash staging now ask. On Windows they must be the
// pre-existing string arithmetic exactly; on POSIX they must be a real st_dev
// test, because a wrong answer there turns undo into a cross-device copy.

describe.skipIf(!isWindows)('sameVolume — Windows is still a pure string compare', () => {
  it('matches the same drive letter regardless of case', async () => {
    expect(await sameVolume('C:\\a', 'c:\\b')).toBe(true)
  })
  it('separates two drive letters', async () => {
    expect(await sameVolume('C:\\a', 'D:\\a')).toBe(false)
  })
  it('does NOT treat two different UNC shares as one volume', async () => {
    expect(await sameVolume('\\\\alpha\\one\\x', '\\\\beta\\two\\y')).toBe(false)
  })
  it('matches the same UNC share', async () => {
    expect(await sameVolume('\\\\alpha\\one\\x', '\\\\alpha\\one\\y')).toBe(true)
  })
  it('answers for paths that do not exist — no stat, so nothing to stall on', async () => {
    expect(await sameVolume('C:\\nope\\a', 'C:\\also-nope\\b')).toBe(true)
  })
})

// The POSIX arms are unreachable by calling the exports on Windows, so
// re-import with process.platform forced. node:path is NOT reset by
// vi.resetModules, so `dirname` stays the host's — which is what lets the
// st_dev climb run against real files here.
const asPosix = await (async () => {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  vi.resetModules()
  const mod = await import('../src/main/volume')
  Object.defineProperty(process, 'platform', real)
  vi.resetModules()
  return mod
})()

describe('sameVolume — the POSIX arm compares st_dev, not strings', () => {
  const setup = () => mkdtempSync(join(tmpdir(), 'ce-vol-'))

  it('two paths under one device are the same volume', async () => {
    const w = setup()
    try {
      const a = join(w, 'a.txt')
      const b = join(w, 'sub')
      writeFileSync(a, 'A')
      mkdirSync(b)
      expect(await asPosix.sameVolume(a, b)).toBe(true)
    } finally {
      rmSync(w, { recursive: true, force: true })
    }
  })

  it('a path that cannot be stat\'ed answers false — copy, which keeps the source', async () => {
    const w = setup()
    try {
      const a = join(w, 'a.txt')
      writeFileSync(a, 'A')
      expect(await asPosix.sameVolume(a, join(w, 'does-not-exist'))).toBe(false)
      // ...and it is the STAT failing, not the strings differing: the Windows
      // arm says true for this very pair (same drive letter).
      expect(await sameVolume(a, join(w, 'does-not-exist'))).toBe(isWindows)
    } finally {
      rmSync(w, { recursive: true, force: true })
    }
  })

  it('volumeRootOf climbs to the device boundary and terminates', async () => {
    const w = setup()
    try {
      const deep = join(w, 'x', 'y')
      mkdirSync(deep, { recursive: true })
      const root = await asPosix.volumeRootOf(deep)
      // Every ancestor of a temp dir is on one device here, so the climb can
      // only stop at the filesystem root — reached, not run away.
      expect(root.length).toBeGreaterThan(0)
      expect(deep.startsWith(root)).toBe(true)
      expect(root.length).toBeLessThan(w.length)
    } finally {
      rmSync(w, { recursive: true, force: true })
    }
  })

  it('volumeRootOf still answers for a path that is already gone (describeStuck reports on deleted originals)', async () => {
    const w = setup()
    try {
      const deep = join(w, 'x', 'y')
      mkdirSync(deep, { recursive: true })
      const alive = await asPosix.volumeRootOf(deep)
      const dead = await asPosix.volumeRootOf(join(deep, 'deleted', 'file.txt'))
      expect(dead).toBe(alive)
    } finally {
      rmSync(w, { recursive: true, force: true })
    }
  })
})
