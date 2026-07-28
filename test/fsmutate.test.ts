import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir, newFile, rename, copy, move } from '../src/main/fsmutate'

let base: string

beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'ce-fsmutate-')) })
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
