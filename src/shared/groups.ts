import type { TabGroup } from './types'
import { reorder } from './tabreorder'

/**
 * The minimal shape groups.ts needs from a tab. `Tab` (./tabs.ts) does not yet
 * carry `groupId` — another worker owns that file this milestone — so this
 * module is written generically over a structural type instead of importing
 * `Tab` directly. Once `groupId?: string` lands on `Tab`, every exported
 * function here already accepts it with zero changes: `Tab` will satisfy
 * `Grouped` structurally. Deliberately not a duplicate `Tab` interface.
 */
export type Grouped = { id: string; groupId?: string; pinned?: boolean }

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

function stripPinned<T extends Grouped>(t: T): T {
  const { pinned: _drop, ...rest } = t
  return rest as T
}

/**
 * The seam between the two regions of the strip: the index of the first
 * unpinned tab, i.e. the one position that is simultaneously "after every
 * pinned tab" and "before every unpinned one". Both `setPinned` directions
 * insert exactly here, and `reorderWithGroups` clamps against it.
 *
 * Assumes the pinned-first invariant already holds — repairing a list that has
 * pinned tabs scattered through it is `normalize()`'s job, not this one's,
 * exactly as `groupRun` leaves contiguity repair to `normalize()`.
 */
function pinBoundary<T extends Grouped>(tabs: T[]): number {
  const i = tabs.findIndex((t) => !t.pinned)
  return i === -1 ? tabs.length : i
}

/**
 * Pins or unpins `tabId` (KAN-53). Pinning is a STATE change, not a position:
 * the tab relocates to the seam either way — pinning makes it the last pinned
 * tab, unpinning makes it the first unpinned one — because pinned-before-
 * unpinned is an ordering invariant of the strip, not something the user drags
 * their way into.
 *
 * Pinning also DROPS the tab's groupId, and that is structural rather than
 * stylistic: a group is a contiguous run (see `normalize`) and a pinned tab is
 * forced to the left of every unpinned one, so a pinned member could only ever
 * break its group's run or drag the whole group leftward with it. Chrome
 * resolves it the same way. The group keeps its other members, still one run:
 * pulling one element out of a contiguous block leaves a contiguous block, and
 * the tab lands in the pinned region, ahead of every group.
 *
 * No-op (same reference) for an unknown tabId or a state that already holds.
 */
export function setPinned<T extends Grouped>(tabs: T[], tabId: string, pinned: boolean): T[] {
  const idx = tabs.findIndex((t) => t.id === tabId)
  if (idx === -1 || !!tabs[idx].pinned === pinned) return tabs

  const rest = [...tabs.slice(0, idx), ...tabs.slice(idx + 1)]
  const at = pinBoundary(rest)
  const moved = pinned ? { ...stripGroupId(tabs[idx]), pinned: true } : stripPinned(tabs[idx])
  return [...rest.slice(0, at), moved, ...rest.slice(at)]
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
 * An unknown tabId is a no-op: returns `tabs` unchanged. So is a PINNED one
 * (KAN-53) — a pinned tab lives left of every group, so joining one would mean
 * leaving the pinned block, and pinning is a state change the user makes
 * explicitly. Unpin first. `groupId` itself is not validated against a groups
 * list (this module keeps membership and the group registry separate) — pass a
 * live TabGroup id, or clean up later with `normalize()`.
 */
export function addToGroup<T extends Grouped>(tabs: T[], tabId: string, groupId: string): T[] {
  const idx = tabs.findIndex((t) => t.id === tabId)
  if (idx === -1 || tabs[idx].pinned) return tabs

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
 * Repairs a tab list so both ordering invariants of the rendered strip hold:
 * every pinned tab sits left of every unpinned one, and every group is one
 * contiguous run. Also clears any groupId that no longer names a real group,
 * or that a pinned tab is carrying (pinning and grouping are mutually
 * exclusive — see `setPinned`). Used after a raw drag-reorder (which knows
 * nothing about groups) and after restoring `workspace.json` (which might have
 * been hand-edited into an inconsistent state).
 *
 * Pinned-first runs BEFORE the contiguity pass, and as a stable partition, so
 * the two repairs cannot fight: once every pinned tab has been hoisted (and
 * un-grouped), no group has a member in the pinned region, so gathering runs
 * can only ever move tabs around within the unpinned tail.
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
  const cleaned = tabs.map((t) =>
    t.groupId !== undefined && (t.pinned || !validIds.has(t.groupId)) ? stripGroupId(t) : t,
  )
  const partitioned = cleaned.some((t) => t.pinned)
    ? [...cleaned.filter((t) => t.pinned), ...cleaned.filter((t) => !t.pinned)]
    : cleaned

  const placed = new Set<string>()
  const result: T[] = []
  for (const tab of partitioned) {
    if (placed.has(tab.id)) continue
    result.push(tab)
    placed.add(tab.id)
    if (tab.groupId !== undefined) {
      for (const other of partitioned) {
        if (other.groupId === tab.groupId && !placed.has(other.id)) {
          result.push(other)
          placed.add(other.id)
        }
      }
    }
  }

  // Nothing to repair: same elements, same order. Length must match too — a
  // trailing duplicate id (`[t1,t2,t2]`) makes `result` a same-length-prefix
  // match against a *shorter* deduped list only when the dupe isn't trailing,
  // but a plain `.every` on `result` alone is true whenever `result` is a
  // PREFIX of `tabs`, which a trailing dupe always produces — so the dupe
  // would silently survive. Return the original reference rather than an
  // equal-by-value copy, matching this module's no-op convention elsewhere.
  return result.length === tabs.length && result.every((t, i) => t === tabs[i]) ? tabs : result
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
 *
 * KAN-53: that clamp also confines the drag to the tab's own REGION. A pinned
 * tab may land anywhere in [0, boundary] and an unpinned one anywhere in
 * [boundary, end] — so a drag can reorder within a region but never carry a
 * tab across the seam, because pinning is a state change, not a position.
 * A pinned tab is likewise never given a groupId: it sits left of every group,
 * so "touching" one is an artefact of the clamp, not a real drop onto its run.
 */
export function reorderWithGroups<T extends Grouped>(tabs: T[], from: number, insert: number): T[] {
  if (from < 0 || from >= tabs.length) return tabs

  const rest = [...tabs.slice(0, from), ...tabs.slice(from + 1)]
  // `rest.length === tabs.length - 1`, so both bounds stay inside the old
  // clamp's range and this only ever narrows it.
  const boundary = pinBoundary(rest)
  const [lo, hi] = tabs[from].pinned ? [0, boundary] : [boundary, rest.length]
  const clampedInsert = Math.max(lo, Math.min(insert, hi))

  const candidateGroupIds = new Set<string>()
  if (!tabs[from].pinned) for (const t of rest) if (t.groupId !== undefined) candidateGroupIds.add(t.groupId)

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
