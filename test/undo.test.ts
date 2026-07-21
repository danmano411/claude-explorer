import { describe, it, expect } from 'vitest'
import { UndoStack, type Command } from '../src/renderer/undo'

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
