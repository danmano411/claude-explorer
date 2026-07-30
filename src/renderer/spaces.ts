/**
 * Spaces — the pure logic layer for KAN-45. A "space" is a saved workspace you
 * switch between: a named, ordered set of tab ids with its own remembered
 * active tab.
 *
 * ## The invariant: a tab belongs to EXACTLY ONE space
 *
 * Every mutator here preserves it and `normalizeSpaces` restores it from
 * arbitrary input. Both failure directions are real bugs, not cosmetic:
 *
 *  - **Zero** spaces own a tab → the tab is unreachable. There is no UI that
 *    can show it, so a live Claude session keeps burning tokens with no way
 *    back to it and no way to close it. This is the worst outcome in the
 *    feature, which is why `normalizeSpaces` *adopts* orphans into the active
 *    space rather than dropping them.
 *  - **Two** spaces own a tab → it renders in both, and PTY ownership becomes
 *    ambiguous: closing the space that "has" it would kill a process the other
 *    space is still showing. So `addTabToSpace` evicts the tab from every other
 *    space instead of just appending.
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
 * Written generically over a local structural type (see `Spaced`), in the shape
 * of `groups.ts`: pure, total, immutable in and out, no React, no IPC.
 */

/**
 * The minimal shape this module needs from a space. `Space`
 * (../shared/types.ts) does not yet carry `activeTabId` — another worker owns
 * that file this milestone — so nothing here imports it. Once
 * `activeTabId?: string` lands on `Space`, every exported function already
 * accepts it with zero changes: `Space` satisfies `Spaced` structurally, and
 * extra fields (`layout`) ride through the spreads untouched. Deliberately not
 * a duplicate `Space` interface.
 */
export type Spaced = { id: string; name: string; tabIds: string[]; activeTabId?: string }

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

/** Appends a new empty space. Returns the new list and the new space's id (the
 *  caller needs it to switch to what it just created). */
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
 * Removes a space. `closedTabIds` is the membership it owned: those tabs go
 * away with it, and killing their PTYs is the caller's job (see the module
 * doc). Refused, never silently allowed, when it is the only space left.
 *
 * `activeSpaceId` comes back adjusted: deleting the space you are standing in
 * moves you to the one that took its slot (or the one before it), so the caller
 * cannot accidentally keep pointing at a space that no longer exists. Feed it
 * to `switchSpace` to get the tab ids to render.
 */
export function deleteSpace<T extends Spaced>(
  spaces: readonly T[],
  activeSpaceId: string,
  spaceId: string,
):
  | { ok: true; spaces: T[]; activeSpaceId: string; closedTabIds: string[] }
  | { ok: false; reason: 'NO_SUCH_SPACE' | 'LAST_SPACE' } {
  const i = spaces.findIndex((s) => s.id === spaceId)
  if (i === -1) return { ok: false, reason: 'NO_SUCH_SPACE' }
  if (spaces.length <= 1) return { ok: false, reason: 'LAST_SPACE' }

  const closedTabIds = [...spaces[i].tabIds]
  const next = spaces.filter((_, k) => k !== i)
  const nextActiveSpaceId = spaceId === activeSpaceId ? (next[i] ?? next[i - 1]).id : activeSpaceId
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
 * Repairs a space list after a restore from a possibly hand-edited
 * `workspace.json`. Total, and the only function here that will invent a space.
 *
 *  - Membership is filtered to `knownTabIds`, so a space cannot reference a tab
 *    that does not exist.
 *  - A tab claimed by two spaces (or listed twice in one) is kept at its FIRST
 *    occurrence only — never two.
 *  - A known tab that no space claims is adopted by the active space — never
 *    zero. It lands somewhere visible on purpose: an orphan is likely a live
 *    session, and burying it in a space the user is not looking at is barely
 *    better than losing it.
 *  - Two spaces sharing an id are collapsed to the first: a duplicate id makes
 *    every lookup in this module ambiguous.
 *  - An `activeTabId` that is not a member of its own space is dropped.
 *  - At least one space exists afterwards, and `activeSpaceId` names one of
 *    them.
 *
 * Deliberately does NOT invent an `activeTabId` for a space that has tabs but
 * no remembered active one: "no tab focused" is a legal state, and which tab a
 * pane focuses on arrival is the renderer's call, not persistence's.
 */
export function normalizeSpaces<T extends Spaced>(
  spaces: readonly T[],
  knownTabIds: readonly string[],
  activeSpaceId: string,
): { spaces: T[]; activeSpaceId: string } {
  const known = new Set(knownTabIds)
  const claimed = new Set<string>()
  const spaceIds = new Set<string>()

  const cleaned: T[] = []
  for (const s of spaces) {
    if (spaceIds.has(s.id)) continue
    spaceIds.add(s.id)
    const tabIds: string[] = []
    for (const id of s.tabIds) {
      if (!known.has(id) || claimed.has(id)) continue
      claimed.add(id)
      tabIds.push(id)
    }
    cleaned.push(tabIds.length === s.tabIds.length ? s : { ...s, tabIds })
  }
  if (cleaned.length === 0) cleaned.push(blank<T>('Space'))

  const activeIdx = Math.max(
    0,
    cleaned.findIndex((s) => s.id === activeSpaceId),
  )

  const orphans: string[] = []
  for (const id of knownTabIds) {
    if (claimed.has(id)) continue
    claimed.add(id) // a duplicated knownTabIds entry must not be adopted twice
    orphans.push(id)
  }
  if (orphans.length > 0) {
    const host = cleaned[activeIdx]
    cleaned[activeIdx] = { ...host, tabIds: [...host.tabIds, ...orphans] }
  }

  const repaired = cleaned.map((s) =>
    s.activeTabId !== undefined && !s.tabIds.includes(s.activeTabId) ? stripActiveTab(s) : s,
  )

  // Nothing to repair: same spaces, same order, same references — matching this
  // module's no-op convention elsewhere. `activeSpaceId` is resolved
  // independently, so an untouched list can still come back with a corrected
  // active id.
  const unchanged = repaired.length === spaces.length && repaired.every((s, i) => s === spaces[i])
  return {
    spaces: unchanged ? (spaces as T[]) : repaired,
    activeSpaceId: cleaned[activeIdx].id,
  }
}
