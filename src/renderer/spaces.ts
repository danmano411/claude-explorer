/**
 * Spaces — the pure logic layer for KAN-45. A "space" is a saved workspace you
 * switch between: a named, ordered set of tab ids with its own remembered
 * active tab.
 *
 * ## `space.tabIds` is AUTHORITATIVE for order and membership
 *
 * The workspace document has two tab-bearing arrays and only one of them may
 * define order. It is this one. `Workspace.tabs` is an unordered store keyed by
 * id — it says what a tab *is* (cwd, view, groupId); `tabIds` says which space
 * shows it and in what order the strip draws it. Two consequences that are easy
 * to get wrong:
 *
 *  - **Reorder is space-relative.** The strip renders `tabIds`, so the indices
 *    a drag produces index `tabIds`, not `Workspace.tabs`. That is what
 *    `reorderInSpace` is for; reordering the global array instead moves the
 *    wrong tab as soon as a second space exists.
 *  - **`groups.ts` contiguity applies to the space's slice**, not to the global
 *    array. A group is drawn as one run inside one strip, and the strip is one
 *    space's `tabIds`. `sanitize()` (src/main/workspace.ts) enforces this by
 *    running `normalize()` over each space's member slice. An integrator wiring
 *    a group-aware drag composes `reorderWithGroups` over the space's slice of
 *    tab objects for the groupId decision, then feeds the resulting id order
 *    back through `reorderInSpace` — this module holds ids only and cannot see
 *    a groupId.
 *
 * ## The invariant: a tab belongs to EXACTLY ONE space
 *
 * Every mutator here preserves it. It is *established* one layer down, by
 * `sanitize()` in src/main/workspace.ts, which is the single repair path for
 * the whole document (see "Where repair lives" below). Both failure directions
 * are real bugs, not cosmetic:
 *
 *  - **Zero** spaces own a tab → the tab is unreachable. There is no UI that
 *    can show it, so a live Claude session keeps burning tokens with no way
 *    back to it and no way to close it. This is the worst outcome in the
 *    feature, which is why `sanitize()` *adopts* orphans into the active space
 *    rather than dropping them.
 *  - **Two** spaces own a tab → it renders in both, and PTY ownership becomes
 *    ambiguous: closing the space that "has" it would kill a process the other
 *    space is still showing. So `addTabToSpace` evicts the tab from every other
 *    space instead of just appending.
 *
 * Note what is NOT a violation: a space member with no `GridCell` in that
 * space's `layout`. The tab strip is what makes a tab reachable — the grid is
 * placement only, and clicking a strip tab shows it in the focused pane. So
 * `addTabToSpace` has no obligation to find the tab a free cell.
 *
 * ## Where repair lives: `sanitize()`, and nowhere else
 *
 * Nothing here is total on a hand-edited `workspace.json`, and nothing here
 * tries to be. Every document the renderer ever sees has already been through
 * `sanitize()` — it is called on read *and* on write in src/main/workspace.ts,
 * so there is no path from disk to these functions that skips it. It is what
 * coerces types, drops members naming no tab, collapses duplicate space ids,
 * gives a tab claimed by two spaces to the first, adopts orphans and repoints a
 * dangling `activeSpaceId`. A second normalizer in the renderer would be a
 * second thing to keep in step with the first, so there isn't one: the
 * functions below assume a sanitized document and say so where it shows.
 *
 * ## Why deleting the last space is refused
 *
 * Zero spaces is not a representable state for the app: `activeSpaceId` would
 * name nothing, there would be nowhere to put a new tab, and every existing tab
 * would instantly become an orphan (see above). Rather than paper over it by
 * silently recreating a default space — which loses the deleted space's tabs
 * with no way for the caller to notice — `deleteSpace` returns
 * `{ ok: false, reason: 'LAST_SPACE' }` so the UI can disable the menu item and
 * say why.
 *
 * ## Caller obligation this module CANNOT enforce: do not kill PTYs on switch
 *
 * Switching spaces must change which tabs *render* and nothing else. The tabs
 * of the space you are leaving stay alive — a Claude session in another space
 * has to still be running, mid-response even, when you come back to it, with
 * its scrollback intact. Concretely, at integration: unmount/hide the pane,
 * never call `pty:kill`, and keep the xterm buffer (or the tab's data) around.
 * This module only moves ids between lists; it has no idea a PTY exists, so
 * nothing in here will stop you from destroying one. `deleteSpace` is the ONLY
 * operation that intends process death, which is exactly why it returns
 * `closedTabIds` — that list, and only that list, is what may be killed.
 *
 * ## Caller obligation 2: persist off `spaces`, not off the tab list
 *
 * A space is legally empty — `createSpace` makes one that way, and you are
 * expected to be looking at it before you open anything in it. The persistence
 * effect in App.tsx bails on `if (!tabs.length) return`, which means the write
 * that would have recorded a brand-new empty space never happens and the space
 * is gone on restart. The workspace document is `spaces` + `tabs`; it has to be
 * written whenever EITHER changes, not only when there is a tab to write.
 *
 * Written generically over a local structural type (see `Spaced`), in the shape
 * of `groups.ts`: pure, immutable in and out, no React, no IPC.
 */

