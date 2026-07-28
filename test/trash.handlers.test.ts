import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { TrashRecord } from '../src/shared/types'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  mode: 'explorer' as 'explorer' | 'developer',
  restored: [] as TrashRecord[],
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => h.handlers.set(ch, fn) },
  shell: { trashItem: vi.fn() },
  app: { getPath: () => 'C:\\userData' },
}))
vi.mock('../src/main/settings', () => ({
  getSettings: () => ({ mode: h.mode, ideCommand: 'code' }),
}))
vi.mock('../src/main/trash', () => ({
  trashItems: vi.fn(async () => []),
  restoreAndUntrack: vi.fn(async (records: TrashRecord[]) => {
    h.restored.push(...records)
  }),
}))

import { CH } from '../src/shared/ipc'
import { registerTrashHandlers } from '../src/main/trash.handlers'
import type { OpResult } from '../src/shared/types'

const rec = (original: string, staged: string): TrashRecord => ({
  original,
  staged,
  name: original.split('\\').pop()!,
})
const STAGED = 'C:\\.claude-explorer-trash\\uuid\\a.txt'

const restore = (records: TrashRecord[], confirm?: string) =>
  h.handlers.get(CH.fsRestore)!({}, records, confirm) as Promise<OpResult<void>>

beforeEach(() => {
  h.handlers.clear()
  h.restored.length = 0
  h.mode = 'explorer'
  registerTrashHandlers()
})

describe('fs:restore is policy-gated', () => {
  it('refuses a restore whose original path targets a system root', async () => {
    const res = await restore([rec('C:\\Windows\\System32\\evil.dll', STAGED)])
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.code).toBe('DENIED')
    expect(h.restored).toHaveLength(0)
  })

  it('refuses a restore whose original path targets a drive root', async () => {
    const res = await restore([rec('C:\\', STAGED)])
    expect(res.ok).toBe(false)
    expect(h.restored).toHaveLength(0)
  })

  it('gates the staged source too when it is not a trash-staging path', async () => {
    const res = await restore([rec('C:\\Users\\dan\\a.txt', 'C:\\Windows\\notepad.exe')])
    expect(res.ok).toBe(false)
    expect(h.restored).toHaveLength(0)
  })

  it('still restores out of the trash staging dir (undo must keep working)', async () => {
    const res = await restore([rec('C:\\Users\\dan\\a.txt', STAGED)])
    expect(res).toEqual({ ok: true, value: undefined })
    expect(h.restored).toHaveLength(1)
  })

  it('asks for typed confirmation in developer mode, then proceeds', async () => {
    h.mode = 'developer'
    const records = [rec('C:\\Windows\\System32\\evil.dll', STAGED)]
    const first = await restore(records)
    expect(first.ok === false && first.code).toBe('NEEDS_CONFIRM')
    expect(h.restored).toHaveLength(0)
    const second = await restore(records, 'CONFIRM')
    expect(second.ok).toBe(true)
    expect(h.restored).toHaveLength(1)
  })

  it('wraps a failing restore as an ERROR OpResult', async () => {
    const { restoreAndUntrack } = await import('../src/main/trash')
    vi.mocked(restoreAndUntrack).mockRejectedValueOnce(
      Object.assign(new Error('nope'), { code: 'EACCES' }),
    )
    const res = await restore([rec('C:\\Users\\dan\\a.txt', STAGED)])
    expect(res).toEqual({ ok: false, code: 'ERROR', reason: 'Access denied' })
  })
})
