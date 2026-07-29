import type { TabGroup } from '../shared/types'
import { reorder } from './tabreorder'

/**
 * The minimal shape groups.ts needs from a tab. `Tab` (./tabs.ts) does not yet
 * carry `groupId` — another worker owns that file this milestone — so this
 * module is written generically over a structural type instead of importing
 * `Tab` directly. Once `groupId?: string` lands on `Tab`, every exported
 * function here already accepts it with zero changes: `Tab` will satisfy
 * `Grouped` structurally. Deliberately not a duplicate `Tab` interface.
 */
export type Grouped = { id: string; groupId?: string }

/**
 * The only non-structural, non-semantic-alias color custom properties Retro
 * Claude actually defines (src/renderer/index.css :root block + the M2 diff
 * block). Excluded on purpose: the bg, ink, line, sel and term family
 * (surface tokens, not accents) and --diff-del, which is `var(--clay)`
 * again under another name, not a distinct hue. That leaves exactly one
 * real accent family (clay) plus the one semantic secondary the app already
 * uses (diff-add green), so three tokens is the honest size of "what is
 * there" — not a second palette invented for this feature. Referencing the
 * custom properties by name (not their resolved hex) means a group chip
 * repaints correctly under the app's existing dark-mode media query, free.
 */
export const GROUP_COLORS = ['var(--clay)', 'var(--diff-add)', 'var(--clay-soft)'] as const

function stripGroupId<T extends Grouped>(t: T): T {
  const { groupId: _drop, ...rest } = t
  return rest as T
}

/**
 * New empty-ish TabGroup. `color`, when omitted, round-robins over
 * GROUP_COLORS keyed off how many groups already exist, so the Nth group
 * created gets a different swatch than the (N-1)th — not a guarantee two
 * groups never match (delete + recreate can still collide), just "unlikely
 * to look identical" as asked for.
 *
 * Spec sketch was `newGroup(name, color?)`; round-robin needs to know how
 * many groups already exist, which a 2-arg signature has nowhere to carry.
 * `existingGroups` sits between `name` and the rarely-used explicit `color`
 * override so the common call (`newGroup(name, groups)`) reads cleanly, and
 * defaults to `[]` so `newGroup(name)` alone still works.
 */
export function newGroup(
  name: string,
  existingGroups: readonly TabGroup[] = [],
  color?: string,
): TabGroup {
  return {
    id: crypto.randomUUID(),
    name,
    color: color ?? GROUP_COLORS[existingGroups.length % GROUP_COLORS.length],
    collapsed: false,
  }
}

/**
 * Index range `[start, end)` (end EXCLUSIVE, so `tabs.slice(start, end)` is
 * the run) covering every tab currently tagged with `groupId`, or null when
 * none are. Reads the tab list as-is — it does not assume the run is
 * contiguous, which is exactly what makes it useful for `normalize()` and
 * `reorderWithGroups()`: both need to reason about a group's span BEFORE
 * they've finished fixing it up.
 */
export function groupRun<T extends Grouped>(tabs: T[], groupId: string): { start: number; end: number } | null {
  let start = -1
  let end = -1
  for (let i = 0; i < tabs.length; i++) {
    if (tabs[i].groupId === groupId) {
      if (start === -1) start = i
      end = i
    }
  }
  return start === -1 ? null : { start, end: end + 1 }
}

/**
 * Tags `tabId` with `groupId` and relocates it to the end of that group's
 * existing run, so the group stays one contiguous block in the flat list
 * (the TabBar renders one strip; a scattered group would look shredded).
 * If the group has no members yet there is no run to join — the tab just
 * gets tagged in place, trivially a contiguous run of one.
 *
 * "In place" needs one adjustment: if the tab was itself an INTERIOR member
 * of a DIFFERENT group's run (moving it between two groups, not just into
 * one), removing it closes that old run's gap — its old slot then sits
 * inside the newly-closed run rather than beside it, which would silently
 * split that other group. When that happens it hops to just past the old
 * run instead, the same landing spot `removeFromGroup` would choose.
 *
 * An unknown tabId is a no-op: returns `tabs` unchanged. `groupId` itself is
 * not validated against a groups list (this module keeps membership and the
 * group registry separate) — pass a live TabGroup id, or clean up later with
 * `normalize()`.
 */
