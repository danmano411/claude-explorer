import { app } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import type { GridCell, GridLayout, PersistedTab, Space, Workspace } from '../shared/types'
// Pure logic, no DOM and no electron — lives under shared/ (KAN-43 review D-5:
// it used to sit under renderer/, which meant a main-process file importing it
// pulled a renderer module into the main bundle). Importing it here is
// deliberate: a second groupId repair path here would be a second thing to keep
// in step with the TabBar's idea of a valid group.
import { normalize } from '../shared/groups'

const file = () => join(app.getPath('userData'), 'workspace.json')

/** An empty-but-valid workspace, so the renderer never branches on "first run". */
export function emptyWorkspace(): Workspace {
  const id = 'space-default'
  return {
    version: 1,
    spaces: [{ id, name: 'Space', tabIds: [], layout: null }],
    groups: [],
    tabs: [],
    activeSpaceId: id,
  }
}

/** A finite integer >= `min`, or null. Geometry read off disk goes through
 *  here so a hand-edited `"2"`, a `2.5` or a missing field can never become
 *  NaN in a CSS grid-area. */
function int(v: unknown, min: number): number | null {
  const n = typeof v === 'number' ? Math.trunc(v) : NaN
  return Number.isFinite(n) && n >= min ? n : null
}

/** Half-open rectangle intersection. Duplicating gridlayout's `overlaps` was
 *  the alternative to importing a renderer module into the main bundle — the
 *  thing the module doc above says this file will not do. Three lines. */
function rectsOverlap(a: GridCell, b: GridCell): boolean {
  return (
    a.col < b.col + b.colSpan &&
    b.col < a.col + a.colSpan &&
    a.row < b.row + b.rowSpan &&
    b.row < a.row + a.rowSpan
  )
}

/**
 * The layout as it survives a read: cells migrated forward from every shape
 * this app has written, pruned against THIS space's membership, and with every
 * remaining member adopted so "exactly one cell per tab" holds (KAN-56).
 *
 * Shape detection, not a version bump. 0.7.0 wrote one tab per cell as
 * `{ tabId, col, row, colSpan, rowSpan }`; 0.8.0 writes an ordered `tabIds`
 * plus the pane's own `activeTabId`. A cell is self-describing, so both are
 * readable out of a `version: 1` file and a downgrade degrades to
 * `layout: null` rather than corrupting. Reading the old shape with the new
 * membership predicate would see `undefined` for every cell, drop them all, and
 * silently destroy the split view of every upgrading user — which is the whole
 * reason this function exists rather than one more `.filter`.
 *
 * Returns null for "not a split": fewer than two usable cells (one pane IS
 * `layout: null`, and leaving two ways to say that is a permanent dead end —
 * KAN-46 review #1), or track counts too broken to place anything against. A
 * refusal here never loses a tab: the caller falls back to the single strip,
 * which holds every member.
 */
function migrateLayout(
  raw: unknown,
  memberIds: readonly string[],
  activeTabId: string | undefined,
): GridLayout | null {
  const l = raw as (Partial<GridLayout> & { cells?: unknown }) | null
  if (!l || typeof l !== 'object' || !Array.isArray(l.cells)) return null
  const cols = int(l.cols, 1)
  const rows = int(l.rows, 1)
  // Unusable track counts are not repairable without inventing a grid the user
  // never chose. Deriving them from the cells would also make the out-of-bounds
  // check below vacuous, which is the one thing keeping a corrupt rectangle out
  // of the render path.
  if (cols === null || rows === null) return null

  const members = new Set(memberIds)
  const seen = new Set<string>()
  const cells: GridCell[] = []
  for (const entry of l.cells as unknown[]) {
    const c = entry as (Partial<GridCell> & { tabId?: unknown }) | null
    if (!c || typeof c !== 'object') continue

    // `tabIds` wins when both are present: a file carrying both was hand-edited,
    // and the new field is the one it means.
    const claimed = Array.isArray(c.tabIds) ? c.tabIds : typeof c.tabId === 'string' ? [c.tabId] : []
    // Prune, in one pass, the two ways a cell can name a tab it may not have:
    // one that has left this space (a cell naming another space's tab would
    // paint that space's tab into this one's pane), and one an earlier cell
    // already took (first occurrence wins, as everywhere else in sanitize).
    const tabIds = claimed.filter(
      (id): id is string => typeof id === 'string' && members.has(id) && !seen.has(id),
    )
    if (!tabIds.length) continue

    const col = int(c.col, 0)
    const row = int(c.row, 0)
    if (col === null || row === null) continue
    const cell: GridCell = {
      tabIds,
      activeTabId:
        typeof c.activeTabId === 'string' && tabIds.includes(c.activeTabId)
          ? c.activeTabId
          : tabIds[0],
      col,
      row,
      // A missing/garbage span is the one field worth guessing at: 1 is what
      // every cell this app has ever written outside a deliberate split has.
      colSpan: int(c.colSpan, 1) ?? 1,
      rowSpan: int(c.rowSpan, 1) ?? 1,
    }
    if (col + cell.colSpan > cols || row + cell.rowSpan > rows) continue
    if (cells.some((o) => rectsOverlap(o, cell))) continue

    for (const id of tabIds) seen.add(id)
    cells.push(cell)
  }
  if (cells.length < 2) return null

  // Reading order (row, then col) is the canonical cell order: `Space.tabIds`
  // is its concatenation, so the strip you get back on collapsing to
  // `layout: null` reads the way the panes did.
  cells.sort((a, b) => a.row - b.row || a.col - b.col)

  // Orphans — THE normal case on upgrade, not an edge case: 0.7.0 held one tab
  // per cell, so a 10-tab two-pane space arrives with 8 tabs in no pane at all,
  // and a tab in no pane is unreachable (nothing renders it, no strip lists it).
  // They join the pane holding the tab the user was last looking at, falling
  // back to the top-left one — the same rule sanitize() already applies to a tab
  // no space claims, and for the same reason: it lands where you are looking.
  // Re-sorting by the file's own membership order restores the exact 0.7.0 strip
  // order; it only ever runs when there is something to adopt.
  const orphans = memberIds.filter((id) => !seen.has(id))
  if (orphans.length) {
    const recv =
      cells.find((c) => activeTabId !== undefined && c.tabIds.includes(activeTabId)) ?? cells[0]
    const rank = new Map(memberIds.map((id, i) => [id, i] as const))
    recv.tabIds = [...recv.tabIds, ...orphans].sort((a, b) => rank.get(a)! - rank.get(b)!)
  }
  return { cols, rows, cells }
}

