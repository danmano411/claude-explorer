import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listDir, isHidden, humanizeFsError } from '../src/main/fs'

let base: string

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'ce-fs-'))
  mkdirSync(join(base, 'real'))
  writeFileSync(join(base, 'real', 'keep.txt'), 'payload')
  writeFileSync(join(base, 'plain.txt'), 'x')
  writeFileSync(join(base, '.hidden'), 'x')
  execFileSync('cmd', ['/c', 'mklink', '/J', join(base, 'link'), join(base, 'real')])
})

afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('listDir', () => {
  it('classifies a directory junction as a directory (D1)', async () => {
    const r = await listDir(base)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const link = r.entries.find((e) => e.name === 'link')!
    expect(link.isDirectory).toBe(true)
    expect(link.isSymlink).toBe(true)
  })

  it('marks a plain folder as not a symlink', async () => {
    const r = await listDir(base)
    if (!r.ok) return
    expect(r.entries.find((e) => e.name === 'real')!.isSymlink).toBe(false)
  })

  it('flags dotfiles as hidden', async () => {
    const r = await listDir(base)
    if (!r.ok) return
    expect(r.entries.find((e) => e.name === '.hidden')!.hidden).toBe(true)
    expect(r.entries.find((e) => e.name === 'plain.txt')!.hidden).toBe(false)
  })

  it('returns a typed reason instead of throwing on a missing folder (D4)', async () => {
    const r = await listDir(join(base, 'does-not-exist'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('No longer exists')
  })
})

describe('isHidden', () => {
  it('flags dotfiles and known Windows noise, case-insensitively', () => {
    expect(isHidden('.git')).toBe(true)
    expect(isHidden('Thumbs.db')).toBe(true)
    expect(isHidden('THUMBS.DB')).toBe(true)
    expect(isHidden('$Recycle.Bin')).toBe(true)
    expect(isHidden('src')).toBe(false)
  })
})

describe('humanizeFsError', () => {
  it('maps errno codes to plain English', () => {
    expect(humanizeFsError({ code: 'EACCES' })).toBe('Access denied')
    expect(humanizeFsError({ code: 'EBUSY' })).toBe('In use by another program')
    expect(humanizeFsError({})).toMatch(/Could not read/)
  })
})