import { reorder } from '../shared/tabreorder'

/**
 * The minimal shape this module needs from a space — the `groups.ts` `Grouped`
 * precedent, so nothing here imports `Space` and this file stays a leaf. `Space`
 * (../shared/types.ts, `activeTabId` included since KAN-43) satisfies it
 * structurally, and the fields it has that this module has no opinion about
 * (`layout`) ride through the spreads untouched. Deliberately not a duplicate
 * `Space` interface.
 */
export type Spaced = {
  id: string
  name: string
  tabIds: string[]
  activeTabId?: string
  /** KAN-57. Absent means unpinned; see `Space.pinned` in ../shared/types.ts. */
  pinned?: boolean
}

/**
 * A fresh, empty space.
 *
 * ponytail: the cast assumes `T` is `Space` or a widening of it — `layout: null`
 * is included so it genuinely is a complete `Space` at runtime. A `T` with extra
 * REQUIRED fields would get an incomplete object; if one ever appears, take a
 * `makeSpace: () => T` factory parameter instead of casting.
 */
function blank<T extends Spaced>(name: string): T {
  return { id: crypto.randomUUID(), name, tabIds: [], layout: null } as unknown as T
}

function stripActiveTab<T extends Spaced>(s: T): T {
  const { activeTabId: _drop, ...rest } = s
  return rest as T
}

function replaceAt<T>(list: readonly T[], index: number, value: T): T[] {
  const next = [...list]
  next[index] = value
  return next
}

/**
 * Drops `tabId` from one space's membership and repairs its `activeTabId`: if
 * the removed tab was the active one, the neighbour that slid into its slot
 * takes over, else the one before it, else the space has no active tab. Removes
 * every copy, so it also un-duplicates a hand-edited list.
 */
function withoutTab<T extends Spaced>(s: T, tabId: string): T {
  const pos = s.tabIds.indexOf(tabId)
  if (pos === -1) return s
  const tabIds = s.tabIds.filter((id) => id !== tabId)
  const nextActive = s.activeTabId === tabId ? (tabIds[pos] ?? tabIds[pos - 1]) : s.activeTabId
  return nextActive === undefined ? stripActiveTab({ ...s, tabIds }) : { ...s, tabIds, activeTabId: nextActive }
}

/**
 * Appends a new empty space. Returns the new list and the new space's id (the
 * caller needs it to switch to what it just created).
 *
 * Empty is the only kind of space you can create, and there is deliberately no
 * `duplicateSpace`. "Save this arrangement as a new space" cannot mean anything
 * under the exactly-one-owner invariant: copying the tab ids gives every tab two
 * owners, and moving them (`createSpace` + `addTabToSpace`, which evicts) empties
 * the space you were trying to snapshot. A real duplicate would have to clone the
 * `Tab` records and spawn second PTYs, which is a tab-lifecycle decision that
 * does not belong in a pure id-shuffling module. The menu item was dropped
 * instead.
 */
export function createSpace<T extends Spaced>(spaces: readonly T[], name: string): { spaces: T[]; id: string } {
  const created = blank<T>(name)
  return { spaces: [...spaces, created], id: created.id }
}

/** No-op (same reference) for an unknown spaceId. */
export function renameSpace<T extends Spaced>(spaces: readonly T[], spaceId: string, name: string): T[] {
  const i = spaces.findIndex((s) => s.id === spaceId)
  if (i === -1) return spaces as T[]
  return replaceAt(spaces, i, { ...spaces[i], name })
}

/**
 * Pins/unpins a space, which gates exactly one thing: `deleteSpace`.
 *
 * Unpinning DELETES the key rather than writing `false` (the `stripActiveTab`
 * precedent), so a space that was never pinned and one that has been unpinned
 * persist identically and neither writes a field a pre-KAN-57 reader would see.
 *
 * No-op (same reference) for an unknown spaceId or a state that already holds —
 * the caller re-renders off identity like every other mutator here.
 */
