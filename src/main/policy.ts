import type { FileMode } from '../shared/types'

export type Op = 'delete' | 'permanentDelete' | 'move' | 'copy' | 'rename' | 'mkdir' | 'newFile'
export type PathClass = 'system' | 'driveRoot' | 'trash' | 'normal'

export type Verdict =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'confirm'; reason: string; typed: boolean }

export const CONFIRM_WORD = 'CONFIRM'
export const TRASH_DIR_NAME = '.claude-explorer-trash'

export const DEFAULT_SYSTEM_ROOTS = [
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
]

/** Lower-case, backslash-only, no trailing separator. */
function norm(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** True when `child` IS `parent` or sits beneath it. Segment-aware, so
 *  "C:\WindowsBackup" is not treated as living under "C:\Windows". */
function isUnder(child: string, parent: string): boolean {
  const c = norm(child)
  const p = norm(parent)
  return c === p || c.startsWith(p + '\\')
}

export function classify(path: string, roots: string[] = DEFAULT_SYSTEM_ROOTS): PathClass {
  const n = norm(path)
  // Trash is checked first: it is denied in BOTH modes, so it must win over
  // any other classification that might merely require confirmation.
  if (n.split('\\').includes(TRASH_DIR_NAME)) return 'trash'
  if (/^[a-z]:$/.test(n)) return 'driveRoot'
  for (const r of roots) if (isUnder(path, r)) return 'system'
  return 'normal'
}

export function check(
  op: Op,
  paths: string[],
  mode: FileMode,
  roots: string[] = DEFAULT_SYSTEM_ROOTS,
): Verdict {
  if (op === 'permanentDelete' && mode === 'explorer') {
    return {
      kind: 'deny',
      reason:
        'Permanent delete is a Developer mode operation. Switch modes in the status bar if you really need it.',
    }
  }

  for (const p of paths) {
    const cls = classify(p, roots)
    if (cls === 'trash') {
      return {
        kind: 'deny',
        reason:
          "That's Claude Explorer's own undo staging folder — changing it would break pending undo.",
      }
    }
    if (cls === 'system' || cls === 'driveRoot') {
      const what = cls === 'system' ? 'A system folder' : 'A drive root'
      if (mode === 'explorer') {
        return { kind: 'deny', reason: `${what}. Switch to Developer mode if you really need this.` }
      }
      return {
        kind: 'confirm',
        reason: `${what} — this can break Windows. Type ${CONFIRM_WORD} to proceed.`,
        typed: true,
      }
    }
  }

  if (op === 'permanentDelete') {
    return {
      kind: 'confirm',
      reason: `Permanent delete skips the trash and cannot be undone with Ctrl+Z. Type ${CONFIRM_WORD} to proceed.`,
      typed: true,
    }
  }

  // Normal deletes are deliberately NOT confirmed: Windows 11 does not confirm
  // Recycle Bin deletes, and trash staging + Ctrl+Z already cover this.
  return { kind: 'allow' }
}

/** The chokepoint. Returns null when the operation may proceed, otherwise the
 *  blocking verdict. Re-validates on every call — a caller that supplies a
 *  confirm value is never trusted to have actually earned it. */
export function gate(
  op: Op,
  paths: string[],
  mode: FileMode,
  confirm?: string,
  roots: string[] = DEFAULT_SYSTEM_ROOTS,
): Verdict | null {
  const v = check(op, paths, mode, roots)
  if (v.kind === 'allow') return null
  if (v.kind === 'deny') return v
  const satisfied = v.typed ? confirm === CONFIRM_WORD : confirm !== undefined
  return satisfied ? null : v
}
