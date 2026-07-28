import { winBasename, winDirname } from '../shared/pathutil'
import type { OpResult, TrashRecord } from '../shared/types'

export interface Command { label: string; do(): Promise<void>; undo(): Promise<void> }

/** Thrown when the main-process policy gate blocks an operation. Carries the
 *  structured verdict so the caller can offer a confirmation instead of a toast. */
export class OpError extends Error {
  constructor(public result: Extract<OpResult<unknown>, { ok: false }>) {
    super(result.reason)
    this.name = 'OpError'
  }
}

/** Unwraps or throws, so a blocked command never reaches the undo stack:
 *  UndoStack.run() pushes only after do() resolves. */
async function must<T>(p: Promise<OpResult<T>>): Promise<T> {
  const r = await p
  if (!r.ok) throw new OpError(r)
  return r.value
}

export class UndoStack {
  private past: Command[] = []
  private future: Command[] = []
  constructor(private capacity = 100, private onEvict?: (c: Command) => void) {}
  canUndo() { return this.past.length > 0 }
  canRedo() { return this.future.length > 0 }
  async run(c: Command) {
    await c.do()
    this.past.push(c)
    this.future = []
    while (this.past.length > this.capacity) this.onEvict?.(this.past.shift()!)
  }
  // Peek, await, then move: a rejected undo/redo must leave both stacks exactly
  // as they were, or the next Ctrl+Z reverses an unrelated earlier operation.
  async undo() { const c = this.past.at(-1); if (!c) return; await c.undo(); this.past.pop(); this.future.unshift(c) }
  async redo() { const c = this.future[0]; if (!c) return; await c.do(); this.future.shift(); this.past.push(c) }
}

// --- factories (do() captures the actual result so undo() reverses reality) ---
// The trailing `confirm` carries the typed word on a retry; main re-validates it.
export function renameCmd(from: string, to: string, confirm?: string): Command {
  return {
    label: `Rename ${winBasename(from)}`,
    do: async () => { await must(window.api.fsRename(from, to, confirm)) },
    undo: async () => { await must(window.api.fsRename(to, from, confirm)) },
  }
}
export function moveCmd(src: string, destDir: string, confirm?: string): Command {
  let finalPath = ''
  const srcDir = winDirname(src)
  return {
    label: `Move ${winBasename(src)}`,
    do: async () => { finalPath = await must(window.api.fsMove(src, destDir, confirm)) },
    undo: async () => { await must(window.api.fsMove(finalPath, srcDir, confirm)) },
  }
}
export function copyCmd(src: string, destDir: string, confirm?: string): Command {
  let finalPath = ''
  return {
    label: `Copy ${winBasename(src)}`,
    do: async () => { finalPath = await must(window.api.fsCopy(src, destDir, confirm)) },
    undo: async () => { await must(window.api.fsDelete([finalPath], { confirm })) }, // remove the copy
  }
}
export function mkdirCmd(parentDir: string, name: string, confirm?: string): Command {
  let created = ''
  return {
    label: `New folder`,
    do: async () => { created = await must(window.api.fsMkdir(`${parentDir}\\${name}`, confirm)) },
    undo: async () => { await must(window.api.fsDelete([created], { confirm })) },
  }
}
export function newFileCmd(parentDir: string, name: string, confirm?: string): Command {
  let created = ''
  return {
    label: `New file`,
    do: async () => { created = await must(window.api.fsNewFile(`${parentDir}\\${name}`, confirm)) },
    undo: async () => { await must(window.api.fsDelete([created], { confirm })) },
  }
}
export function deleteCmd(paths: string[], confirm?: string): Command {
  let records: TrashRecord[] = []
  return {
    label: `Delete ${paths.length} item(s)`,
    do: async () => { records = await must(window.api.fsDelete(paths, { confirm })) },
    undo: async () => { await must(window.api.fsRestore(records)) },
  }
}
