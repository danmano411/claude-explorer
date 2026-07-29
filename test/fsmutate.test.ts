import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync, utimesSync, statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A real cross-volume move needs a second writable volume, which CI does not
// have — rename is mocked to raise EXDEV so the copy+delete fallback itself is
// what gets exercised. Off by default, so every other test uses the real fs.
const io = vi.hoisted(() => ({ exdev: false }))
vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>()
  return {
    ...real,
    default: real,
    rename: async (a: string, b: string) => {
      if (io.exdev) throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' })
      return real.rename(a, b)
    },
  }
})

const { mkdir, newFile, rename, copy, move } = await import('../src/main/fsmutate')
const { moveCmd } = await import('../src/renderer/undo')

let base: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ce-fsmutate-'))
  io.exdev = false
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

// D3: parent-path computation must use winDirname, not
// `path.slice(0, path.lastIndexOf('\\'))`. The latter returns -1 for a
// forward-slash path, so slice(0,-1) silently truncates the last character and
// the create lands in a non-existent directory.
describe('D3 — parent path uses winDirname', () => {
  it('mkdir works with forward-slash separators', async () => {
    const created = await mkdir(`${base.replace(/\\/g, '/')}/newdir`)
    expect(existsSync(created)).toBe(true)
    expect(existsSync(join(base, 'newdir'))).toBe(true)
  })

  it('newFile works with forward-slash separators', async () => {
    const created = await newFile(`${base.replace(/\\/g, '/')}/new.txt`)
    expect(existsSync(created)).toBe(true)
    expect(existsSync(join(base, 'new.txt'))).toBe(true)
  })

  it('mkdir still works with backslash separators', async () => {
    const created = await mkdir(join(base, 'backslash'))
    expect(existsSync(created)).toBe(true)
  })

  // D6: the second D3 call site. moveCmd's undo() moves the item back to
  // winDirname(src); the old `src.slice(0, src.lastIndexOf('\\'))` returns -1
  // for a forward-slash path and silently truncates the last character, so undo
  // would target a directory that does not exist. Lives here because this is
  // the D3 regression suite — the code under test is src/renderer/undo.ts.
  it('moveCmd undoes back to the real parent of a forward-slash path', async () => {
    const calls: Array<[string, string]> = []
    ;(globalThis as Record<string, unknown>).window = {
      api: {
        fsMove: async (src: string, destDir: string) => {
          calls.push([src, destDir])
          return { ok: true, value: `${destDir}\\f.txt` }
        },
      },
    }
    try {
      const cmd = moveCmd('C:/Users/dan/proj/f.txt', 'C:\\Users\\dan\\other')
      await cmd.do()
      await cmd.undo()
      expect(calls[1]).toEqual(['C:\\Users\\dan\\other\\f.txt', 'C:/Users/dan/proj'])
    } finally {
      delete (globalThis as Record<string, unknown>).window
    }
  })
})

// D3 (deferred): a same-volume move is a rename and preserves everything; the
// EXDEV fallback is an fs.cp, which without preserveTimestamps leaves the copy
// with a fresh access time. (Measured: on Windows CopyFileW carries the LAST
// WRITE time across on its own, so mtime survives either way — atime is the
// half the flag actually buys, and asserting only mtime here would be a test
// that can never go red.)
describe('D3 — cross-volume fallbacks preserve timestamps', () => {
  const OLD = new Date('2019-03-04T05:06:07.000Z')
  const times = (p: string) => {
    const s = statSync(p)
    return [s.atime.getTime(), s.mtime.getTime()]
  }
  const aged = (name: string) => {
    const p = join(base, name)
    writeFileSync(p, 'x')
    utimesSync(p, OLD, OLD)
    return p
  }

  it('copy keeps the source timestamps', async () => {
    const src = aged('old.txt')
    mkdirSync(join(base, 'dest'))
    const out = await copy(src, join(base, 'dest'))
    expect(times(out)).toEqual([OLD.getTime(), OLD.getTime()])
  })

  it('move keeps the source timestamps when rename reports EXDEV', async () => {
    const src = aged('old.txt')
    mkdirSync(join(base, 'dest'))
    io.exdev = true
    const out = await move(src, join(base, 'dest'))
    expect(existsSync(src)).toBe(false)
    expect(times(out)).toEqual([OLD.getTime(), OLD.getTime()])
  })

  it('move keeps timestamps of files inside a copied directory', async () => {
    mkdirSync(join(base, 'tree'))
    const inner = join(base, 'tree', 'old.txt')
    writeFileSync(inner, 'x')
    utimesSync(inner, OLD, OLD)
    mkdirSync(join(base, 'dest'))
    io.exdev = true
    const out = await move(join(base, 'tree'), join(base, 'dest'))
    expect(times(join(out, 'old.txt'))).toEqual([OLD.getTime(), OLD.getTime()])
  })
})

