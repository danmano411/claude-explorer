import { describe, it, expect, afterEach } from 'vitest'
import { UndoStack, renameCmd, deleteCmd, OpError, type Command } from '../src/renderer/undo'

function counter(log: string[], name: string): Command {
  return {
    label: name,
    do: async () => { log.push(`do:${name}`) },
    undo: async () => { log.push(`undo:${name}`) },
  }
}

describe('UndoStack', () => {
  it('run/undo/redo drive do and undo in order', async () => {
    const log: string[] = []
    const s = new UndoStack()
    await s.run(counter(log, 'A'))
    await s.run(counter(log, 'B'))
    expect(s.canUndo()).toBe(true)
    await s.undo()            // undo B
    await s.undo()            // undo A
    expect(s.canUndo()).toBe(false)
    await s.redo()            // redo A
    expect(log).toEqual(['do:A', 'do:B', 'undo:B', 'undo:A', 'do:A'])
  })
  it('a new run clears the redo future', async () => {
    const log: string[] = []
    const s = new UndoStack()
    await s.run(counter(log, 'A'))
    await s.undo()
    await s.run(counter(log, 'B'))
    expect(s.canRedo()).toBe(false)
  })
  it('evicts + notifies past a capacity limit', async () => {
    const evicted: string[] = []
    const s = new UndoStack(2, (c) => evicted.push(c.label))
    const log: string[] = []
    await s.run(counter(log, 'A'))
    await s.run(counter(log, 'B'))
    await s.run(counter(log, 'C')) // A falls off
    expect(evicted).toEqual(['A'])
  })
})

// The whole safety guarantee: a refused operation must never become undoable,
// because an undo entry for work that never happened corrupts the stack.
describe('policy refusal', () => {
  afterEach(() => { delete (globalThis as Record<string, unknown>).window })

  const stubApi = (result: unknown) => {
    ;(globalThis as Record<string, unknown>).window = { api: { fsRename: async () => result } }
  }

  it('throws OpError and leaves the undo stack empty when main denies', async () => {
    stubApi({ ok: false, code: 'DENIED', reason: 'A system folder. Switch to Developer mode if you really need this.' })
    const s = new UndoStack()
    await expect(s.run(renameCmd('C:\\Windows\\a', 'C:\\Windows\\b'))).rejects.toBeInstanceOf(OpError)
    expect(s.canUndo()).toBe(false)
  })

  it('carries the structured verdict so the caller can offer a confirmation', async () => {
    stubApi({ ok: false, code: 'NEEDS_CONFIRM', reason: 'Type CONFIRM to proceed.', typed: true })
    const s = new UndoStack()
    await s.run(renameCmd('C:\\Windows\\a', 'C:\\Windows\\b')).catch((e: unknown) => {
      expect(e).toBeInstanceOf(OpError)
      if (e instanceof OpError) expect(e.result).toMatchObject({ code: 'NEEDS_CONFIRM', typed: true })
    })
    expect(s.canUndo()).toBe(false)
  })

  it('pushes normally when main allows', async () => {
    stubApi({ ok: true, value: undefined })
    const s = new UndoStack()
    await s.run(renameCmd('C:\\Users\\dan\\a', 'C:\\Users\\dan\\b'))
    expect(s.canUndo()).toBe(true)
  })

  it('deleteCmd.undo surfaces a refused restore instead of swallowing it', async () => {
    ;(globalThis as Record<string, unknown>).window = {
      api: {
        fsDelete: async () => ({ ok: true, value: [] }),
        fsRestore: async () => ({ ok: false, code: 'DENIED', reason: 'Restore target is gone.' }),
      },
    }
    const s = new UndoStack()
    await s.run(deleteCmd(['C:\\Users\\dan\\a']))
    await expect(s.undo()).rejects.toBeInstanceOf(OpError)
  })
})

// A failed undo must not consume the entry: otherwise Ctrl+Z looks like a no-op
// and the NEXT Ctrl+Z reverses an unrelated earlier operation.
describe('failed undo/redo leaves the stacks untouched', () => {
  const flaky = (log: string[], name: string, fails: () => boolean): Command => ({
    label: name,
    do: async () => { if (fails()) throw new Error(`do:${name} failed`); log.push(`do:${name}`) },
    undo: async () => { if (fails()) throw new Error(`undo:${name} failed`); log.push(`undo:${name}`) },
  })

  it('a rejected undo keeps the same command on top of past', async () => {
    const log: string[] = []
    const s = new UndoStack()
    let broken = false
    await s.run(counter(log, 'A'))
    await s.run(flaky(log, 'B', () => broken))
    broken = true
    await expect(s.undo()).rejects.toThrow('undo:B failed')
    expect(s.canUndo()).toBe(true)
    expect(s.canRedo()).toBe(false)   // and it did not land in the future either
    broken = false
    await s.undo()                    // must retry B, NOT reverse A
    expect(log).toEqual(['do:A', 'do:B', 'undo:B'])
  })

  it('a rejected redo keeps the same command at the head of future', async () => {
    const log: string[] = []
    const s = new UndoStack()
    let broken = false
    await s.run(flaky(log, 'A', () => broken))
    await s.run(counter(log, 'B'))
    await s.undo(); await s.undo()    // future = [A, B]; redo replays A first
    broken = true
    await expect(s.redo()).rejects.toThrow('do:A failed')
    expect(s.canRedo()).toBe(true)
    broken = false
    await s.redo()                    // must retry A, NOT jump to B
    expect(log).toEqual(['do:A', 'do:B', 'undo:B', 'undo:A', 'do:A'])
  })
})