/**
 * Drop anything structurally impossible before it reaches the renderer.
 *
 * A hand-edited or truncated file must not be able to produce a workspace whose
 * spaces reference tabs that do not exist, or whose tabs point at groups that
 * do not — the renderer would render blanks it cannot explain or close. Losing
 * a dangling reference is always better than showing a phantom tab.
 *
 * This is the ONE repair path for the whole document, called on read and on
 * write, so nothing the renderer ever holds has skipped it. KAN-45 folded the
 * spaces invariants in here rather than shipping a second normalizer in
 * src/renderer/spaces.ts: the two would have overlapped on four repairs and
 * disagreed on all four. What it guarantees, on top of the tab/group repairs:
 *
 *  - **Exactly one owner per tab.** A tab claimed by two spaces, or listed
 *    twice in one, is kept at its FIRST occurrence — never two, or it renders
 *    in both spaces and PTY ownership becomes ambiguous.
 *  - **No orphans.** A real tab that no space claims is adopted by the active
 *    space — never zero, or it is unreachable: no UI can show it, so a live
 *    Claude session keeps running with no way back to it and no way to close
 *    it. It lands in the space you are looking at on purpose; burying it in one
 *    you are not is barely better than losing it.
 *  - **Unique space ids.** Two spaces sharing an id are collapsed to the first,
 *    because every lookup in spaces.ts is a `findIndex` on the id.
 *  - **`activeTabId` names a member** of its own space, or is absent.
 *  - At least one space exists, and `activeSpaceId` names one of them.
 *  - **Every member is in exactly one pane**, or there is no layout at all —
 *    see `migrateLayout` above, which also carries 0.7.0's one-tab-per-cell
 *    files forward. With a layout present `tabIds` equals the cells' tab lists
 *    concatenated in reading order.
 */