// rename() was a bare fs.rename. On Windows libuv passes
// MOVEFILE_REPLACE_EXISTING, so renaming onto an existing file destroys it
// permanently: no prompt, no trash staging, no Recycle Bin, no undo.
describe('rename — collision', () => {
  it('refuses to overwrite an existing file', async () => {
    writeFileSync(join(base, 'notes.txt'), 'keep me')
    writeFileSync(join(base, 'notes-old.txt'), 'old')

    await expect(rename(join(base, 'notes-old.txt'), join(base, 'notes.txt'))).rejects.toThrow()

    expect(readFileSync(join(base, 'notes.txt'), 'utf8')).toBe('keep me')
    expect(existsSync(join(base, 'notes-old.txt'))).toBe(true)
  })

  it('refuses to overwrite an existing directory', async () => {
    mkdirSync(join(base, 'target'))
    writeFileSync(join(base, 'target', 'inside.txt'), 'keep me')
    mkdirSync(join(base, 'src'))

    await expect(rename(join(base, 'src'), join(base, 'target'))).rejects.toThrow()
    expect(existsSync(join(base, 'target', 'inside.txt'))).toBe(true)
  })

  // Windows volumes are case-insensitive: the target "exists" but IS the
  // source. A naive exists() guard would break plain case corrections.
  it('still allows a case-only rename', async () => {
    writeFileSync(join(base, 'notes.txt'), 'x')
    await rename(join(base, 'notes.txt'), join(base, 'Notes.txt'))
    expect(readFileSync(join(base, 'Notes.txt'), 'utf8')).toBe('x')
  })
})

// move()/copy() gate destDir but write to join(destDir, winBasename(src)).
// winBasename('...\\payload\\..') is '..', which path.join collapses — the
// write lands OUTSIDE the directory the policy gate approved, and uniqueName
// cannot catch it because readdir never returns '..'.
describe('copy/move — dot basename must not escape the gated directory', () => {
  beforeEach(() => {
    mkdirSync(join(base, 'data', 'payload'), { recursive: true })
    writeFileSync(join(base, 'data', 'payload', 'marker.txt'), 'payload')
  })

  it('copy rejects a ".." basename instead of writing above destDir', async () => {
    mkdirSync(join(base, 'gate', 'inner'), { recursive: true })
    const src = join(base, 'data', 'payload') + '\\..'

    await expect(copy(src, join(base, 'gate', 'inner'))).rejects.toThrow()
    expect(existsSync(join(base, 'gate', 'payload'))).toBe(false)
  })

  it('move rejects a ".." basename instead of writing above destDir', async () => {
    const src = join(base, 'data', 'payload') + '\\..'

    await expect(move(src, join(base, 'gate', 'inner'))).rejects.toThrow()
    expect(existsSync(join(base, 'gate'))).toBe(false)
    expect(existsSync(join(base, 'data', 'payload', 'marker.txt'))).toBe(true)
  })

  it('copy rejects a "." basename', async () => {
    mkdirSync(join(base, 'gate', 'inner'), { recursive: true })
    const src = join(base, 'data', 'payload') + '\\.'

    await expect(copy(src, join(base, 'gate', 'inner'))).rejects.toThrow()
    expect(existsSync(join(base, 'gate', 'inner', 'marker.txt'))).toBe(false)
  })
})
