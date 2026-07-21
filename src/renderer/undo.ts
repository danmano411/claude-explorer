import { winBasename } from '../shared/pathutil'
import type { TrashRecord } from '../shared/types'

export interface Command { label: string; do(): Promise<void>; undo(): Promise<void> }

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
  async undo() { const c = this.past.pop(); if (!c) return; await c.undo(); this.future.unshift(c) }
  async redo() { const c = this.future.shift(); if (!c) return; await c.do(); this.past.push(c) }
}

// --- factories (do() captures the actual result so undo() reverses reality) ---
export function renameCmd(from: string, to: string): Command {
  return { label: `Rename ${winBasename(from)}`, do: () => window.api.fsRename(from, to), undo: () => window.api.fsRename(to, from) }
}
export function moveCmd(src: string, destDir: string): Command {
  let finalPath = ''
  const srcDir = src.slice(0, src.lastIndexOf('\\'))
  return {
    label: `Move ${winBasename(src)}`,
    do: async () => { finalPath = await window.api.fsMove(src, destDir) },
    undo: async () => { await window.api.fsMove(finalPath, srcDir) },
  }
}
export function copyCmd(src: string, destDir: string): Command {
  let finalPath = ''
  return {
    label: `Copy ${winBasename(src)}`,
    do: async () => { finalPath = await window.api.fsCopy(src, destDir) },
    undo: async () => { await window.api.fsDelete([finalPath]) }, // remove the copy
  }
}
export function mkdirCmd(parentDir: string, name: string): Command {
  let created = ''
  return {
    label: `New folder`,
    do: async () => { created = await window.api.fsMkdir(`${parentDir}\\${name}`) },
    undo: async () => { await window.api.fsDelete([created]) },
  }
}
export function newFileCmd(parentDir: string, name: string): Command {
  let created = ''
  return {
    label: `New file`,
    do: async () => { created = await window.api.fsNewFile(`${parentDir}\\${name}`) },
    undo: async () => { await window.api.fsDelete([created]) },
  }
}
export function deleteCmd(paths: string[]): Command {
  let records: TrashRecord[] = []
  return {
    label: `Delete ${paths.length} item(s)`,
    do: async () => { records = await window.api.fsDelete(paths) },
    undo: async () => { await window.api.fsRestore(records) },
  }
}
