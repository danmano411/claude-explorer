import { describe, it, expect, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import type { ClaudeSession } from '../src/shared/types'

// menu.ts imports `Menu`/`BrowserWindow` from 'electron' at module scope (used
// by target()/buildMenu(), neither of which fileSubmenu/relTime touch) and
// transitively imports `./recents`, which imports `app`. None of these are
// actually invoked by the tests below — fileSubmenu is documented as pure
// (no Electron calls, no disk, no clock) — but the module can't load outside
// an Electron process without stubs for the names it destructures.
vi.mock('electron', () => ({
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
  BrowserWindow: { getFocusedWindow: () => undefined, getAllWindows: () => [] },
  app: { getPath: () => 'C:\\fake\\userData' },
}))

const { fileSubmenu, relTime } = await import('../src/main/menu')
type FolderSessions = { path: string; sessions: ClaudeSession[] }

const session = (id: string, title: string, updated: number): ClaudeSession =>
  ({ id, folderPath: 'C:\\repo', title, updated })

// Actions are captured, not executed, so a test can assert *which* action a
// given row's click fired without a real IPC channel or window.
function actionSpy() {
  const command = vi.fn()
  const sessionFn = vi.fn()
  return { command, sessionFn, actions: { command, session: sessionFn } }
}

// Menu templates nest via `submenu`; ids are the only stable handle a
// Playwright harness (or this test) has, so every lookup goes through this.
function findById(items: MenuItemConstructorOptions[], id: string): MenuItemConstructorOptions | undefined {
  for (const item of items) {
    if (item.id === id) return item
    if (Array.isArray(item.submenu)) {
      const hit = findById(item.submenu, id)
      if (hit) return hit
    }
  }
  return undefined
}

describe('fileSubmenu — static items', () => {
  it('New Tab and Close Tab carry stable ids and fire the command channel', () => {
    const { command, actions } = actionSpy()
    const tree = fileSubmenu([], actions)

    const newTab = findById(tree, 'file:new-tab')!
    expect(newTab.label).toBe('New Tab')
    ;(newTab.click as () => void)()
    expect(command).toHaveBeenCalledWith('new-tab')

    const closeTab = findById(tree, 'file:close-tab')!
    expect(closeTab.label).toBe('Close Tab')
    ;(closeTab.click as () => void)()
    expect(command).toHaveBeenCalledWith('close-tab')
  })
})

describe('fileSubmenu — folder rows', () => {
  const folders: FolderSessions[] = [
    { path: 'C:\\repo-a', sessions: [session('s-a1', 'first prompt A', 1000)] },
    { path: 'C:\\repo-b', sessions: [session('s-b1', 'first prompt B', 2000)] },
  ]

  it('builds one row per recent folder, in the given order, with recent:<i> ids', () => {
    const { actions } = actionSpy()
    const tree = fileSubmenu(folders, actions)
    const openRecent = tree.find((i) => i.label === 'Open Recent')!
    const rows = openRecent.submenu as MenuItemConstructorOptions[]
    // A regression that reversed the fixture, or renumbered ids off a sorted
    // copy instead of the input array, would move repo-b to index 0 here.
    expect(rows.map((r) => r.id)).toEqual(['recent:0', 'recent:1'])
    expect(rows.map((r) => r.label)).toEqual(['C:\\repo-a', 'C:\\repo-b'])
  })

  it('a folder row click fires command(open-path, <that folder path>)', () => {
    const { command, actions } = actionSpy()
    const tree = fileSubmenu(folders, actions)
    const row = findById(tree, 'recent:1')!
    ;(row.click as () => void)()
    // Catches an off-by-one if the click closure captures the map callback's
    // index/array by reference instead of the closed-over `f` for this row.
    expect(command).toHaveBeenCalledWith('open-path', 'C:\\repo-b')
  })

  it('escapes a literal & in a folder path so Windows does not eat it as a mnemonic', () => {
    const { actions } = actionSpy()
    const tree = fileSubmenu([{ path: 'C:\\A & B', sessions: [] }], actions)
    const row = findById(tree, 'recent:0')!
    // Without amp(), Menu.buildFromTemplate would render "C:\A B" with an
    // underlined B — the & itself silently disappears.
    expect(row.label).toBe('C:\\A && B')
  })
})

describe('fileSubmenu — session rows', () => {
  it('lists "+ New session" first, then the given sessions in the order provided', () => {
    const { actions } = actionSpy()
    const MIN = 60_000
    const now = 10 * 3_600_000 // arbitrary fixed instant, well clear of any boundary
    const folders: FolderSessions[] = [{
      path: 'C:\\repo',
      sessions: [session('newest', 'most recent', now - 5 * MIN), session('older', 'earlier', now - 50 * MIN)],
    }]
    const tree = fileSubmenu(folders, actions, now)
    const submenu = findById(tree, 'recent:0')!.submenu as MenuItemConstructorOptions[]

    expect(submenu[0].id).toBe('recent:0:new')
    // Plain ASCII "+" — the old renderer used the fullwidth U+FF0B; a
    // regression reintroducing that glyph would fail this exact match.
    expect(submenu[0].label).toBe('+ New session')
    expect(submenu[1].type).toBe('separator')
    expect(submenu.slice(2).map((s) => s.id)).toEqual(['recent:0:session:0', 'recent:0:session:1'])
    // Row order mirrors input order (the caller, listSessions, is what sorts
    // newest-first and caps — covered in sessions.test.ts) — a regression
    // that resorted or reversed inside fileSubmenu would swap these two.
    // The three-space gap between title and relTime is exact per the frozen
    // label format; a single-space regression would fail this match too.
    expect(submenu.slice(2).map((s) => s.label)).toEqual([
      'most recent   5m ago',
      'earlier   50m ago',
    ])
  })

  it('caps at whatever length the caller passed, without adding or dropping rows', () => {
    const { actions } = actionSpy()
    const many = Array.from({ length: 20 }, (_, i) => session(`s${i}`, `title ${i}`, i))
    const tree = fileSubmenu([{ path: 'C:\\repo', sessions: many }], actions)
    const submenu = findById(tree, 'recent:0')!.submenu as MenuItemConstructorOptions[]
    // "+ New session" + separator + 20 rows. Off-by-one here would mean the
    // template builder itself is truncating or duplicating, independent of
    // whatever cap listSessions already applied to its input.
    expect(submenu).toHaveLength(22)
    expect(submenu.slice(2).map((s) => s.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => `recent:0:session:${i}`),
    )
  })

  it('"+ New session" click fires session(path) with no resumeId', () => {
    const { sessionFn, actions } = actionSpy()
    const folders: FolderSessions[] = [{ path: 'C:\\repo', sessions: [session('s1', 't', 0)] }]
    const tree = fileSubmenu(folders, actions)
    const newRow = findById(tree, 'recent:0:new')!
    ;(newRow.click as () => void)()
    // A regression that passed a stray resumeId here would resume the wrong
    // (or a nonexistent) session instead of starting a fresh one.
    expect(sessionFn).toHaveBeenCalledWith('C:\\repo')
    expect(sessionFn.mock.calls[0].length).toBe(1)
  })

  it('a session row click fires session(path, that session\'s id)', () => {
    const { sessionFn, actions } = actionSpy()
    const folders: FolderSessions[] = [{
      path: 'C:\\repo',
      sessions: [session('sess-a', 'a', 0), session('sess-b', 'b', 0)],
    }]
    const tree = fileSubmenu(folders, actions)
    const row = findById(tree, 'recent:0:session:1')!
    ;(row.click as () => void)()
    // Catches the row's click closing over the wrong loop variable/session.
    expect(sessionFn).toHaveBeenCalledWith('C:\\repo', 'sess-b')
  })
})

describe('fileSubmenu — empty states', () => {
  it('shows a disabled placeholder when there are no recent folders', () => {
    const { actions } = actionSpy()
    const tree = fileSubmenu([], actions)
    const openRecent = tree.find((i) => i.label === 'Open Recent')!
    const rows = openRecent.submenu as MenuItemConstructorOptions[]
    expect(rows).toEqual([{ label: 'No recent folders', enabled: false }])
  })

  it('shows a disabled placeholder for a folder with zero sessions', () => {
    const { actions } = actionSpy()
    const tree = fileSubmenu([{ path: 'C:\\repo', sessions: [] }], actions)
    const submenu = findById(tree, 'recent:0')!.submenu as MenuItemConstructorOptions[]
    // "+ New session" and its separator still show — only the session list
    // itself collapses to the placeholder.
    expect(submenu[0].id).toBe('recent:0:new')
    expect(submenu[1].type).toBe('separator')
    expect(submenu[2]).toEqual({ label: 'No sessions', enabled: false })
    expect(submenu).toHaveLength(3)
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