export function sanitize(raw: unknown): Workspace {
  const w = raw as Partial<Workspace> | null
  if (!w || typeof w !== 'object' || w.version !== 1) return emptyWorkspace()
  if (!Array.isArray(w.tabs) || !Array.isArray(w.spaces) || !Array.isArray(w.groups)) {
    return emptyWorkspace()
  }

  const groups = w.groups.filter((g) => g && typeof g.id === 'string' && typeof g.name === 'string')

  // normalize() is the one repair path for groupId: it clears a reference to a
  // group that did not survive (the tab is real, the reference is not) and
  // dedupes repeated ids. It also pulls each surviving group into one
  // contiguous run — for the space slices below, which is where contiguity
  // actually matters now (one strip per space); doing it here too keeps
  // `tabs` self-consistent for anything reading it as a flat list.
  //
  // KAN-53 folded pinned-before-unpinned in there as well, for the same reason
  // the group repairs live there: it is an ordering invariant of the rendered
  // strip, and this is the single place a hand-editable file gets repaired. So
  // a workspace.json with a pinned tab in the middle (or a pinned tab still
  // tagged with a groupId) comes back fixed, and the renderer does not need a
  // second repair path — nor a sort on every render.
  const tabs = normalize(
    w.tabs.filter((t) => t && typeof t.id === 'string' && typeof t.cwd === 'string'),
    groups,
  )
  const byId = new Map(tabs.map((t) => [t.id, t] as const))

  // Pass 1 — one space per id, one space per tab. Both are "first occurrence
  // wins": the later copy is the one that has to go, and walking in document
  // order makes that deterministic rather than dependent on object identity.
  //
  // Membership order comes from `s.tabIds`, NOT from the order of `tabs`:
  // `tabIds` is authoritative (see the module doc in src/renderer/spaces.ts).
  // `tabs` is an unordered store keyed by id — a reorder inside a space must
  // survive a save, and it only can if the array the strip renders is the array
  // that gets believed.
  const claimed = new Set<string>()
  const seenSpaceIds = new Set<string>()
  const kept: Space[] = []
  const members: PersistedTab[][] = []
  for (const s of w.spaces) {
    if (!s || typeof s.id !== 'string' || seenSpaceIds.has(s.id)) continue
    seenSpaceIds.add(s.id)
    const mine: PersistedTab[] = []
    for (const id of Array.isArray(s.tabIds) ? s.tabIds : []) {
      const tab = byId.get(id)
      if (!tab || claimed.has(id)) continue
      claimed.add(id)
      mine.push(tab)
    }
    kept.push(s)
    members.push(mine)
  }
  if (!kept.length) {
    kept.push(emptyWorkspace().spaces[0])
    members.push([])
  }

  // Pass 2 — resolve the active space, then adopt every unclaimed tab into it.
  // Adoption has to come after the resolve (it needs to know where "visible"
  // is) and before the per-space normalize below (an adopted tab may belong to
  // a group that already has a run in that space, and the run has to close).
  const activeIdx = Math.max(
    0,
    kept.findIndex((s) => s.id === w.activeSpaceId),
  )
  members[activeIdx].push(...tabs.filter((t) => !claimed.has(t.id)))

  const spaces = kept.map((s, i) => {
    const memberIds = members[i].map((t) => t.id)
    const layout = migrateLayout(s.layout, memberIds, s.activeTabId)

    // normalize() repairs the ordering invariants of a RENDERED strip
    // (pinned-first, one contiguous run per group), so it runs over whatever a
    // strip actually is: with a layout there is one strip per pane, so it runs
    // per cell slice; without one there is a single strip, so the space slice
    // IS the strip. Same relaxation KAN-45 made when contiguity moved from the
    // flat tab list to a space's slice — one level further down.
    const order = (ids: readonly string[]) =>
      normalize(
        ids.map((id) => byId.get(id)!),
        groups,
      ).map((t) => t.id)

    // `tabIds` stays authoritative for membership either way, and for ORDER
    // only when there is no layout: with one it is the cells' tab lists
    // concatenated in reading order, so there is exactly one order truth and
    // collapsing back to `layout: null` neither reorders nor loses a tab.
    let tabIds: string[]
    if (layout) {
      for (const c of layout.cells) c.tabIds = order(c.tabIds)
      tabIds = layout.cells.flatMap((c) => c.tabIds)
    } else {
      tabIds = order(memberIds)
    }

    return {
      ...s,
      tabIds,
      // Focusing a tab this space does not contain would leave the window on
      // a blank pane. Absent (a v0.4.0 file) is fine — restore falls back to
      // the first tab.
      activeTabId: s.activeTabId && tabIds.includes(s.activeTabId) ? s.activeTabId : undefined,
      // Coerced rather than left to ride the `...s` spread: every other field
      // read off disk is type-checked here, and a hand-edited `"pinned": "no"`
      // would otherwise be truthy and lock the space's Delete forever with no UI
      // that can explain it. `undefined` is dropped by JSON.stringify, so a
      // pre-KAN-57 file round-trips with no new key (KAN-57).
      pinned: s.pinned === true ? true : undefined,
      layout,
    }
  })

  return { version: 1, spaces, groups, tabs, activeSpaceId: kept[activeIdx].id }
}

export function getWorkspace(): Workspace {
  try {
    if (!existsSync(file())) return emptyWorkspace()
    return sanitize(JSON.parse(readFileSync(file(), 'utf8')))
  } catch {
    return emptyWorkspace()
  }
}

/**
 * KAN-64. How many tabs the LAST persisted workspace remembers as agent-
 * spawned. Deliberately not "how many are live" — a restored terminal tab
 * spawns no process until the user activates it (see `needsSpawn`/`fromPersisted`
 * in tabs.ts), so right after a restart every one of those tabs is agent-spawned
 * on disk while `PtyManager.agentSessions()` (a fresh process, an empty handle
 * map) reads zero. `agentSpawned` is never persisted for a shell tab (tabs.ts
 * only ever sets it on a Claude terminal), so no `terminalKind` filter is needed
 * here either — same as `PtyManager.agentSessions()`'s own filter.
 *
 * Read fresh off disk each call rather than cached: this is the counterpart to
 * a live-process count, which is also read fresh every time.
 */
export function agentSpawnedTabCount(): number {
  return getWorkspace().tabs.filter((t) => t.agentSpawned === true).length
}

export function setWorkspace(w: Workspace): void {
  // Write-then-rename: a crash mid-write would otherwise leave a truncated
  // workspace.json, and losing the whole layout to a half-written file is
  // exactly the failure this feature exists to prevent.
  const target = file()
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(sanitize(w), null, 2), 'utf8')
  renameSync(tmp, target)
}