export function setSpacePinned<T extends Spaced>(spaces: readonly T[], spaceId: string, pinned: boolean): T[] {
  const i = spaces.findIndex((s) => s.id === spaceId)
  if (i === -1) return spaces as T[]
  if (!!spaces[i].pinned === pinned) return spaces as T[]
  if (!pinned) {
    const { pinned: _drop, ...rest } = spaces[i]
    return replaceAt(spaces, i, rest as T)
  }
  return replaceAt(spaces, i, { ...spaces[i], pinned: true })
}

/**
 * KAN-81. Pinned spaces first, unpinned after — a stable PARTITION, not a
 * sort: nothing here compares two pinned spaces against each other (or two
 * unpinned ones), so the order the user arranged WITHIN each run survives
 * untouched. `Array.prototype.filter` preserves relative order, which is the
 * entire mechanism.
 *
 * The one place order matters until KAN-81: today, nothing sorts or draws
 * `pinned` at all (see `Space.pinned`'s doc) and rows render in raw `spaces`
 * order. This is the first caller — SpaceMenu's dropdown, and App's Ctrl+Tab
 * cycling — so it belongs here rather than duplicated at each call site.
 */
export function orderSpaces<T extends Spaced>(spaces: readonly T[]): T[] {
  return [...spaces.filter((s) => s.pinned), ...spaces.filter((s) => !s.pinned)]
}

/**
 * Removes a space. `closedTabIds` is the membership it owned: those tabs go
 * away with it, and killing their PTYs is the caller's job (see the module
 * doc). Refused, never silently allowed, when it is the only space left.
 *
 * `activeSpaceId` comes back adjusted: deleting the space you are standing in
 * moves you to the one that took its slot (or the one before it), so the caller
 * cannot accidentally keep pointing at a space that no longer exists. Feed it
 * to `switchSpace` to get the tab ids to render.
 *
 * The returned id ALWAYS resolves against the returned list, including when the
 * `activeSpaceId` handed in named nothing — passing a stale one through
 * untouched just because it was not the space being deleted would hand the
 * caller a dangling id it never had a way to notice.
 *
 * `PINNED` (KAN-57) is checked here, in the data layer, and not only in the menu
 * that hides the button: the refusal has to hold for every caller, and refusing
 * BEFORE `closedTabIds` is built means a pinned space can never hand out the tab
 * list whose PTYs the caller is licensed to kill. Order is identity → the user's
 * explicit instruction → the structural floor, so a pinned lone space reports
 * `PINNED` — the thing it can actually undo.
 */
export function deleteSpace<T extends Spaced>(
  spaces: readonly T[],
  activeSpaceId: string,
  spaceId: string,
):
  | { ok: true; spaces: T[]; activeSpaceId: string; closedTabIds: string[] }
  | { ok: false; reason: 'NO_SUCH_SPACE' | 'PINNED' | 'LAST_SPACE' } {
  const i = spaces.findIndex((s) => s.id === spaceId)
  if (i === -1) return { ok: false, reason: 'NO_SUCH_SPACE' }
  if (spaces[i].pinned) return { ok: false, reason: 'PINNED' }
  if (spaces.length <= 1) return { ok: false, reason: 'LAST_SPACE' }

  const closedTabIds = [...spaces[i].tabIds]
  const next = spaces.filter((_, k) => k !== i)
  const nextActiveSpaceId =
    spaceId === activeSpaceId
      ? (next[i] ?? next[i - 1]).id
      : next.some((s) => s.id === activeSpaceId)
        ? activeSpaceId
        : next[0].id
  return { ok: true, spaces: next, activeSpaceId: nextActiveSpaceId, closedTabIds }
}

/**
 * Resolves a switch: the id you end up on, plus that space's membership and its
 * remembered active tab. Total — an unknown `targetId` keeps you where you are,
 * an unknown `activeSpaceId` too falls back to the first space, and an empty
 * list (which `normalizeSpaces` will not produce) yields no tabs rather than
 * throwing.
 *
 * Note what is NOT here: nothing is mutated. Switching is a read; the space
 * being left keeps its `tabIds` and its `activeTabId` exactly as they were,
 * which is the persisted half of "come back and it is how you left it".
 */
export function switchSpace<T extends Spaced>(
  spaces: readonly T[],
  activeSpaceId: string,
  targetId: string,
): { activeSpaceId: string; tabIds: string[]; activeTabId?: string } {
  const s =
    spaces.find((x) => x.id === targetId) ?? spaces.find((x) => x.id === activeSpaceId) ?? spaces[0] ?? null
  if (s === null) return { activeSpaceId, tabIds: [] }
  return { activeSpaceId: s.id, tabIds: [...s.tabIds], activeTabId: s.activeTabId }
}

