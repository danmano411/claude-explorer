// Where a dragged tab lands. `over` is the hovered tab's current index; `side`
// is which half of it the cursor is on. Returns the insert index to use AFTER
// the dragged item has been spliced out (so it feeds straight into `reorder`).
export function dropIndex(from: number, over: number, side: 'left' | 'right'): number {
  let insert = side === 'right' ? over + 1 : over
  if (from < insert) insert -= 1
  return insert
}

export function reorder<T>(list: T[], from: number, insert: number): T[] {
  const a = [...list]
  const [moved] = a.splice(from, 1)
  a.splice(insert, 0, moved)
  return a
}
