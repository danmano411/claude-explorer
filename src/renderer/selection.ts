export interface Selection { anchor: number | null; indices: Set<number> }
export const emptySelection = (): Selection => ({ anchor: null, indices: new Set() })

function range(a: number, b: number): number[] {
  const [lo, hi] = a <= b ? [a, b] : [b, a]
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)
}

export function applyClick(sel: Selection, index: number, mods: { ctrl: boolean; shift: boolean }): Selection {
  if (mods.shift) {
    const from = sel.anchor ?? 0
    const r = range(from, index)
    const indices = mods.ctrl ? new Set([...sel.indices, ...r]) : new Set(r)
    return { anchor: mods.ctrl ? index : from, indices }
  }
  if (mods.ctrl) {
    const indices = new Set(sel.indices)
    indices.has(index) ? indices.delete(index) : indices.add(index)
    return { anchor: index, indices }
  }
  return { anchor: index, indices: new Set([index]) }
}
