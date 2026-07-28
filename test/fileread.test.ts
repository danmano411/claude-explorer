import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTextFile, MAX_BYTES, MAX_LINES, MAX_CHARS } from '../src/main/fileread'

let base: string
const p = (name: string) => join(base, name)

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ce-fileread-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('readTextFile — normal text', () => {
  it('returns the content, untruncated, with a line count', async () => {
    writeFileSync(p('notes.txt'), 'alpha\nbeta\ngamma')
    const r = await readTextFile(p('notes.txt'))
    expect(r).toEqual({ ok: true, content: 'alpha\nbeta\ngamma', truncated: false, lines: 3 })
  })

  it('reports a missing file as an error, not as binary or toolarge', async () => {
    const r = await readTextFile(p('nope.txt'))
    expect(r).toEqual({ ok: false, kind: 'error', reason: 'No longer exists' })
  })

  it('reports a directory as an error', async () => {
    const r = await readTextFile(base)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.kind).toBe('error')
  })
})

describe('readTextFile — binary guard', () => {
  it('refuses a file containing a NUL byte', async () => {
    writeFileSync(p('img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]))
    const r = await readTextFile(p('img.png'))
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.kind).toBe('binary')
  })

  it('only sniffs the first 8KB, like git', async () => {
    writeFileSync(p('late.txt'), 'a'.repeat(9000) + '\0' + 'b')
    const r = await readTextFile(p('late.txt'))
    expect(r.ok).toBe(true)
  })
})

describe('readTextFile — size guard runs FIRST', () => {
  it('refuses a file over the byte cap', async () => {
    writeFileSync(p('big.log'), Buffer.alloc(MAX_BYTES + 1, 0x61))
    const r = await readTextFile(p('big.log'))
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.kind).toBe('toolarge')
  })

  // Order is the point: an oversized *binary* file must report 'toolarge',
  // which is only possible if stat() is consulted before any bytes are read.
  it('reports toolarge (not binary) for an oversized binary file', async () => {
    writeFileSync(p('big.bin'), Buffer.alloc(MAX_BYTES + 1, 0x00))
    const r = await readTextFile(p('big.bin'))
    expect(r.ok === false && r.kind).toBe('toolarge')
  })
})

describe('readTextFile — encoding', () => {
  it('strips a UTF-8 BOM', async () => {
    writeFileSync(p('bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi')]))
    const r = await readTextFile(p('bom.txt'))
    expect(r.ok === true && r.content).toBe('hi')
  })
})

describe('readTextFile — truncation', () => {
  it('caps the line count', async () => {
    writeFileSync(p('many.txt'), 'x\n'.repeat(MAX_LINES + 5000))
    const r = await readTextFile(p('many.txt'))
    expect(r.ok === true && r.truncated).toBe(true)
    expect(r.ok === true && r.lines).toBe(MAX_LINES)
    expect(r.ok === true && r.content.split('\n').length).toBe(MAX_LINES)
  })

  // A minified bundle is one enormous line: a line cap alone does nothing.
  it('caps total characters on a single enormous line', async () => {
    writeFileSync(p('bundle.min.js'), 'z'.repeat(MAX_CHARS + 500_000))
    const r = await readTextFile(p('bundle.min.js'))
    expect(r.ok === true && r.truncated).toBe(true)
    expect(r.ok === true && r.content.length).toBe(MAX_CHARS)
    expect(r.ok === true && r.lines).toBe(1)
  })
})
