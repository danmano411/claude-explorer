import { describe, it, expect } from 'vitest'
import { SESSION_CAP, relTime, topSessions } from '../src/renderer/filemenu'
import type { ClaudeSession } from '../src/shared/types'

const s = (id: string, updated: number): ClaudeSession =>
  ({ id, folderPath: 'C:\\repo', title: id, updated })

describe('topSessions', () => {
  it('sorts newest-first', () => {
    const out = topSessions([s('old', 100), s('new', 300), s('mid', 200)])
    expect(out.map((x) => x.id)).toEqual(['new', 'mid', 'old'])
  })

  it('caps the list at SESSION_CAP', () => {
    const many = Array.from({ length: 50 }, (_, i) => s(`s${i}`, i))
    expect(topSessions(many)).toHaveLength(SESSION_CAP)
    // and the cap keeps the NEWEST, not the first 20 off the wire
    expect(topSessions(many)[0].id).toBe('s49')
  })

  it('does not mutate its input', () => {
    const list = [s('old', 100), s('new', 300)]
    topSessions(list)
    expect(list.map((x) => x.id)).toEqual(['old', 'new'])
  })

  it('survives an empty list', () => {
    expect(topSessions([])).toEqual([])
  })
})

describe('relTime', () => {
  const now = Date.UTC(2026, 0, 20, 12, 0, 0)
  const ago = (ms: number) => relTime(now - ms, now)
  const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR

  it('reads compactly across the ladder', () => {
    expect(ago(5_000)).toBe('just now')
    expect(ago(9 * MIN)).toBe('9m ago')
    expect(ago(2 * HOUR)).toBe('2h ago')
    expect(ago(23 * HOUR)).toBe('23h ago')
    expect(ago(25 * HOUR)).toBe('yesterday')
    expect(ago(3 * DAY)).toBe('3d ago')
  })

  it('falls back to a date past a week', () => {
    expect(ago(30 * DAY)).toBe(new Date(now - 30 * DAY).toLocaleDateString())
  })

  it('never reads as negative when a clock skews forward', () => {
    expect(relTime(now + 10 * MIN, now)).toBe('just now')
  })
})
