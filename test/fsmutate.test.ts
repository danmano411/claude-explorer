import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir, newFile } from '../src/main/fsmutate'

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
