export function sameDrive(a: string, b: string): boolean {
  return a.slice(0, 1).toLowerCase() === b.slice(0, 1).toLowerCase()
}

export function winBasename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] ?? p
}

export function winDirname(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const i = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  return i <= 0 ? trimmed : trimmed.slice(0, i)
}

function splitExt(name: string): [string, string] {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
}

export function uniqueName(existing: string[], name: string): string {
  const set = new Set(existing)
  if (!set.has(name)) return name
  const [base, ext] = splitExt(name)
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})${ext}`
    if (!set.has(candidate)) return candidate
  }
}
