import { describe, it, expect } from 'vitest'
import { applyEvent } from '../src/renderer/ptystatus'

describe('applyEvent', () => {
  it('marks a pty running on data', () => {
    const m = applyEvent(new Map(), { id: 'a', kind: 'data' })
    expect(m.get('a')).toBe('running')
  })
  it('marks waiting on idle', () => {
    let m = applyEvent(new Map(), { id: 'a', kind: 'data' })
    m = applyEvent(m, { id: 'a', kind: 'idle' })
    expect(m.get('a')).toBe('waiting')
  })
  it('marks stopped on exit and idle cannot revive it', () => {
    let m = applyEvent(new Map(), { id: 'a', kind: 'exit' })
    expect(m.get('a')).toBe('stopped')
    m = applyEvent(m, { id: 'a', kind: 'idle' })
    expect(m.get('a')).toBe('stopped')
  })
  it('returns the same Map reference when status is unchanged', () => {
    const m1 = applyEvent(new Map(), { id: 'a', kind: 'data' })
    const m2 = applyEvent(m1, { id: 'a', kind: 'data' })
    expect(m2).toBe(m1) // no transition -> no new map -> no re-render
  })
})
