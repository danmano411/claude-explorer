import { app } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import type { Workspace } from '../shared/types'
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
 */
export function sanitize(raw: unknown): Workspace {
  const w = raw as Partial<Workspace> | null
  if (!w || typeof w !== 'object' || w.version !== 1) return emptyWorkspace()
  if (!Array.isArray(w.tabs) || !Array.isArray(w.spaces) || !Array.isArray(w.groups)) {
    return emptyWorkspace()
  }

  const groups = w.groups.filter((g) => g && typeof g.id === 'string' && typeof g.name === 'string')

  // normalize() is the one repair path for groupId: it clears a reference to a
  // group that did not survive (the tab is real, the reference is not) and pulls
  // each surviving group back into one contiguous run, which is the invariant
  // the TabBar renders against.
  const tabs = normalize(
    w.tabs.filter((t) => t && typeof t.id === 'string' && typeof t.cwd === 'string'),
    groups,
  )
  const tabIds = new Set(tabs.map((t) => t.id))

  const spaces = w.spaces
    .filter((s) => s && typeof s.id === 'string')
    .map((s) => {
      // Derive membership order from the normalized `tabs` list, not from the
      // raw (possibly stale, possibly duplicated) `s.tabIds` array — normalize()
      // above can reorder tabs to close a group's gap, and a member list that
      // still trusted the pre-normalize order would disagree with `tabs` about
      // where things sit. Filtering `tabs` also dedupes for free.
      const inSpace = new Set(Array.isArray(s.tabIds) ? s.tabIds : [])
      const members = tabs.filter((t) => inSpace.has(t.id)).map((t) => t.id)
      return {
        ...s,
        tabIds: members,
        // Focusing a tab this space does not contain would leave the window on
        // a blank pane. Absent (a v0.4.0 file) is fine — restore falls back to
        // the first tab.
        activeTabId: s.activeTabId && members.includes(s.activeTabId) ? s.activeTabId : undefined,
        layout: s.layout && Array.isArray(s.layout.cells)
          ? { ...s.layout, cells: s.layout.cells.filter((c) => c && tabIds.has(c.tabId)) }
          : null,
      }
    })

  if (!spaces.length) return { ...emptyWorkspace(), groups, tabs }
  const activeSpaceId = spaces.some((s) => s.id === w.activeSpaceId)
    ? w.activeSpaceId!
    : spaces[0].id
  return { version: 1, spaces, groups, tabs, activeSpaceId }
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