/**
 * Records the per-space active tab. Refused (same reference) for an unknown
 * space, or a tabId that is not a member of THAT space — a space must never
 * remember an active tab it does not own, or switching to it would try to focus
 * something another space is rendering.
 */
export function setActiveTab<T extends Spaced>(spaces: readonly T[], spaceId: string, tabId: string): T[] {
  const i = spaces.findIndex((s) => s.id === spaceId)
  if (i === -1) return spaces as T[]
  if (!spaces[i].tabIds.includes(tabId)) return spaces as T[]
  if (spaces[i].activeTabId === tabId) return spaces as T[]
  return replaceAt(spaces, i, { ...spaces[i], activeTabId: tabId })
}

/**
 * Appends `tabId` to a space, evicting it from every OTHER space first — that
 * eviction is what makes this both "add" and "move between spaces", and is the
 * only reason the exactly-one invariant survives a drag between space chips.
 * Each source space's `activeTabId` is repaired by `withoutTab`.
 *
 * The added tab becomes the space's active tab only when that space had none
 * (an empty space, or one whose remembered active tab was dropped): adding a
 * tab to a space you are not looking at must not silently move its focus.
 *
 * No-op (same reference) for an unknown spaceId, or when the tab is already a
 * member of that space.
 *
 * That second no-op does NOT repair a dirty target: given a document where the
 * tab is already listed in this space *and* in another one (or listed twice
 * here), adding it again returns the list unchanged, two owners and all. That
 * is deliberate. The precondition of every function in this module is a
 * sanitized document, and `sanitize()` cannot hand out a two-owner document —
 * so a dirty input here means a caller built one in memory, which repairing
 * silently would hide. Repair belongs in one place; see the module doc.
 */
export function addTabToSpace<T extends Spaced>(spaces: readonly T[], spaceId: string, tabId: string): T[] {
  const i = spaces.findIndex((s) => s.id === spaceId)
  if (i === -1) return spaces as T[]
  if (spaces[i].tabIds.includes(tabId)) return spaces as T[]

  const evicted = spaces.map((s, k) => (k === i ? s : withoutTab(s, tabId)))
  const target = evicted[i]
  return replaceAt(evicted, i, {
    ...target,
    tabIds: [...target.tabIds, tabId],
    activeTabId: target.activeTabId ?? tabId,
  })
}

/**
 * Drops `tabId` from a space. The caller closes the tab itself; this only
 * revokes membership, leaving a valid `activeTabId` or none at all.
 *
 * No-op (same reference) for an unknown spaceId or a tab that is not a member.
 * Note that removing a tab without adding it somewhere else breaks the
 * exactly-one invariant by construction — that is correct only when the tab is
 * being closed. To MOVE a tab, call `addTabToSpace` on the destination, which
 * evicts it from the source for you.
 */
export function removeTabFromSpace<T extends Spaced>(spaces: readonly T[], spaceId: string, tabId: string): T[] {
  const i = spaces.findIndex((s) => s.id === spaceId)
  if (i === -1) return spaces as T[]
  const next = withoutTab(spaces[i], tabId)
  if (next === spaces[i]) return spaces as T[]
  return replaceAt(spaces, i, next)
}

/**
 * Moves a tab within one space's order. Composes `tabreorder.reorder` rather
 * than re-deriving the splice, exactly as `groups.reorderWithGroups` does.
 *
 * `from` and `insert` index THAT SPACE'S `tabIds` — see the authority rule in
 * the module doc. The strip renders `tabIds`, so a drag over it produces
 * space-relative indices; handing them to a reorder over `Workspace.tabs`
 * instead moves whichever tab happens to sit at that global index. `insert` is
 * post-splice, the coordinate space `tabreorder.reorder` expects.
 *
 * Membership does not change, so `activeTabId` stays valid by construction and
 * is left alone. No-op (same reference) for an unknown spaceId, an out-of-range
 * `from`, or a move that lands where it started; `insert` is clamped rather
 * than thrown on, matching `reorderWithGroups`.
 */
export function reorderInSpace<T extends Spaced>(
  spaces: readonly T[],
  spaceId: string,
  from: number,
  insert: number,
): T[] {
  const i = spaces.findIndex((s) => s.id === spaceId)
  if (i === -1) return spaces as T[]
  const { tabIds } = spaces[i]
  if (from < 0 || from >= tabIds.length) return spaces as T[]
  const clamped = Math.max(0, Math.min(insert, tabIds.length - 1))
  if (clamped === from) return spaces as T[]
  return replaceAt(spaces, i, { ...spaces[i], tabIds: reorder(tabIds, from, clamped) })
}
