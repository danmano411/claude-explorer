import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stageInto, restore } from '../src/main/trash'

let work: string
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'ce-trash-')) })
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
    const { readdirSync } = await import('node:fs')
    expect(readdirSync(work).filter((n) => n.startsWith('a')).length).toBe(2)
  })
})
