import { app } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import type { PersistedTab, Space, Workspace } from '../shared/types'
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
    const tabIds = normalize(members[i], groups).map((t) => t.id)
    return {
      ...s,
      tabIds,
      // Focusing a tab this space does not contain would leave the window on
      // a blank pane. Absent (a v0.4.0 file) is fine — restore falls back to
      // the first tab.
      activeTabId: s.activeTabId && tabIds.includes(s.activeTabId) ? s.activeTabId : undefined,
      // A cell is checked against THIS space's membership, not against every
      // tab that exists: a cell naming a tab another space owns would paint
      // that space's tab into this one's pane, which is the same phantom the
      // one-owner rule exists to prevent.
      layout: s.layout && Array.isArray(s.layout.cells)
        ? { ...s.layout, cells: s.layout.cells.filter((c) => c && tabIds.includes(c.tabId)) }
        : null,
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

export function setWorkspace(w: Workspace): void {
  // Write-then-rename: a crash mid-write would otherwise leave a truncated
  // workspace.json, and losing the whole layout to a half-written file is
  // exactly the failure this feature exists to prevent.
  const target = file()
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(sanitize(w), null, 2), 'utf8')
  renameSync(tmp, target)
}
