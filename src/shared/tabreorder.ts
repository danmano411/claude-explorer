// Move one item within a list. `insert` is a POST-SPLICE index: a position in
// the list with `from` already removed, which is the coordinate space every
// caller here speaks (groups.reorderWithGroups, groups.moveGroupRun,
// spaces.reorderInSpace) and the one the sliding drag computes directly from
// pointer geometry.
export function reorder<T>(list: T[], from: number, insert: number): T[] {
  const a = [...list]
  const [moved] = a.splice(from, 1)
  a.splice(insert, 0, moved)
  return a
}