export function addToGroup<T extends Grouped>(tabs: T[], tabId: string, groupId: string): T[] {
  const idx = tabs.findIndex((t) => t.id === tabId)
  if (idx === -1) return tabs

  const oldGroupId = tabs[idx].groupId
  const rest = [...tabs.slice(0, idx), ...tabs.slice(idx + 1)]
  const targetRun = groupRun(rest, groupId)

  let insertAt: number
  if (targetRun !== null) {
    insertAt = targetRun.end
  } else {
    const oldRun = oldGroupId !== undefined ? groupRun(rest, oldGroupId) : null
    insertAt = oldRun !== null && oldRun.start < idx && idx < oldRun.end ? oldRun.end : idx
  }

  const tagged = { ...tabs[idx], groupId }
  return [...rest.slice(0, insertAt), tagged, ...rest.slice(insertAt)]
}

/**
 * Clears `tabId`'s groupId and relocates it to just after its old group's
 * run, so an ungrouped tab never visually sits inside a group's chrome. If
 * it was the group's only member there is nothing to land "after" — it just
 * stays put, ungrouped.
 *
 * No-op (same reference) for an unknown tabId or a tab that is already
 * ungrouped.
 */
export function removeFromGroup<T extends Grouped>(tabs: T[], tabId: string): T[] {
  const idx = tabs.findIndex((t) => t.id === tabId)
  if (idx === -1) return tabs
  const groupId = tabs[idx].groupId
  if (groupId === undefined) return tabs

  const rest = [...tabs.slice(0, idx), ...tabs.slice(idx + 1)]
  const run = groupRun(rest, groupId)
  const insertAt = run === null ? idx : run.end
  const untagged = stripGroupId(tabs[idx])
  return [...rest.slice(0, insertAt), untagged, ...rest.slice(insertAt)]
}

function updateGroup(groups: TabGroup[], groupId: string, patch: (g: TabGroup) => TabGroup): TabGroup[] {
  const idx = groups.findIndex((g) => g.id === groupId)
  if (idx === -1) return groups
  const next = [...groups]
  next[idx] = patch(groups[idx])
  return next
}

export function renameGroup(groups: TabGroup[], groupId: string, name: string): TabGroup[] {
  return updateGroup(groups, groupId, (g) => ({ ...g, name }))
}

export function setCollapsed(groups: TabGroup[], groupId: string, collapsed: boolean): TabGroup[] {
  return updateGroup(groups, groupId, (g) => ({ ...g, collapsed }))
}

export function recolorGroup(groups: TabGroup[], groupId: string, color: string): TabGroup[] {
  return updateGroup(groups, groupId, (g) => ({ ...g, color }))
}

/**
 * Removes the group and un-groups whatever tabs were in it, WITHOUT closing
 * them — deleting a container must never destroy the contents. No-op (same
 * references, both fields) for an unknown groupId.
 */
export function deleteGroup<T extends Grouped>(
  groups: TabGroup[],
  tabs: T[],
  groupId: string,
): { groups: TabGroup[]; tabs: T[] } {
  if (!groups.some((g) => g.id === groupId)) return { groups, tabs }
  const nextGroups = groups.filter((g) => g.id !== groupId)
  const hasMembers = tabs.some((t) => t.groupId === groupId)
  const nextTabs = hasMembers ? tabs.map((t) => (t.groupId === groupId ? stripGroupId(t) : t)) : tabs
  return { groups: nextGroups, tabs: nextTabs }
}

/** The render model for the TabBar: the flat list chopped into ordered runs,
 *  each paired with the TabGroup it belongs to (or null for loose tabs). */
export interface Segment<T extends Grouped> {
  group: TabGroup | null
  tabs: T[]
}

/**
 * Chops `tabs` into the segments the TabBar maps over to draw group chrome.
 * A run of tabs sharing the same resolvable groupId is one segment; every
 * other tab — genuinely ungrouped, OR carrying a groupId that does not
 * resolve against `groups` — folds into `group: null` so stale state (a
 * hand-edited workspace.json referencing a deleted group) renders as plain
 * loose tabs instead of crashing or inventing chrome for a group that no
 * longer exists. Assumes contiguity already holds (run `normalize()` first
 * after a restore or a raw reorder); it will not throw on a non-contiguous
 * list, it just won't merge the group's scattered pieces back into one
 * segment — that repair is normalize()'s job, not this one's.
 */
