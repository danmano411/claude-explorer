import { app } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import type { Workspace } from '../shared/types'

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
  const groupIds = new Set(groups.map((g) => g.id))

  const tabs = w.tabs
    .filter((t) => t && typeof t.id === 'string' && typeof t.cwd === 'string')
    // A tab pointing at a group that did not survive keeps the tab, loses the
    // grouping: the tab is real, the reference is not.
    .map((t) => (t.groupId && !groupIds.has(t.groupId) ? { ...t, groupId: undefined } : t))
  const tabIds = new Set(tabs.map((t) => t.id))

  const spaces = w.spaces
    .filter((s) => s && typeof s.id === 'string')
    .map((s) => ({
      ...s,
      tabIds: (Array.isArray(s.tabIds) ? s.tabIds : []).filter((id) => tabIds.has(id)),
      layout: s.layout && Array.isArray(s.layout.cells)
        ? { ...s.layout, cells: s.layout.cells.filter((c) => c && tabIds.has(c.tabId)) }
        : null,
    }))

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
