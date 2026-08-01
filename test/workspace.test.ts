import { describe, it, expect, vi } from 'vitest'
import type { Space, Workspace } from '../src/shared/types'

vi.mock('electron', () => ({ app: { getPath: () => 'C:\\userData' } }))

const { sanitize, emptyWorkspace } = await import('../src/main/workspace')

const base = (): Workspace => ({
  version: 1 as const,
  groups: [{ id: 'g1', name: 'Repo', color: '#C15F3C', collapsed: false }],
  tabs: [
    { id: 't1', view: 'files' as const, cwd: 'C:\\a', title: 'a', groupId: 'g1' },
    { id: 't2', view: 'files' as const, cwd: 'C:\\b', title: 'b' },
  ],
  spaces: [{ id: 's1', name: 'Space', tabIds: ['t1', 't2'], layout: null }],
  activeSpaceId: 's1',
})

/** Cells by row then col — the canonical order `Space.tabIds` concatenates. */
const strips = (s: Space) =>
  [...(s.layout?.cells ?? [])]
    .sort((a, b) => a.row - b.row || a.col - b.col)
    .map((c) => c.tabIds)

describe('sanitize', () => {
  it('passes a well-formed workspace through intact', () => {
    const w = base()
    expect(sanitize(w)).toEqual(w)
  })

  it('falls back to empty on junk, null, or a future version', () => {
    expect(sanitize(null)).toEqual(emptyWorkspace())
    expect(sanitize('nope')).toEqual(emptyWorkspace())
    expect(sanitize({ ...base(), version: 2 })).toEqual(emptyWorkspace())
  })

  // A space listing a tab that no longer exists would render a blank pane the
  // user cannot explain or close.
  it('drops space members that are not real tabs', () => {
    const w = base()
    w.spaces[0].tabIds = ['t1', 'ghost', 't2']
    expect(sanitize(w).spaces[0].tabIds).toEqual(['t1', 't2'])
  })

  // The tab is real; only the grouping is dangling. Keep the tab.
  it('keeps a tab whose group vanished, but clears the reference', () => {
    const w = { ...base(), groups: [] }
    const out = sanitize(w)
    expect(out.tabs.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(out.tabs[0].groupId).toBeUndefined()
  })

  it('repairs an activeSpaceId that names no space', () => {
    expect(sanitize({ ...base(), activeSpaceId: 'gone' }).activeSpaceId).toBe('s1')
  })

  it('drops malformed tabs rather than trusting them', () => {
    const w = base()
    // @ts-expect-error deliberately malformed, as a hand-edited file would be
    w.tabs.push({ id: 42, cwd: null })
    expect(sanitize(w).tabs).toHaveLength(2)
  })

  it('never returns a workspace with zero spaces', () => {
    expect(sanitize({ ...base(), spaces: [] }).spaces.length).toBeGreaterThan(0)
  })

  // KAN-43: activeTabId is what makes a restart land on the tab you left.
  describe('activeTabId', () => {
    it('keeps one that names a member of the space', () => {
      const w = base()
      w.spaces[0].activeTabId = 't2'
      expect(sanitize(w).spaces[0].activeTabId).toBe('t2')
    })

    // Focusing a tab the space does not contain would leave a blank pane.
    it('drops one that is not in the space', () => {
      const w = base()
      w.spaces[0].activeTabId = 'ghost'
      expect(sanitize(w).spaces[0].activeTabId).toBeUndefined()
    })

    it('drops one whose tab was itself dropped as malformed', () => {
      const w = base()
      w.spaces[0].tabIds = ['t1', 't2', 'bad']
      w.spaces[0].activeTabId = 'bad'
      // @ts-expect-error deliberately malformed, as a hand-edited file would be
      w.tabs.push({ id: 'bad', cwd: null })
      expect(sanitize(w).spaces[0].activeTabId).toBeUndefined()
    })

    // A workspace.json written by v0.4.0 has no such field at all.
    it('loads a workspace that has none', () => {
      const out = sanitize(base())
      expect(out.spaces[0].activeTabId).toBeUndefined()
      expect(out.tabs).toHaveLength(2)
    })
  })

  // The full hand-edited-file case: a dead group reference AND a stray
  // activeTabId in one document. Neither may throw, and neither may leave a
  // phantom behind for the renderer to draw chrome for.
  it('repairs a dead groupId and a stray activeTabId together', () => {
    const w = { ...base(), groups: [] }
    w.spaces[0].activeTabId = 'ghost'
    const out = sanitize(w)
    expect(out.groups).toEqual([])
    expect(out.tabs.map((t) => t.groupId)).toEqual([undefined, undefined])
    expect(out.spaces[0].activeTabId).toBeUndefined()
    expect(out.spaces[0].tabIds).toEqual(['t1', 't2'])
  })

  // normalize() also gives sanitize() contiguity repair for free: a hand-edited
  // file that interleaves a group's members must not reach the TabBar, which
  // renders one strip per contiguous run and would otherwise shred the group.
  it('pulls a scattered group back into one contiguous run', () => {
    const w = base()
    w.tabs = [
      { id: 't1', view: 'files', cwd: 'C:\\a', title: 'a', groupId: 'g1' },
      { id: 't2', view: 'files', cwd: 'C:\\b', title: 'b' },
      { id: 't3', view: 'files', cwd: 'C:\\c', title: 'c', groupId: 'g1' },
    ]
    expect(sanitize(w).tabs.map((t) => t.id)).toEqual(['t1', 't3', 't2'])
  })

  // KAN-43 review D-2: normalize() above can reorder `tabs`, but a space's
  // membership list used to keep the PRE-normalize order from the raw file —
  // one document, two disagreeing orders.
  it('orders a space members to match the post-normalize tabs list', () => {
    const w = base()
    w.tabs = [
      { id: 't1', view: 'files', cwd: 'C:\\a', title: 'a', groupId: 'g1' },
      { id: 't2', view: 'files', cwd: 'C:\\b', title: 'b' },
      { id: 't3', view: 'files', cwd: 'C:\\c', title: 'c', groupId: 'g1' },
    ]
    w.spaces[0].tabIds = ['t1', 't2', 't3'] // pre-normalize order, as the raw file would have it
    const out = sanitize(w)
    expect(out.tabs.map((t) => t.id)).toEqual(['t1', 't3', 't2'])
    expect(out.spaces[0].tabIds).toEqual(out.tabs.map((t) => t.id))
  })

  it('dedupes a space that lists the same tab id twice', () => {
    const w = base()
    w.spaces[0].tabIds = ['t1', 't2', 't2']
    expect(sanitize(w).spaces[0].tabIds).toEqual(['t1', 't2'])
  })

  // KAN-53: pinned-before-unpinned is the second ordering invariant of the
  // rendered strip, so it is repaired in the same single place as contiguity.
  it('hoists a pinned tab to the front of its space, dropping any group it was in', () => {
    const w = base()
    w.tabs = [
      { id: 't1', view: 'files', cwd: 'C:\\a', title: 'a', groupId: 'g1' },
      { id: 't2', view: 'files', cwd: 'C:\\b', title: 'b', groupId: 'g1' },
      { id: 't3', view: 'files', cwd: 'C:\\c', title: 'c', pinned: true, groupId: 'g1' },
      { id: 't4', view: 'files', cwd: 'C:\\d', title: 'd' },
    ]
    w.spaces[0].tabIds = ['t1', 't2', 't3', 't4']
    const out = sanitize(w)
    expect(out.spaces[0].tabIds).toEqual(['t3', 't1', 't2', 't4'])
    expect(out.tabs.find((t) => t.id === 't3')?.groupId).toBeUndefined()
    expect(out.tabs.find((t) => t.id === 't3')?.pinned).toBe(true)
    expect(out.spaces[0].tabIds.indexOf('t2') - out.spaces[0].tabIds.indexOf('t1')).toBe(1)
  })

  // KAN-57.
  describe('pinned', () => {
    // REGRESSION GUARD, not a discriminator (KAN-57 review, D-5). Deleting
    // sanitize's `pinned: s.pinned === true ? true : undefined` leaves this
    // GREEN, because the `...s` spread above it carries the field through raw —
    // so it can never fail for a value that is already `true`, and no rewrite
    // short of dropping the spread would change that. The line's real job is
    // COERCION and ABSENCE, and the two assertions below are what hold it up
    // ('coerces hand-edited garbage' is the one that reds). This one is kept
    // because it is the only thing pinning the end-to-end claim the feature
    // makes — a pinned space survives a write and a read — which would otherwise
    // rest on nobody.
    it('round-trips pinned:true, including through a JSON write  [REGRESSION GUARD]', () => {
      const w = base()
      w.spaces[0].pinned = true
      const out = sanitize(w)
      expect(out.spaces[0].pinned).toBe(true)
      expect(JSON.parse(JSON.stringify(out)).spaces[0].pinned).toBe(true)
    })

    // A workspace.json written before KAN-57 has no such field at all, and
    // `undefined` has to be dropped by JSON.stringify so it stays that way.
    it('drops the key entirely for an unpinned (or pre-KAN-57) space', () => {
      const out = sanitize(base())
      expect(out.spaces[0].pinned).toBeUndefined()
      expect('pinned' in JSON.parse(JSON.stringify(out)).spaces[0]).toBe(false)
    })

    // A hand-edited "pinned": "no" is truthy in JS; coercing it wrong would
    // lock the space's Delete forever with no UI able to explain why.
    it('coerces hand-edited garbage to absent, never to truthy', () => {
      for (const garbage of ['no', 1, {}, 'false', null]) {
        const w = base()
        // @ts-expect-error deliberately malformed, as a hand-edited file would be
        w.spaces[0].pinned = garbage
        expect(sanitize(w).spaces[0].pinned).toBeUndefined()
      }
    })

    it('is idempotent for a pinned space — a second pass churns nothing', () => {
      const w = base()
      w.spaces[0].pinned = true
      const once = sanitize(w)
      expect(sanitize(once)).toEqual(once)
    })
  })

  // KAN-84/85.
  describe('color', () => {
    // REGRESSION GUARD, not a discriminator (same caveat the `pinned` guard
    // above documents): the `...s` spread already carries a valid preset
    // string through untouched, so this alone can't prove sanitizeSpaceColor
    // is even being called. What it DOES pin down is the round trip — a
    // colored space survives a write and a read — and it is kept alongside
    // the coercion/absence tests below, which are what actually go red if the
    // `color: sanitizeSpaceColor(s.color)` line is deleted.
    it('round-trips a preset color, including through a JSON write  [REGRESSION GUARD]', () => {
      const w = base()
      w.spaces[0].color = 'var(--clay)'
      const out = sanitize(w)
      expect(out.spaces[0].color).toBe('var(--clay)')
      expect(JSON.parse(JSON.stringify(out)).spaces[0].color).toBe('var(--clay)')
    })

    it('round-trips a custom light/dark pair', () => {
      const w = base()
      w.spaces[0].color = { light: '#C15F3Cff', dark: '#D2795A80' }
      const out = sanitize(w)
      expect(out.spaces[0].color).toEqual({ light: '#C15F3Cff', dark: '#D2795A80' })
    })

    // A pre-0.10.0 workspace.json has no such field at all, and `undefined`
    // has to be dropped by JSON.stringify so it stays that way.
    it('drops the key entirely for an uncolored (or pre-0.10.0) space', () => {
      const out = sanitize(base())
      expect(out.spaces[0].color).toBeUndefined()
      expect('color' in JSON.parse(JSON.stringify(out)).spaces[0]).toBe(false)
    })

    // A hand-edited value outside what this app ever writes must be coerced
    // away, not interpolated into an inline style unexamined.
    it('coerces hand-edited garbage to absent, never rendered', () => {
      for (const garbage of [1, {}, { light: 'var(--clay)' }, { light: 1, dark: 2 }, null, '']) {
        const w = base()
        // @ts-expect-error deliberately malformed, as a hand-edited file would be
        w.spaces[0].color = garbage
        expect(sanitize(w).spaces[0].color).toBeUndefined()
      }
    })

    // A custom pair needs BOTH halves valid, or neither is trusted — a
    // half-corrupt pair rendered anyway would silently lose the theme half
    // the user never asked to lose.
    it('rejects a custom pair with only one valid half', () => {
      const w = base()
      // @ts-expect-error deliberately malformed
      w.spaces[0].color = { light: '#C15F3Cff', dark: 123 }
      expect(sanitize(w).spaces[0].color).toBeUndefined()
    })

    it('is idempotent for a colored space — a second pass churns nothing', () => {
      const w = base()
      w.spaces[0].color = { light: '#C15F3Cff', dark: '#D2795A80' }
      const once = sanitize(w)
      expect(sanitize(once)).toEqual(once)
    })
  })
})

/**
 * KAN-56 — THE UPGRADE PATH.
 *
 * Shipped 0.7.0 wrote one tab per cell as `{ tabId, col, row, colSpan, rowSpan }`.
 * 0.8.0 makes a cell a WINDOW: an ordered `tabIds` plus its own `activeTabId`.
 * Read with the new membership predicate, a 0.7.0 cell reads `undefined` for
 * every id, EVERY cell is dropped, and the split layout of every existing user
 * is silently destroyed on first launch.
 *
 * These fixtures are therefore the literal bytes of a 0.7.0 `workspace.json`,
 * parsed from text — NOT a round-trip of the new writer, which cannot catch this
 * class of bug at all because it never emits the shape that breaks.
 */
describe('sanitize — 0.7.0 layout migration (KAN-56)', () => {
  const V070 = `{
    "version": 1,
    "groups": [],
    "tabs": [
      { "id": "a", "view": "terminal", "cwd": "C:\\\\repo", "title": "a" },
      { "id": "b", "view": "files", "cwd": "C:\\\\repo", "title": "b" },
      { "id": "c", "view": "files", "cwd": "C:\\\\repo", "title": "c" },
      { "id": "d", "view": "files", "cwd": "C:\\\\repo", "title": "d" },
      { "id": "e", "view": "files", "cwd": "C:\\\\repo", "title": "e" },
      { "id": "f", "view": "files", "cwd": "C:\\\\repo", "title": "f" },
      { "id": "g", "view": "files", "cwd": "C:\\\\repo", "title": "g" },
      { "id": "h", "view": "files", "cwd": "C:\\\\repo", "title": "h" },
      { "id": "i", "view": "files", "cwd": "C:\\\\repo", "title": "i" },
      { "id": "j", "view": "files", "cwd": "C:\\\\repo", "title": "j" }
    ],
    "spaces": [
      {
        "id": "s1",
        "name": "Space",
        "tabIds": ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
        "activeTabId": "a",
        "layout": {
          "cols": 2,
          "rows": 1,
          "cells": [
            { "tabId": "a", "col": 0, "row": 0, "colSpan": 1, "rowSpan": 1 },
            { "tabId": "b", "col": 1, "row": 0, "colSpan": 1, "rowSpan": 1 }
          ]
        },
        "colFractions": [1.2, 0.8],
        "rowFractions": [1]
      }
    ],
    "activeSpaceId": "s1"
  }`

  const v070 = () => JSON.parse(V070)

  // THE assertion this whole section exists for. Against a build that reads only
  // `cell.tabIds`, both cells drop, `cells.length < 2`, and layout is null.
  it('keeps a 0.7.0 split alive instead of collapsing it to one pane', () => {
    const s = sanitize(v070()).spaces[0]
    expect(s.layout).not.toBeNull()
    expect(s.layout!.cells).toHaveLength(2)
    expect([s.layout!.cols, s.layout!.rows]).toEqual([2, 1])
  })

  // 0.7.0 held ONE tab per cell, so a 10-tab two-pane space arrives with 8 tabs
  // in no pane at all — and a tab in no pane is unreachable: nothing renders it
  // and no strip lists it. They join the pane holding the tab the user was last
  // looking at, in the order the file already had them.
  it('adopts the 8 tabs that were in no cell into the pane the user was looking at', () => {
    const s = sanitize(v070()).spaces[0]
    expect(strips(s)).toEqual([
      ['a', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
      ['b'],
    ])
    expect(s.layout!.cells[0].activeTabId).toBe('a')
  })

  // "The pane you were looking at" is the rule, not "the top-left one": those
  // coincide in the fixture above, so this moves the focus to the second pane.
  it('adopts them into whichever pane holds activeTabId, not just the first', () => {
    const w = v070()
    w.spaces[0].activeTabId = 'b'
    expect(strips(sanitize(w).spaces[0])).toEqual([
      ['a'],
      ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
    ])
  })

  it('loses no tab and duplicates none: every member is in exactly one cell', () => {
    const before = v070()
    const s = sanitize(before).spaces[0]
    const placed = s.layout!.cells.flatMap((c) => c.tabIds)
    expect([...placed].sort()).toEqual([...before.spaces[0].tabIds].sort())
    expect(new Set(placed).size).toBe(placed.length)
  })

  // `Space.tabIds` is the cells' strips concatenated in reading order while a
  // layout is present, so there is exactly one order truth and collapsing back
  // to `layout: null` neither reorders nor loses a tab.
  it('rewrites tabIds to the cells read in reading order', () => {
    const s = sanitize(v070()).spaces[0]
    expect(s.tabIds).toEqual(strips(s).flat())
    expect(s.tabIds).toEqual(['a', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'b'])
  })

  // KAN-57: this file predates the `pinned` field by two majors. It must
  // load with every space unpinned and every tab still reachable — not throw,
  // not default to pinned, not drop a tab in the process.
  it('loads a literal pre-KAN-57 file with everything unpinned and nothing lost', () => {
    const out = sanitize(v070())
    expect(out.spaces[0].pinned).toBeUndefined()
    const reachable = out.spaces[0].layout
      ? out.spaces[0].layout.cells.flatMap((c) => c.tabIds)
      : out.spaces[0].tabIds
    expect([...reachable].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'])
    expect(out.tabs).toHaveLength(10)
  })

  it('carries the 0.7.0 track fractions through untouched', () => {
    const s = sanitize(v070()).spaces[0]
    expect(s.colFractions).toEqual([1.2, 0.8])
    expect(s.rowFractions).toEqual([1])
  })

  it('falls back to the top-left pane when activeTabId names nothing placed', () => {
    const w = v070()
    delete w.spaces[0].activeTabId
    // Listed out of reading order, to prove the fallback is the top-left cell
    // and not merely the first entry in the array.
    w.spaces[0].layout.cells.reverse()
    expect(strips(sanitize(w).spaces[0])[0]).toEqual(['a', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'])
  })

  // One pane IS `layout: null`, and leaving two ways to say that is a permanent
  // dead end: the second one keeps a focus ring and a divider alive over what
  // the user sees as ordinary tabs.
  it('collapses a lone 0.7.0 cell to null, with the strip order untouched', () => {
    const w = v070()
    w.spaces[0].layout.cells.pop()
    const s = sanitize(w).spaces[0]
    expect(s.layout).toBeNull()
    expect(s.tabIds).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'])
  })

  // A cell naming a tab that has left the space would paint another space's tab
  // into this one's pane. Pruning it can leave too few cells to be a split.
  it('prunes a cell naming a tab that is not a member, and collapses if too few remain', () => {
    const w = v070()
    w.spaces[0].layout.cells[1].tabId = 'ghost'
    const s = sanitize(w).spaces[0]
    expect(s.layout).toBeNull()
    expect(s.tabIds).toHaveLength(10)
  })

  it('keeps the split when a pruned cell still leaves two', () => {
    const w = v070()
    w.spaces[0].layout.cols = 3
    w.spaces[0].layout.cells.push({ tabId: 'ghost', col: 2, row: 0, colSpan: 1, rowSpan: 1 })
    w.spaces[0].layout.cells.push({ tabId: 'c', col: 2, row: 0, colSpan: 1, rowSpan: 1 })
    const s = sanitize(w).spaces[0]
    expect(strips(s).map((ids) => ids.length)).toEqual([8, 1, 1])
    expect(strips(s)[2]).toEqual(['c'])
  })

  it('keeps a repeated tab id in the first cell only', () => {
    const w = v070()
    w.spaces[0].layout.cells[1].tabId = 'a'
    const s = sanitize(w).spaces[0]
    // The second cell is left with nothing to hold and goes, so this is no
    // longer a split — but `a` is still in exactly one place.
    expect(s.layout).toBeNull()
    expect(s.tabIds.filter((id) => id === 'a')).toHaveLength(1)
  })

  it('sorts the cells into reading order however the file listed them', () => {
    const w = v070()
    w.spaces[0].layout.cols = 2
    w.spaces[0].layout.rows = 2
    w.spaces[0].layout.cells = [
      { tabId: 'd', col: 1, row: 1, colSpan: 1, rowSpan: 1 },
      { tabId: 'c', col: 0, row: 1, colSpan: 1, rowSpan: 1 },
      { tabId: 'b', col: 1, row: 0, colSpan: 1, rowSpan: 1 },
      { tabId: 'a', col: 0, row: 0, colSpan: 1, rowSpan: 1 },
    ]
    const s = sanitize(w).spaces[0]
    expect(s.layout!.cells.map((c) => c.tabIds[0])).toEqual(['a', 'b', 'c', 'd'])
    expect(s.tabIds.slice(-3)).toEqual(['b', 'c', 'd'])
  })

  it('drops an out-of-bounds cell and re-adopts its tabs rather than losing them', () => {
    const w = v070()
    w.spaces[0].layout.cells.push({ tabId: 'c', col: 7, row: 0, colSpan: 1, rowSpan: 1 })
    const s = sanitize(w).spaces[0]
    expect(s.layout!.cells).toHaveLength(2)
    expect(strips(s)[0]).toContain('c')
    expect(s.tabIds).toHaveLength(10)
  })

  it('drops an overlapping cell and re-adopts its tabs', () => {
    const w = v070()
    w.spaces[0].layout.cells.push({ tabId: 'c', col: 1, row: 0, colSpan: 1, rowSpan: 1 })
    const s = sanitize(w).spaces[0]
    expect(s.layout!.cells).toHaveLength(2)
    expect(strips(s)[1]).toEqual(['b']) // the first cell at 1,0 kept its rectangle
    expect(strips(s)[0]).toContain('c')
  })

  // normalize() repairs the ordering invariants of a RENDERED strip, and with a
  // layout there is one strip per PANE — so a pinned tab is hoisted inside its
  // own pane, not dragged across the window into another one.
  it('repairs pinned-first per pane, not per space', () => {
    const w = v070()
    w.tabs[3].pinned = true // 'd', which the orphan pass puts in the first pane
    w.spaces[0].layout.cells[1] = { tabId: 'b', col: 1, row: 0, colSpan: 1, rowSpan: 1 }
    const s = sanitize(w).spaces[0]
    expect(strips(s)[0][0]).toBe('d')
    expect(strips(s)[1]).toEqual(['b'])
  })

  it('keeps a group contiguous inside the pane that holds it', () => {
    const w = v070()
    w.groups = [{ id: 'g1', name: 'Repo', color: '#C15F3C', collapsed: false }]
    w.tabs[0].groupId = 'g1' // 'a'
    w.tabs[4].groupId = 'g1' // 'e'
    const ids = strips(sanitize(w).spaces[0])[0]
    expect(ids.indexOf('e') - ids.indexOf('a')).toBe(1)
  })

  it('still loads a 0.4.0 file, which has no layout field at all', () => {
    const w = v070()
    delete w.spaces[0].layout
    const s = sanitize(w).spaces[0]
    expect(s.layout).toBeNull()
    expect(s.tabIds).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'])
  })

  it('reads a file that mixes 0.7.0 and 0.8.0 cells in one array', () => {
    const w = v070()
    w.spaces[0].layout.cells = [
      { tabId: 'a', col: 0, row: 0, colSpan: 1, rowSpan: 1 },
      { tabIds: ['b', 'c'], activeTabId: 'c', col: 1, row: 0, colSpan: 1, rowSpan: 1 },
    ]
    const s = sanitize(w).spaces[0]
    expect(strips(s)[1]).toEqual(['b', 'c'])
    expect(s.layout!.cells[1].activeTabId).toBe('c')
  })

  it('prefers tabIds when a hand-edited cell carries both fields', () => {
    const w = v070()
    w.spaces[0].layout.cells[0] = {
      tabId: 'c', tabIds: ['a'], activeTabId: 'a', col: 0, row: 0, colSpan: 1, rowSpan: 1,
    }
    expect(strips(sanitize(w).spaces[0])[0][0]).toBe('a')
  })

  it('repairs an activeTabId that is not in its own cell', () => {
    const w = v070()
    w.spaces[0].layout.cells = [
      { tabIds: ['a', 'c'], activeTabId: 'zzz', col: 0, row: 0, colSpan: 1, rowSpan: 1 },
      { tabIds: ['b'], activeTabId: 'b', col: 1, row: 0, colSpan: 1, rowSpan: 1 },
    ]
    expect(sanitize(w).spaces[0].layout!.cells[0].activeTabId).toBe('a')
  })

  // A truncated or hand-edited file must never throw and must never lose a tab:
  // the fallback is the single strip, which holds every member.
  it('is total on a malformed layout, and keeps every tab either way', () => {
    for (const bad of [
      42,
      'nope',
      [],
      { cols: 2, rows: 1 },
      { cols: 2, rows: 1, cells: 'nope' },
      { cols: 'two', rows: 1, cells: [{ tabId: 'a', col: 0, row: 0 }, { tabId: 'b', col: 1, row: 0 }] },
      { cols: 0, rows: 1, cells: [{ tabId: 'a', col: 0, row: 0 }] },
      { cols: 2, rows: 1, cells: [null, 7, {}, { tabId: 5 }, { tabIds: 'a' }] },
      { cols: 2, rows: 1, cells: [{ tabId: 'a', col: -1, row: 0 }, { tabId: 'b', col: 1.5, row: 0 }] },
      { cols: 2, rows: 1, cells: [{ tabId: 'a', col: 0, row: 0, colSpan: null, rowSpan: 'x' }, { tabId: 'b', col: 1, row: 0 }] },
    ]) {
      const w = v070()
      w.spaces[0].layout = bad
      const s = sanitize(w).spaces[0]
      const reachable = s.layout ? s.layout.cells.flatMap((c) => c.tabIds) : s.tabIds
      expect([...reachable].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'])
      expect([...s.tabIds].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'])
      if (!s.layout) continue
      // ...and any layout that DID survive is renderable: a null or fractional
      // track count reaches `grid-template-columns` as `NaNfr` and wrecks the
      // whole window, which is worse than dropping the split.
      const { cols, rows } = s.layout
      expect(Number.isInteger(cols) && cols >= 1).toBe(true)
      expect(Number.isInteger(rows) && rows >= 1).toBe(true)
      for (const c of s.layout.cells) {
        expect(Number.isInteger(c.col) && c.col >= 0).toBe(true)
        expect(Number.isInteger(c.row) && c.row >= 0).toBe(true)
        expect(Number.isInteger(c.colSpan) && c.colSpan >= 1).toBe(true)
        expect(Number.isInteger(c.rowSpan) && c.rowSpan >= 1).toBe(true)
        expect(c.col + c.colSpan).toBeLessThanOrEqual(cols)
        expect(c.row + c.rowSpan).toBeLessThanOrEqual(rows)
      }
    }
  })

  it('guesses span 1 for a missing or garbage span rather than dropping the cell', () => {
    const w = v070()
    w.spaces[0].layout.cells = [
      { tabId: 'a', col: 0, row: 0 },
      { tabId: 'b', col: 1, row: 0, colSpan: 'wide', rowSpan: null },
    ]
    const s = sanitize(w).spaces[0]
    expect(s.layout!.cells).toHaveLength(2)
    expect(s.layout!.cells.map((c) => [c.colSpan, c.rowSpan])).toEqual([[1, 1], [1, 1]])
  })

  // Migration must be a fixed point: sanitize() runs on read AND on write, so a
  // second pass that moved anything would churn the file on every save.
  it('is idempotent — the migrated shape survives another pass unchanged', () => {
    const once = sanitize(v070())
    expect(sanitize(once)).toEqual(once)
    expect(sanitize(JSON.parse(JSON.stringify(once)))).toEqual(once)
  })
})

/**
 * KAN-45 review D-4: these repairs used to live in a second normalizer in
 * src/renderer/spaces.ts, re-implementing what sanitize() already did and
 * disagreeing with it. They live here now, and only here.
 */
describe('sanitize — the spaces invariants', () => {
  const plain = (): Workspace => ({
    version: 1 as const,
    groups: [],
    tabs: [
      { id: 't1', view: 'files' as const, cwd: 'C:\\a', title: 'a' },
      { id: 't2', view: 'files' as const, cwd: 'C:\\b', title: 'b' },
      { id: 't3', view: 'files' as const, cwd: 'C:\\c', title: 'c' },
    ],
    spaces: [
      { id: 's1', name: 'One', tabIds: ['t1'], layout: null },
      { id: 's2', name: 'Two', tabIds: ['t2'], layout: null },
    ],
    activeSpaceId: 's1',
  })

  // Two owners means it renders in both spaces and PTY ownership is ambiguous:
  // closing the space that "has" it kills a process the other is still showing.
  it('gives a tab claimed by two spaces to the first one only', () => {
    const w = plain()
    w.spaces[0].tabIds = ['t1', 't2']
    w.spaces[1].tabIds = ['t2', 't3']
    const out = sanitize(w)
    expect(out.spaces[0].tabIds).toEqual(['t1', 't2'])
    expect(out.spaces[1].tabIds).toEqual(['t3'])
  })

  it('collapses two spaces sharing an id, keeping the first', () => {
    const w = plain()
    w.spaces[1].id = 's1'
    const out = sanitize(w)
    expect(out.spaces).toHaveLength(1)
    expect(out.spaces[0].name).toBe('One')
  })

  // Zero owners is the worst outcome in the feature: no UI can show the tab, so
  // a live Claude session keeps running with no way back to it and no way to
  // close it. Adoption lands it in the space the user is looking at.
  it('adopts a tab no space claims into the ACTIVE space', () => {
    const out = sanitize({ ...plain(), activeSpaceId: 's2' })
    expect(out.spaces[1].tabIds).toEqual(['t2', 't3'])
    expect(out.spaces[0].tabIds).toEqual(['t1'])
  })

  it('adopts into the first space when activeSpaceId names nothing', () => {
    const out = sanitize({ ...plain(), activeSpaceId: 'gone' })
    expect(out.activeSpaceId).toBe('s1')
    expect(out.spaces[0].tabIds).toEqual(['t1', 't3'])
  })

  it('invents a space when there are none, and every tab lands in it', () => {
    const out = sanitize({ ...plain(), spaces: [] })
    expect(out.spaces).toHaveLength(1)
    expect(out.spaces[0].tabIds).toEqual(['t1', 't2', 't3'])
    expect(out.activeSpaceId).toBe(out.spaces[0].id)
  })

  it('keeps a group contiguous after adopting an orphan into its space', () => {
    const w = plain()
    w.groups = [{ id: 'g1', name: 'Repo', color: '#C15F3C', collapsed: false }]
    w.tabs[0].groupId = 'g1'
    w.tabs[2].groupId = 'g1'
    w.spaces[0].tabIds = ['t1', 't2'] // t3 orphaned, and it is in t1's group
    w.spaces[1].tabIds = []
    expect(sanitize(w).spaces[0].tabIds).toEqual(['t1', 't3', 't2'])
  })

  // THE authority rule (see the module doc in src/renderer/spaces.ts): `tabIds`
  // defines order, `tabs` is an unordered store.
  it('believes tabIds order over the order of the global tabs array', () => {
    const w = plain()
    w.spaces[0].tabIds = ['t3', 't1']
    w.spaces[1].tabIds = ['t2']
    const out = sanitize(w)
    expect(out.spaces[0].tabIds).toEqual(['t3', 't1'])
    expect(out.tabs.map((t) => t.id)).toEqual(['t1', 't2', 't3']) // untouched, and irrelevant
  })

  it('survives a reorder round-trip, which is the point of the rule above', () => {
    const w = plain()
    w.spaces[0].tabIds = ['t1', 't3']
    w.spaces[1].tabIds = ['t2']
    const saved = sanitize(w)
    saved.spaces[0].tabIds = ['t3', 't1'] // the user dragged t3 left
    expect(sanitize(saved).spaces[0].tabIds).toEqual(['t3', 't1'])
  })

  // A cell naming a tab another space owns would paint that space's tab into
  // this one's pane — the same phantom the one-owner rule exists to prevent.
  it('drops a grid cell pointing at a tab this space does not own', () => {
    const w = plain()
    w.spaces[0].tabIds = ['t1', 't3']
    w.spaces[0].layout = {
      cols: 3, rows: 1,
      cells: [
        { tabIds: ['t1'], activeTabId: 't1', col: 0, row: 0, colSpan: 1, rowSpan: 1 },
        { tabIds: ['t2'], activeTabId: 't2', col: 1, row: 0, colSpan: 1, rowSpan: 1 }, // s2 owns t2
        { tabIds: ['t3'], activeTabId: 't3', col: 2, row: 0, colSpan: 1, rowSpan: 1 },
      ],
    }
    const out = sanitize(w)
    expect(strips(out.spaces[0])).toEqual([['t1'], ['t3']])
    expect(out.spaces[1].tabIds).toEqual(['t2'])
  })

  // KAN-56 REVERSED this: a tab in no cell is unreachable — it renders nowhere
  // and no strip lists it — so with a layout present it must be adopted into a
  // pane, not left floating.
  it('adopts a tab that no cell claims into a pane rather than stranding it', () => {
    const w = plain()
    w.spaces[0].tabIds = ['t1', 't2']
    w.spaces[1].tabIds = []
    w.spaces[0].layout = {
      cols: 2, rows: 1,
      cells: [
        { tabIds: ['t1'], activeTabId: 't1', col: 0, row: 0, colSpan: 1, rowSpan: 1 },
        { tabIds: ['t2'], activeTabId: 't2', col: 1, row: 0, colSpan: 1, rowSpan: 1 },
      ],
    }
    const out = sanitize(w) // t3 is unclaimed and adopted into the active space s1
    expect(out.spaces[0].tabIds).toEqual(['t1', 't3', 't2'])
    expect(strips(out.spaces[0])).toEqual([['t1', 't3'], ['t2']])
  })

  // An empty space is legal — createSpace makes one, and you look at it before
  // you open anything in it.
  it('keeps a space with no tabs at all', () => {
    const w = plain()
    w.spaces[1].tabIds = []
    w.spaces[0].tabIds = ['t1', 't2', 't3']
    expect(sanitize(w).spaces.map((s) => s.id)).toEqual(['s1', 's2'])
  })

  it('is total on garbage inside the spaces array', () => {
    const w = { ...plain(), spaces: [null, { name: 'no id' }, { id: 7 }, { id: 's1', tabIds: null }] }
    expect(() => sanitize(w)).not.toThrow()
    const out = sanitize(w)
    expect(out.spaces).toHaveLength(1)
    expect(out.spaces[0].id).toBe('s1')
    expect(out.spaces[0].tabIds).toEqual(['t1', 't2', 't3']) // all adopted
  })
})

describe('sanitize — randomised garbage sweep', () => {
  // Deterministic PRNG (mulberry32) so the sweep is reproducible, not flaky.
  function mulberry32(seed: number) {
    let a = seed
    return () => {
      a |= 0
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  it('restores every spaces AND layout invariant from arbitrary garbage', () => {
    const tabPool = ['t1', 't2', 't3', 't4', 'ghost1', 'ghost2']
    for (let seed = 1; seed <= 120; seed++) {
      const rand = mulberry32(seed * 104729)
      const pick = <X>(xs: readonly X[]): X => xs[Math.floor(rand() * xs.length)]

      // Deliberately broken, and broken BELOW the type level too — nulls, wrong
      // types, missing fields. sanitize() takes `unknown` and is the app's only
      // guard, so "total on arbitrary garbage" has to be true of THIS function.
      const tabs: unknown[] = []
      for (const id of tabPool) {
        if (id.startsWith('ghost') && rand() < 0.8) continue
        tabs.push(rand() < 0.15 ? { id, cwd: null } : { id, view: 'files', cwd: 'C:\\x', title: id })
      }
      if (rand() < 0.3) tabs.push(null)

      /** A cell in the 0.7.0 shape, the 0.8.0 shape, or something broken. */
      const someCell = (col: number) => {
        const roll = rand()
        const rect = { col, row: 0, colSpan: 1, rowSpan: 1 }
        if (roll < 0.1) return null
        if (roll < 0.45) return { tabId: pick(tabPool), ...rect }
        if (roll < 0.85) {
          const ids = [pick(tabPool), pick(tabPool)]
          return { tabIds: ids, activeTabId: pick([...ids, 'nothing']), ...rect }
        }
        return { tabIds: pick([null, 'x', []]), ...rect }
      }

      const spaces: unknown[] = []
      for (let i = 0; i < Math.floor(rand() * 5); i++) {
        const roll = rand()
        if (roll < 0.1) { spaces.push(null); continue }
        if (roll < 0.18) { spaces.push({ name: 'no id at all' }); continue }
        const tabIds: string[] = []
        for (let k = 0; k < Math.floor(rand() * 5); k++) tabIds.push(pick(tabPool))
        const cols = 1 + Math.floor(rand() * 3)
        spaces.push({
          id: pick(['sA', 'sB', 'sC']),
          name: `space-${i}`,
          tabIds: rand() < 0.15 ? null : tabIds,
          activeTabId: rand() < 0.7 ? pick([...tabPool, 'nothing']) : undefined,
          layout:
            rand() < 0.5
              ? {
                  cols: rand() < 0.1 ? pick([0, 'x', null]) : cols,
                  rows: 1,
                  cells: Array.from({ length: cols }, (_, k) => someCell(k)),
                }
              : null,
        })
      }

      const raw = { version: 1, tabs, spaces, groups: [], activeSpaceId: pick(['sA', 'sB', 'sC', 'sZ']) }
      const out = sanitize(raw)
      const known = out.tabs.map((t) => t.id)

      expect(out.spaces.length).toBeGreaterThan(0)
      // Exactly one owner per tab: never zero (unreachable live session), never
      // two (ambiguous PTY ownership).
      const counts = new Map<string, number>()
      for (const s of out.spaces) for (const id of s.tabIds) counts.set(id, (counts.get(id) ?? 0) + 1)
      expect(counts.size).toBe(new Set(known).size)
      for (const id of known) expect(counts.get(id)).toBe(1)

      for (const s of out.spaces) {
        // No space remembers an active tab it does not own.
        if (s.activeTabId !== undefined) expect(s.tabIds).toContain(s.activeTabId)
        if (!s.layout) continue
        // One pane is not a split; two ways to say "no split" is a dead end.
        expect(s.layout.cells.length).toBeGreaterThanOrEqual(2)
        const placed: string[] = []
        for (const c of s.layout.cells) {
          expect(c.tabIds.length).toBeGreaterThan(0) // a pane with nothing under it
          expect(c.tabIds).toContain(c.activeTabId) // ...or showing nothing at all
          expect(Number.isInteger(c.col) && c.col >= 0).toBe(true)
          expect(c.col + c.colSpan).toBeLessThanOrEqual(s.layout.cols)
          expect(c.row + c.rowSpan).toBeLessThanOrEqual(s.layout.rows)
          placed.push(...c.tabIds)
        }
        // Every member in EXACTLY one cell: none twice (one terminal, two
        // hosts), none missing (unreachable — no strip lists it).
        expect([...placed].sort()).toEqual([...s.tabIds].sort())
        expect(new Set(placed).size).toBe(placed.length)
        // ...and `tabIds` IS that concatenation, in reading order.
        expect(s.tabIds).toEqual(
          [...s.layout.cells].sort((a, b) => a.row - b.row || a.col - b.col).flatMap((c) => c.tabIds),
        )
      }
      expect(out.spaces.some((s) => s.id === out.activeSpaceId)).toBe(true)
      expect(new Set(out.spaces.map((s) => s.id)).size).toBe(out.spaces.length)
      // Idempotent: a second pass has nothing left to fix. Also what makes the
      // read/write symmetry safe — sanitize() runs on both.
      expect(sanitize(out)).toEqual(out)
    }
  })
})