export function segments<T extends Grouped>(tabs: T[], groups: TabGroup[]): Segment<T>[] {
  const byId = new Map(groups.map((g) => [g.id, g] as const))
  const result: Segment<T>[] = []
  for (const tab of tabs) {
    const group = tab.groupId !== undefined ? (byId.get(tab.groupId) ?? null) : null
    const current = result[result.length - 1]
    if (current && current.group === group) current.tabs.push(tab)
    else result.push({ group, tabs: [tab] })
  }
  return result
}

/**
 * Repairs a tab list so every group is one contiguous run again, and clears
 * any groupId that no longer names a real group. Used after a raw
 * drag-reorder (which knows nothing about groups) and after restoring
 * `workspace.json` (which might have been hand-edited into an inconsistent
 * state).
 *
 * Order is otherwise preserved as much as possible: walking the list left to
 * right, the first time a group is encountered is where its whole run ends
 * up, gathering the rest of its members (in their original relative order)
 * at that point. An ungrouped tab keeps its position relative to every other
 * tab EXCEPT one it originally sat between two members of the same group —
 * that gap has to close for the run to become contiguous, so the tab that
 * was sitting in it is displaced to just after the completed run.
 */
export function normalize<T extends Grouped>(tabs: T[], groups: TabGroup[]): T[] {
  const validIds = new Set(groups.map((g) => g.id))
  const cleaned = tabs.map((t) => (t.groupId !== undefined && !validIds.has(t.groupId) ? stripGroupId(t) : t))

  const placed = new Set<string>()
  const result: T[] = []
  for (const tab of cleaned) {
    if (placed.has(tab.id)) continue
    result.push(tab)
    placed.add(tab.id)
    if (tab.groupId !== undefined) {
      for (const other of cleaned) {
        if (other.groupId === tab.groupId && !placed.has(other.id)) {
          result.push(other)
          placed.add(other.id)
        }
      }
    }
  }

  // Nothing to repair: same elements, same order. Return the original
  // reference rather than an equal-by-value copy, matching this module's
  // no-op convention elsewhere.
  return result.every((t, i) => t === tabs[i]) ? tabs : result
}

/**
 * Group-aware wrapper around tabreorder's `reorder()`. Performs the same
 * positional move (composes with it rather than re-deriving the splice
 * logic), then decides the moved tab's new groupId from where it landed:
 *
 * - Landing inside — including at either edge of — exactly one group's span
 *   joins that group.
 * - Landing in open space between groups, or exactly on the seam where two
 *   groups are directly adjacent with no gap (ambiguous which one "wins"),
 *   leaves it ungrouped.
 *
 * `insert` uses the same coordinate space `reorder()` itself expects: the
 * index into the list AFTER `from` has been spliced out (see dropIndex's
 * doc comment in tabreorder.ts). Out-of-range `from`/`insert` are clamped
 * rather than thrown on, per this module's no-throw rule.
 */
export function reorderWithGroups<T extends Grouped>(tabs: T[], from: number, insert: number): T[] {
  if (from < 0 || from >= tabs.length) return tabs
  const clampedInsert = Math.max(0, Math.min(insert, tabs.length - 1))

  const rest = [...tabs.slice(0, from), ...tabs.slice(from + 1)]
  const candidateGroupIds = new Set<string>()
  for (const t of rest) if (t.groupId !== undefined) candidateGroupIds.add(t.groupId)

  const touching = [...candidateGroupIds].filter((gid) => {
    const run = groupRun(rest, gid)
    return run !== null && run.start <= clampedInsert && clampedInsert <= run.end
  })
  const nextGroupId = touching.length === 1 ? touching[0] : undefined

  const moved = reorder(tabs, from, clampedInsert)
  const dragged = moved[clampedInsert]
  const patched =
    nextGroupId === undefined
      ? dragged.groupId === undefined
        ? dragged
        : stripGroupId(dragged)
      : { ...dragged, groupId: nextGroupId }

  return [...moved.slice(0, clampedInsert), patched, ...moved.slice(clampedInsert + 1)]
}
