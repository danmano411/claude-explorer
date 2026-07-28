import { describe, it, expect, afterEach } from 'vitest'
import { UndoStack, renameCmd, OpError, type Command } from '../src/renderer/undo'

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
})
