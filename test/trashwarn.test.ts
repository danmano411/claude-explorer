import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// KAN-32: flush() (and, at startup, sweep()) already KEEPS a record it could not
// hand to the Recycle Bin (D-2) — the data side is fine. This tests the missing
// user-facing side: a failed flush must leave a pending warning describing what
// happened, so main can hand it to the renderer once a window is listening.
const io = vi.hoisted(() => ({ trashFails: false }))

vi.mock('electron', () => ({
  app: { getPath: () => '' }, // unused by stageInto/flush directly; trash.ts imports it at module scope
  shell: {
    trashItem: async () => {
      // A volume with no Recycle Bin (network share, removable) rejects here.
      if (io.trashFails) throw new Error('no recycle bin on this volume')
    },
  },
}))

// stageInto/flush are the "test-friendly core" (no Electron path resolution
// involved), so no node:fs/node:fs/promises mocking is needed here — real tmp
// dir I/O, same as the happy-path tests in trash.test.ts.
const { stageInto, flush, takePendingTrashWarn, driveRootOf } = await import('../src/main/trash')

let work: string
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'ce-trashwarn-'))
  io.trashFails = false
})
afterEach(() => rmSync(work, { recursive: true, force: true }))

describe('KAN-32 — pending trash warning', () => {
  it('a flush that cannot reach the Recycle Bin leaves a pending warning with the count and volume', async () => {
    const a = join(work, 'a.txt')
    const b = join(work, 'b.txt')
    writeFileSync(a, 'A')
    writeFileSync(b, 'B')
    const records = await stageInto(join(work, '.trash'), [a, b])
    io.trashFails = true
    expect(await flush(records)).toHaveLength(2) // still kept, per D-2 — unchanged by this ticket
    expect(takePendingTrashWarn()).toEqual({ count: 2, volume: driveRootOf(a) })
  })

  it('a fully successful flush leaves no pending warning', async () => {
    const a = join(work, 'a.txt')
    writeFileSync(a, 'A')
    const records = await stageInto(join(work, '.trash'), [a])
    expect(await flush(records)).toEqual([])
    expect(takePendingTrashWarn()).toBeNull()
  })

  it('reading the pending warning clears it, so it is delivered at most once', async () => {
    const a = join(work, 'a.txt')
    writeFileSync(a, 'A')
    const records = await stageInto(join(work, '.trash'), [a])
    io.trashFails = true
    await flush(records)
    expect(takePendingTrashWarn()).not.toBeNull()
    expect(takePendingTrashWarn()).toBeNull()
  })
})
