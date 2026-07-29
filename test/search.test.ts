import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => 'C:\\app' },
}))

const { buildArgs, makeLineSplitter, hitFromJsonLine, nameMatches } = await import('../src/main/search')

const q = (over: Partial<Parameters<typeof buildArgs>[0]> = {}) => ({
  root: 'C:\\repo',
  query: 'needle',
  content: true,
  regex: false,
  caseSensitive: false,
  includeIgnored: false,
  ...over,
})

describe('buildArgs', () => {
  it('literal, case-insensitive content search by default', () => {
    const a = buildArgs(q())
    expect(a).toContain('--json')
    expect(a).toContain('--fixed-strings')
    expect(a).toContain('--ignore-case')
    expect(a).not.toContain('-uu')
    expect(a.slice(-2)).toEqual(['needle', 'C:\\repo'])
  })

  it('regex mode drops --fixed-strings', () => {
    expect(buildArgs(q({ regex: true }))).not.toContain('--fixed-strings')
  })

  it('case-sensitive drops --ignore-case', () => {
    expect(buildArgs(q({ caseSensitive: true }))).not.toContain('--ignore-case')
  })

  it('developer mode searches ignored and hidden files', () => {
    expect(buildArgs(q({ includeIgnored: true }))).toContain('-uu')
  })

  it('name search lists files instead of reading them', () => {
    const a = buildArgs(q({ content: false }))
    expect(a).toContain('--files')
    expect(a).not.toContain('--json')
    // The query must NOT be passed to rg — names are matched in-process.
    expect(a).not.toContain('needle')
    expect(a.slice(-1)).toEqual(['C:\\repo'])
  })

  it('passes -- before positionals so a leading-dash query is not read as a flag', () => {
    const a = buildArgs(q({ query: '--oops' }))
    expect(a.indexOf('--')).toBeGreaterThan(-1)
    expect(a.indexOf('--')).toBeLessThan(a.indexOf('--oops'))
  })
})

describe('makeLineSplitter', () => {
  it('emits whole lines only', () => {
    const seen: string[] = []
    const s = makeLineSplitter((l) => seen.push(l))
    s.push('one\ntwo\n')
    expect(seen).toEqual(['one', 'two'])
  })

  // The bug a per-chunk split('\n') would ship: ripgrep's JSON objects are one
  // per line, and chunk boundaries land mid-object constantly on large results.
  it('reassembles a line split across chunk boundaries', () => {
    const seen: string[] = []
    const s = makeLineSplitter((l) => seen.push(l))
    s.push('{"type":"ma')
    s.push('tch"}\n')
    expect(seen).toEqual(['{"type":"match"}'])
  })

  it('holds a partial trailing line until flush', () => {
    const seen: string[] = []
    const s = makeLineSplitter((l) => seen.push(l))
    s.push('complete\npartial')
    expect(seen).toEqual(['complete'])
    s.flush()
    expect(seen).toEqual(['complete', 'partial'])
  })

  it('strips CR so Windows line endings do not corrupt JSON', () => {
    const seen: string[] = []
    const s = makeLineSplitter((l) => seen.push(l))
    s.push('{"a":1}\r\n')
    expect(seen).toEqual(['{"a":1}'])
    expect(() => JSON.parse(seen[0])).not.toThrow()
  })
})

describe('hitFromJsonLine', () => {
  const match = JSON.stringify({
    type: 'match',
    data: {
      path: { text: 'C:\\repo\\src\\app.ts' },
      line_number: 12,
      lines: { text: 'const needle = 1\n' },
      submatches: [{ start: 6 }],
    },
  })

  it('maps a match event to a hit', () => {
    const h = hitFromJsonLine(match)
    expect(h).toMatchObject({
      path: 'C:\\repo\\src\\app.ts',
      name: 'app.ts',
      line: 12,
      column: 7, // 0-based byte offset -> 1-based column
      preview: 'const needle = 1',
    })
  })

  it('ignores begin/end/summary events', () => {
    expect(hitFromJsonLine(JSON.stringify({ type: 'begin' }))).toBeNull()
    expect(hitFromJsonLine(JSON.stringify({ type: 'summary' }))).toBeNull()
  })

  it('survives a non-JSON line instead of throwing', () => {
    expect(hitFromJsonLine('not json at all')).toBeNull()
  })

  it('drops a match whose path is bytes rather than text (non-UTF8 name)', () => {
    const bytes = JSON.stringify({ type: 'match', data: { path: { bytes: 'x9w=' } } })
    expect(hitFromJsonLine(bytes)).toBeNull()
  })

  it('caps a very long preview so one minified line cannot blow up the overlay', () => {
    const long = JSON.stringify({
      type: 'match',
      data: { path: { text: 'C:\\a\\b.js' }, line_number: 1, lines: { text: 'x'.repeat(50_000) } },
    })
    expect(hitFromJsonLine(long)!.preview!.length).toBe(300)
  })
})

describe('nameMatches', () => {
  it('matches on the basename, not the directory', () => {
    // 'repo' appears in the directory but not the filename.
    expect(nameMatches('C:\\repo\\src\\app.ts', 'repo', false)).toBe(false)
    expect(nameMatches('C:\\repo\\src\\app.ts', 'app', false)).toBe(true)
  })

  it('is case-insensitive unless asked otherwise', () => {
    expect(nameMatches('C:\\x\\README.md', 'readme', false)).toBe(true)
    expect(nameMatches('C:\\x\\README.md', 'readme', true)).toBe(false)
  })
})
