# Claude Explorer v2 — Full File-Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn the v1 MVP (browse + open-in-Claude) into a day-to-day file environment: real file operations (rename/copy/cut/paste/delete/new), undo-redo, multiselect, drag-and-drop within and across tabs, back/forward/refresh navigation, rearrangeable tabs, and recent-list curation — so you rarely open Windows Explorer.

**Architecture:** Same shape as v1. Main process owns all OS mutation behind the **frozen IPC contract** (`src/shared/ipc.ts`, extended once in Phase V0 then frozen). Renderer holds pure-logic models (undo stack, selection, navigation history, clipboard/drag state) as independently testable modules, consumed by the UI components. Reversible file operations flow through a single undo stack; deletes stage to a same-drive trash folder for instant, reliable undo and flush to the Recycle Bin on eviction/exit.

**Tech Stack:** Electron + electron-vite + React + TypeScript + Vitest (unchanged). New OS surface: `node:fs/promises` (`cp`, `rename`, `rm`, `mkdir`), Electron `shell` (`openPath`, `showItemInFolder`, `trashItem`).

## Global Constraints (copied verbatim; bind every task)

- Platform: Windows 11. Paths use `\`. Always handle spaces; pass argv arrays, never shell-concatenated strings.
- The IPC contract `src/shared/ipc.ts` is extended ONCE in Phase V0 and then FROZEN. Phase V1/V2/V3 import it and MUST NOT edit it. A task that finds a missing channel STOPS and flags it — it does not add channels in parallel.
- Renderer has no Node access (`contextIsolation: true`, `nodeIntegration: false`). All OS work is in main, reached via `window.api`.
- **Delete = Recycle Bin + confirm.** A `Del` press (or menu Delete) shows a confirm dialog, then stages items to a same-drive trash dir for undo; evicted/at-exit trash flushes to the OS Recycle Bin via `shell.trashItem`. Undo of delete restores from staging.
- **Undo/redo is a full reversible stack** covering rename, move, copy/paste, new folder, new file, AND delete. Ctrl+Z = undo, Ctrl+Y = redo.
- **Move-vs-copy = Windows convention.** Same drive → move; different drive → copy. Ctrl forces copy, Shift forces move. Right-mouse drag drops a Move/Copy/Cancel menu. Cut→paste always moves; Copy→paste always copies.
- **Double-click a file → open in OS default app** (`shell.openPath`). Double-click a folder → navigate into it. The orange row arrow still opens a folder in Claude.
- **Name collisions** resolve File-Explorer-style: the incoming item is auto-renamed via `uniqueName` (`"report.txt"` → `"report (2).txt"`), never silently overwritten.
- **In-flight guard:** an operation registers every involved path in a shared in-flight set; a new op touching a path already in the set is refused (matches Explorer "file is in use" logic). Cleared on completion.
- Non-trivial logic ships ONE runnable Vitest check (plain asserts). Pure modules (pathutil, selection, undo, history) each get a real test. No new deps beyond what's installed.
- Environment already set up. `npm test` runs with the `--experimental-require-module` flag baked into the script (Node 22.11).

---

## Execution: Subagent-Driven (per-task model + mode)

| Task | What | Model | Mode | Test |
|---|---|---|---|---|
| V0 | Extend + freeze IPC contract | **opus** | 🔴 LINEAR (blocks all) | — |
| V1.1 fs-mutate | rename/mkdir/newFile/copy/move | **sonnet** | 🟢 PARALLEL A | manual |
| V1.2 trash | delete→staging, restore, flush | **opus** | 🟢 PARALLEL A | ✅ unit |
| V1.3 open | openPath/showItemInFolder | **haiku** | 🟢 PARALLEL A | — |
| V1.4 recents-remove | removeRecent + handler | **sonnet** | 🟢 PARALLEL A | ✅ unit |
| V1.5 pathutil | sameDrive/uniqueName/basename | **haiku** | 🟢 PARALLEL A | ✅ unit |
| V2.1 history | per-tab back/forward | **sonnet** | 🔵 PARALLEL B | ✅ unit |
| V2.2 undo | Command + UndoStack + factories | **opus** | 🔵 PARALLEL B | ✅ unit |
| V2.3 appstate | clipboard + drag + in-flight context | **sonnet** | 🔵 PARALLEL B | — |
| V2.4 selection | multiselect ctrl/shift ranges | **opus** | 🔵 PARALLEL B | ✅ unit |
| V3.1 TabBar | drag-reorder, close-focus, tab drop target | **opus** | 🟣 PARALLEL C | — |
| V3.2 FileBrowser | nav chrome + ops + selection + dnd + keyboard | **opus** | 🟣 PARALLEL C | — |
| V4 | wire, guard, e2e | **opus** | 🔴 LINEAR | ✅ e2e gate |

**Order:** `V0` → **[V1.1–1.5 ∥ V2.1–2.4]** (9 concurrent: main vs renderer-pure, disjoint files) → **[V3.1 ∥ V3.2]** (2 concurrent; both consume V1+V2, own separate component files) → `V4`.

**Collision rules:** V0 owns `ipc.ts`/`types.ts`. V1 tasks each own their own `*.ts`+`*.handlers.ts`. V2 tasks each own one renderer module. V3.1 owns `TabBar.tsx` + `App.tsx`; V3.2 owns `FileBrowser.tsx` + `NavBar.tsx` + `StatusBar.tsx` + `ContextMenu.tsx`. The **only** shared touch-points between V3.1 and V3.2 are the V2.3 `appstate` context (drag payload + clipboard) and the frozen contract — neither edits the other's files. Final wiring in `main/index.ts` and root provider mount is V4 only.

---

## File Structure (new/changed)

```
src/shared/
  ipc.ts            # V0: +fs mutate/trash/open channels, +recents:remove, Api methods
  pathutil.ts       # V1.5: sameDrive, uniqueName, winBasename, winDirname (pure, shared)
src/main/
  index.ts          # V4: register new handlers, wire trash flush on quit
  fsmutate.ts       # V1.1
  fsmutate.handlers.ts
  trash.ts          # V1.2
  trash.handlers.ts
  open.ts           # V1.3
  open.handlers.ts
  recents.ts        # V1.4: +removeRecent
  recents.handlers.ts # V1.4: +CH.recentsRemove
src/preload/index.ts # V4: extend window.api with the new methods
src/renderer/
  history.ts        # V2.1
  undo.ts           # V2.2
  appstate.tsx      # V2.3: React context (clipboard, dragPayload, inFlight)
  selection.ts      # V2.4
  App.tsx           # V3.1: close-focus, mount AppState provider (provider mount finalized in V4)
  TabBar.tsx        # V3.1: extracted, drag-reorder + drop target
  components/
    FileBrowser.tsx # V3.2: mega-rewrite
    NavBar.tsx      # V3.2: back/fwd/refresh/address
    StatusBar.tsx   # V3.2: item + selection counts
    ContextMenu.tsx # V3.2: supports submenus/separators/disabled
test/
  pathutil.test.ts  # V1.5
  trash.test.ts     # V1.2
  recents.test.ts   # V1.4 (extend existing)
  history.test.ts   # V2.1
  undo.test.ts      # V2.2
  selection.test.ts # V2.4
```

---

## Phase V0 — Extend + freeze the contract (LINEAR, must land first)

### Task V0: IPC contract extension

**Files:** Modify `src/shared/ipc.ts`, `src/shared/types.ts`.

- [ ] **Step 1: Add channels to `CH` in `src/shared/ipc.ts`** (keep existing entries):

```ts
  // --- v2 file operations ---
  fsRename: 'fs:rename',
  fsMkdir: 'fs:mkdir',
  fsNewFile: 'fs:newFile',
  fsCopy: 'fs:copy',       // returns final dest path (after collision resolution)
  fsMove: 'fs:move',       // returns final dest path
  fsDelete: 'fs:delete',   // -> TrashRecord[]
  fsRestore: 'fs:restore', // TrashRecord[] -> void
  fsExists: 'fs:exists',
  openPath: 'shell:openPath',
  revealPath: 'shell:reveal',
  recentsRemove: 'recents:remove',
```

- [ ] **Step 2: Add `TrashRecord` to `src/shared/types.ts`:**

```ts
export interface TrashRecord {
  original: string // absolute path the item was deleted from
  staged: string   // absolute path in the same-drive trash staging dir
  name: string     // basename, for display
}
```

- [ ] **Step 3: Extend the `Api` interface in `src/shared/ipc.ts`** (append to existing methods):

```ts
  fsRename(from: string, to: string): Promise<void>
  fsMkdir(path: string): Promise<string>   // returns the created dir path (collision-resolved)
  fsNewFile(path: string): Promise<string> // returns the created file path (collision-resolved)
  fsCopy(src: string, destDir: string): Promise<string>  // returns final path
  fsMove(src: string, destDir: string): Promise<string>  // returns final path
  fsDelete(paths: string[]): Promise<TrashRecord[]>
  fsRestore(records: TrashRecord[]): Promise<void>
  fsExists(path: string): Promise<boolean>
  openPath(path: string): Promise<void>
  revealPath(path: string): Promise<void>
  recentsRemove(path: string): Promise<void>
```

- [ ] **Step 4: Verify build, commit.** Run `npx tsc --noEmit` (renderer will still typecheck; preload not yet implementing new methods is fine because `Api` is a type only until V4 wires it — if tsc flags the preload placeholder, leave the new methods unimplemented is NOT allowed by the type; so in this step ALSO add stub throwing implementations in `src/preload/index.ts` for the new methods to keep the type satisfied). Add to preload's `api` object:

```ts
  fsRename: (from, to) => ipcRenderer.invoke(CH.fsRename, from, to),
  fsMkdir: (p) => ipcRenderer.invoke(CH.fsMkdir, p),
  fsNewFile: (p) => ipcRenderer.invoke(CH.fsNewFile, p),
  fsCopy: (src, dst) => ipcRenderer.invoke(CH.fsCopy, src, dst),
  fsMove: (src, dst) => ipcRenderer.invoke(CH.fsMove, src, dst),
  fsDelete: (paths) => ipcRenderer.invoke(CH.fsDelete, paths),
  fsRestore: (records) => ipcRenderer.invoke(CH.fsRestore, records),
  fsExists: (p) => ipcRenderer.invoke(CH.fsExists, p),
  openPath: (p) => ipcRenderer.invoke(CH.openPath, p),
  revealPath: (p) => ipcRenderer.invoke(CH.revealPath, p),
  recentsRemove: (p) => ipcRenderer.invoke(CH.recentsRemove, p),
```

Run `npx tsc --noEmit` → clean. Commit: `feat(v2-contract): extend and freeze IPC for file ops`.

---

## Phase V1 — Main process (PARALLEL group A)

### Task V1.5: pathutil (pure, shared) — do first mentally; others may import at runtime only

**Files:** Create `src/shared/pathutil.ts`, `test/pathutil.test.ts`.

**Interfaces produced:** `sameDrive(a,b): boolean`, `uniqueName(existing: string[], name: string): string`, `winBasename(p): string`, `winDirname(p): string`.

- [ ] **Step 1: Failing test `test/pathutil.test.ts`:**

```ts
import { describe, it, expect } from 'vitest'
import { sameDrive, uniqueName, winBasename, winDirname } from '../src/shared/pathutil'

describe('sameDrive', () => {
  it('compares drive letters case-insensitively', () => {
    expect(sameDrive('C:\\a\\b', 'c:\\x\\y')).toBe(true)
    expect(sameDrive('C:\\a', 'D:\\a')).toBe(false)
  })
})
describe('uniqueName', () => {
  it('returns name unchanged when free', () => {
    expect(uniqueName(['a.txt'], 'b.txt')).toBe('b.txt')
  })
  it('suffixes " (2)" before the extension on collision', () => {
    expect(uniqueName(['report.txt'], 'report.txt')).toBe('report (2).txt')
    expect(uniqueName(['report.txt', 'report (2).txt'], 'report.txt')).toBe('report (3).txt')
  })
  it('suffixes folders (no extension)', () => {
    expect(uniqueName(['src'], 'src')).toBe('src (2)')
  })
})
describe('winBasename/winDirname', () => {
  it('splits on backslash', () => {
    expect(winBasename('C:\\a\\b\\c.txt')).toBe('c.txt')
    expect(winDirname('C:\\a\\b\\c.txt')).toBe('C:\\a\\b')
  })
})
```

- [ ] **Step 2: Run → FAIL.** `npx vitest run test/pathutil.test.ts`

- [ ] **Step 3: Implement `src/shared/pathutil.ts`:**

```ts
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
```

- [ ] **Step 4: Run → PASS.** Commit: `feat(v2): shared pathutil (sameDrive/uniqueName)`. **Do not commit — controller serializes commits.** (Report DONE.)

---

### Task V1.1: fs-mutate

**Files:** Create `src/main/fsmutate.ts`, `src/main/fsmutate.handlers.ts`.

**Interfaces:** `rename(from,to)`, `mkdir(path)->string`, `newFile(path)->string`, `copy(src,destDir)->string`, `move(src,destDir)->string`, `registerFsMutateHandlers()`. Collisions resolved with `uniqueName` from `src/shared/pathutil` against the destination directory's current contents. `move` uses `rename`, falling back to copy+remove on `EXDEV` (cross-drive).

- [ ] **Step 1: Implement `src/main/fsmutate.ts`:**

```ts
import { rename as fsRename, mkdir as fsMkdirp, writeFile, cp, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { uniqueName, winBasename } from '../shared/pathutil'

async function dirNames(dir: string): Promise<string[]> {
  try { return await readdir(dir) } catch { return [] }
}

export async function rename(from: string, to: string): Promise<void> {
  await fsRename(from, to)
}

export async function mkdir(path: string): Promise<string> {
  const dir = path.slice(0, path.lastIndexOf('\\'))
  const name = winBasename(path)
  const finalName = uniqueName(await dirNames(dir), name)
  const finalPath = join(dir, finalName)
  await fsMkdirp(finalPath)
  return finalPath
}

export async function newFile(path: string): Promise<string> {
  const dir = path.slice(0, path.lastIndexOf('\\'))
  const finalName = uniqueName(await dirNames(dir), winBasename(path))
  const finalPath = join(dir, finalName)
  await writeFile(finalPath, '', { flag: 'wx' })
  return finalPath
}

export async function copy(src: string, destDir: string): Promise<string> {
  const finalName = uniqueName(await dirNames(destDir), winBasename(src))
  const finalPath = join(destDir, finalName)
  await cp(src, finalPath, { recursive: true, errorOnExist: true, force: false })
  return finalPath
}

export async function move(src: string, destDir: string): Promise<string> {
  const finalName = uniqueName(await dirNames(destDir), winBasename(src))
  const finalPath = join(destDir, finalName)
  try {
    await fsRename(src, finalPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      await cp(src, finalPath, { recursive: true, errorOnExist: true, force: false })
      await rm(src, { recursive: true, force: true })
    } else {
      throw err
    }
  }
  return finalPath
}
```

- [ ] **Step 2: Implement `src/main/fsmutate.handlers.ts`:**

```ts
import { ipcMain } from 'electron'
import { CH } from '../shared/ipc'
import { rename, mkdir, newFile, copy, move } from './fsmutate'

export function registerFsMutateHandlers() {
  ipcMain.handle(CH.fsRename, (_e, from: string, to: string) => rename(from, to))
  ipcMain.handle(CH.fsMkdir, (_e, path: string) => mkdir(path))
  ipcMain.handle(CH.fsNewFile, (_e, path: string) => newFile(path))
  ipcMain.handle(CH.fsCopy, (_e, src: string, destDir: string) => copy(src, destDir))
  ipcMain.handle(CH.fsMove, (_e, src: string, destDir: string) => move(src, destDir))
}
```

- [ ] **Step 3: Manual check + report DONE.** (Verified at V4 e2e. Do not commit.)

---

### Task V1.2: trash (delete → staging, restore, flush)

**Files:** Create `src/main/trash.ts`, `src/main/trash.handlers.ts`, `test/trash.test.ts`.

**Design (satisfies "Recycle Bin + confirm" AND reliable undo):** delete moves each item to a **same-drive** staging dir `<driveRoot>\.claude-explorer-trash\<uuid>\<name>` (an intra-drive rename → instant, reversible). Undo = move staged back to `original` (collision-resolved). Items evicted from the undo history, and all remaining staged items on app quit, are **flushed to the OS Recycle Bin** via `shell.trashItem(staged)`. If same-drive staging fails (permissions at drive root), fall back to `app.getPath('userData')\trash`.

**Interfaces:** `trashItems(paths): Promise<TrashRecord[]>`, `restore(records): Promise<void>`, `flush(records): Promise<void>`, `flushAll(): Promise<void>`, `registerTrashHandlers()`.

- [ ] **Step 1: Failing test `test/trash.test.ts`** (uses a temp dir, exercises the pure staging/restore round-trip via an injected root — the module must expose `stageInto(root, paths)` and `restore` so the test avoids Electron `app`/`shell`):

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stageInto, restore } from '../src/main/trash'

let work: string
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'ce-trash-')) })
afterEach(() => rmSync(work, { recursive: true, force: true }))

describe('stageInto + restore', () => {
  it('moves a file out then restores it to its original path', async () => {
    const src = join(work, 'a.txt')
    writeFileSync(src, 'hello')
    const trashRoot = join(work, '.trash')
    const records = await stageInto(trashRoot, [src])
    expect(existsSync(src)).toBe(false)
    expect(existsSync(records[0].staged)).toBe(true)
    await restore(records)
    expect(existsSync(src)).toBe(true)
  })
  it('restore collision-renames if the original path is re-occupied', async () => {
    const src = join(work, 'a.txt')
    writeFileSync(src, '1')
    const records = await stageInto(join(work, '.trash'), [src])
    writeFileSync(src, '2') // something new took the name
    await restore(records)
    // both survive: original + a " (2)" sibling
    const { readdirSync } = await import('node:fs')
    expect(readdirSync(work).filter((n) => n.startsWith('a')).length).toBe(2)
  })
})
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `src/main/trash.ts`:**

```ts
import { rename, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { TrashRecord } from '../shared/types'
import { uniqueName, winBasename, winDirname } from '../shared/pathutil'

// Test-friendly core: stage into an explicit root (no Electron dependency).
export async function stageInto(trashRoot: string, paths: string[]): Promise<TrashRecord[]> {
  const records: TrashRecord[] = []
  for (const original of paths) {
    const bucket = join(trashRoot, randomUUID())
    await mkdir(bucket, { recursive: true })
    const name = winBasename(original)
    const staged = join(bucket, name)
    await rename(original, staged)
    records.push({ original, staged, name })
  }
  return records
}

export async function restore(records: TrashRecord[]): Promise<void> {
  for (const r of records) {
    const dir = winDirname(r.original)
    let names: string[] = []
    try { names = await readdir(dir) } catch { /* dir may be gone */ }
    const finalName = uniqueName(names, r.name)
    await rename(r.staged, join(dir, finalName))
  }
}
```

Then the Electron-facing wrappers (not unit-tested; verified at e2e):

```ts
import { app, shell } from 'electron'
function driveRoot(p: string): string { return p.slice(0, 2) + '\\' } // "C:\"
function trashRootFor(p: string): string {
  try { return join(driveRoot(p), '.claude-explorer-trash') }
  catch { return join(app.getPath('userData'), 'trash') }
}

// Module registry of still-staged records so main can flush on quit without an
// extra IPC round-trip. Appended on delete, removed on restore.
const live: TrashRecord[] = []

export async function trashItems(paths: string[]): Promise<TrashRecord[]> {
  const out: TrashRecord[] = []
  for (const p of paths) out.push(...await stageInto(trashRootFor(p), [p]))
  live.push(...out)
  return out
}
export async function flush(records: TrashRecord[]): Promise<void> {
  for (const r of records) {
    try { await shell.trashItem(r.staged) } catch { /* best effort */ }
    const i = live.indexOf(r); if (i >= 0) live.splice(i, 1)
  }
}
export async function flushAll(): Promise<void> { await flush([...live]) }
```

Also wrap the exported `restore` so restored items leave the registry: after the test-friendly `restore` succeeds for a record, remove it from `live` (the handler calls a thin wrapper `restoreAndUntrack(records)` that calls `restore` then splices `live`). Keep the pure `restore` signature unchanged for the test.

- [ ] **Step 4: Implement `src/main/trash.handlers.ts`:**

```ts
import { ipcMain } from 'electron'
import { CH } from '../shared/ipc'
import { trashItems, restore } from './trash'

export function registerTrashHandlers() {
  ipcMain.handle(CH.fsDelete, (_e, paths: string[]) => trashItems(paths))
  ipcMain.handle(CH.fsRestore, (_e, records) => restore(records))
}
```

- [ ] **Step 5: Run test → PASS.** Report DONE (V4 wires `flush` on quit).

---

### Task V1.3: open (shell)

**Files:** Create `src/main/open.ts`, `src/main/open.handlers.ts`.

- [ ] **Step 1: `src/main/open.ts`:**

```ts
import { shell } from 'electron'
export async function openPath(path: string): Promise<void> {
  const err = await shell.openPath(path) // '' on success
  if (err) throw new Error(err)
}
export function revealPath(path: string): void {
  shell.showItemInFolder(path)
}
```

- [ ] **Step 2: `src/main/open.handlers.ts`:**

```ts
import { ipcMain } from 'electron'
import { CH } from '../shared/ipc'
import { openPath, revealPath } from './open'
export function registerOpenHandlers() {
  ipcMain.handle(CH.openPath, (_e, p: string) => openPath(p))
  ipcMain.handle(CH.revealPath, (_e, p: string) => { revealPath(p) })
}
```

- [ ] **Step 3: Report DONE.**

---

### Task V1.4: recents removal

**Files:** Modify `src/main/recents.ts`, `src/main/recents.handlers.ts`, `test/recents.test.ts`.

**Interfaces:** add `computeRemoved(prev, path): RecentFolder[]` (pure), `removeRecent(path)`, and register `CH.recentsRemove`.

- [ ] **Step 1: Add failing test to `test/recents.test.ts`:**

```ts
import { computeRemoved } from '../src/main/recents'
describe('computeRemoved', () => {
  it('drops the matching path, keeps order', () => {
    const list = [
      { path: 'C:\\a', name: 'a', lastOpened: 3 },
      { path: 'C:\\b', name: 'b', lastOpened: 2 },
    ]
    expect(computeRemoved(list, 'C:\\a').map((r) => r.path)).toEqual(['C:\\b'])
  })
})
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Add to `src/main/recents.ts`:**

```ts
export function computeRemoved(prev: RecentFolder[], path: string): RecentFolder[] {
  return prev.filter((r) => r.path !== path)
}
export function removeRecent(path: string): void {
  writeFileSync(file(), JSON.stringify(computeRemoved(listRecents(), path), null, 2))
}
```

- [ ] **Step 4: Add to `src/main/recents.handlers.ts`:**

```ts
import { removeRecent } from './recents'
// inside registerRecentsHandlers():
ipcMain.handle(CH.recentsRemove, (_e, path: string) => removeRecent(path))
```

- [ ] **Step 5: Run → PASS. Report DONE.**

---

## Phase V2 — Renderer pure models (PARALLEL group B)

### Task V2.1: navigation history

**Files:** Create `src/renderer/history.ts`, `test/history.test.ts`.

**Interfaces:** `History = { back: string[]; current: string; forward: string[] }`, `initHistory(path)`, `navigate(h, path)`, `goBack(h)`, `goForward(h)`, `canBack(h)`, `canForward(h)`.

- [ ] **Step 1: Failing test `test/history.test.ts`:**

```ts
import { describe, it, expect } from 'vitest'
import { initHistory, navigate, goBack, goForward, canBack, canForward } from '../src/renderer/history'

describe('history', () => {
  it('navigate pushes current to back and clears forward', () => {
    let h = initHistory('C:\\a')
    h = navigate(h, 'C:\\a\\b')
    h = navigate(h, 'C:\\a\\b\\c')
    expect(h.current).toBe('C:\\a\\b\\c')
    expect(h.back).toEqual(['C:\\a', 'C:\\a\\b'])
    h = goBack(h)
    expect(h.current).toBe('C:\\a\\b')
    expect(canForward(h)).toBe(true)
    h = navigate(h, 'C:\\z') // navigating after back clears forward
    expect(canForward(h)).toBe(false)
  })
  it('goBack/goForward are no-ops at the ends', () => {
    let h = initHistory('C:\\a')
    expect(canBack(h)).toBe(false)
    expect(goBack(h)).toEqual(h)
    expect(goForward(h)).toEqual(h)
  })
})
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `src/renderer/history.ts`:**

```ts
export interface History { back: string[]; current: string; forward: string[] }
export const initHistory = (path: string): History => ({ back: [], current: path, forward: [] })
export const canBack = (h: History) => h.back.length > 0
export const canForward = (h: History) => h.forward.length > 0
export function navigate(h: History, path: string): History {
  if (path === h.current) return h
  return { back: [...h.back, h.current], current: path, forward: [] }
}
export function goBack(h: History): History {
  if (!canBack(h)) return h
  const prev = h.back[h.back.length - 1]
  return { back: h.back.slice(0, -1), current: prev, forward: [h.current, ...h.forward] }
}
export function goForward(h: History): History {
  if (!canForward(h)) return h
  const next = h.forward[0]
  return { back: [...h.back, h.current], current: next, forward: h.forward.slice(1) }
}
```

- [ ] **Step 4: Run → PASS. Report DONE.**

---

### Task V2.2: undo/redo stack + command factories

**Files:** Create `src/renderer/undo.ts`, `test/undo.test.ts`.

**Interfaces:** `Command = { label: string; do(): Promise<void>; undo(): Promise<void> }`; `UndoStack` with `run(c)`, `undo()`, `redo()`, `canUndo()`, `canRedo()`, and an `onEvict?(c)` callback (used by V4 to flush trashed deletes to the Recycle Bin when they fall off the history). Plus async command factories that wrap `window.api` ops and capture their inverse:
- `renameCmd(from, to)`
- `mkdirCmd(parentDir, name)` / `newFileCmd(parentDir, name)`
- `copyCmd(src, destDir)` / `moveCmd(src, destDir)`
- `deleteCmd(paths)`

Each factory returns a `Command` whose `do()` performs the op (capturing the resolved dest/records into closure state so `undo()` can reverse the *actual* result).

- [ ] **Step 1: Failing test `test/undo.test.ts`** (pure stack behavior with fake commands — factories are integration-verified at e2e):

```ts
import { describe, it, expect } from 'vitest'
import { UndoStack, type Command } from '../src/renderer/undo'

function counter(log: string[], name: string): Command {
  return {
    label: name,
    do: async () => { log.push(`do:${name}`) },
    undo: async () => { log.push(`undo:${name}`) },
  }
}

describe('UndoStack', () => {
  it('run/undo/redo drive do and undo in order', async () => {
    const log: string[] = []
    const s = new UndoStack()
    await s.run(counter(log, 'A'))
    await s.run(counter(log, 'B'))
    expect(s.canUndo()).toBe(true)
    await s.undo()            // undo B
    await s.undo()            // undo A
    expect(s.canUndo()).toBe(false)
    await s.redo()            // redo A
    expect(log).toEqual(['do:A', 'do:B', 'undo:B', 'undo:A', 'do:A'])
  })
  it('a new run clears the redo future', async () => {
    const log: string[] = []
    const s = new UndoStack()
    await s.run(counter(log, 'A'))
    await s.undo()
    await s.run(counter(log, 'B'))
    expect(s.canRedo()).toBe(false)
  })
  it('evicts + notifies past a capacity limit', async () => {
    const evicted: string[] = []
    const s = new UndoStack(2, (c) => evicted.push(c.label))
    const log: string[] = []
    await s.run(counter(log, 'A'))
    await s.run(counter(log, 'B'))
    await s.run(counter(log, 'C')) // A falls off
    expect(evicted).toEqual(['A'])
  })
})
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `src/renderer/undo.ts`:**

```ts
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
```

- [ ] **Step 4: Run → PASS. Report DONE.**

---

### Task V2.3: app state context (clipboard, drag payload, in-flight guard)

**Files:** Create `src/renderer/appstate.tsx`.

**Interfaces:** a React context exposing:
```ts
interface Clipboard { mode: 'cut' | 'copy'; paths: string[] } | null
interface DragPayload { paths: string[]; sourceTabId: string } | null
interface AppState {
  clipboard: Clipboard; setClipboard(c: Clipboard): void
  drag: DragPayload; setDrag(d: DragPayload): void
  isBusy(path: string): boolean
  withGuard<T>(paths: string[], fn: () => Promise<T>): Promise<T>  // refuses if any path busy; else marks busy, runs, clears
  undo: UndoStack
}
```
`withGuard` implements the in-flight rule: if any path is already busy → throw `new Error('busy')`; otherwise add all paths to a `Set`, run `fn`, and clear them in `finally`. The single shared `UndoStack` (capacity 100) is created here with `onEvict` wired in V4 to flush trashed deletes.

- [ ] **Step 1: Implement `src/renderer/appstate.tsx`** with `createContext`, an `AppStateProvider` holding the above as `useState` + a `useRef<Set<string>>` for busy paths and a `useRef<UndoStack>`, and a `useAppState()` hook. (No unit test — exercised via components at e2e.)

- [ ] **Step 2: Report DONE.**

---

### Task V2.4: selection model (multiselect)

**Files:** Create `src/renderer/selection.ts`, `test/selection.test.ts`.

**Interfaces:** `Selection = { anchor: number | null; indices: Set<number> }`, `emptySelection()`, `applyClick(sel, index, mods: { ctrl: boolean; shift: boolean }): Selection`. Rules (Windows Explorer): plain click → single select + anchor; Ctrl+click → toggle that index, move anchor; Shift+click → replace with contiguous range anchor→index (anchor 0 if null); Ctrl+Shift+click → add the range anchor→index to the existing set.

- [ ] **Step 1: Failing test `test/selection.test.ts`:**

```ts
import { describe, it, expect } from 'vitest'
import { emptySelection, applyClick } from '../src/renderer/selection'
const arr = (s: { indices: Set<number> }) => [...s.indices].sort((a, b) => a - b)

describe('selection', () => {
  it('plain click selects one', () => {
    const s = applyClick(emptySelection(), 3, { ctrl: false, shift: false })
    expect(arr(s)).toEqual([3]); expect(s.anchor).toBe(3)
  })
  it('ctrl toggles', () => {
    let s = applyClick(emptySelection(), 1, { ctrl: false, shift: false })
    s = applyClick(s, 4, { ctrl: true, shift: false })
    expect(arr(s)).toEqual([1, 4])
    s = applyClick(s, 4, { ctrl: true, shift: false })
    expect(arr(s)).toEqual([1])
  })
  it('shift selects contiguous range from anchor', () => {
    let s = applyClick(emptySelection(), 2, { ctrl: false, shift: false })
    s = applyClick(s, 5, { ctrl: false, shift: true })
    expect(arr(s)).toEqual([2, 3, 4, 5])
  })
  it('ctrl+shift adds a range to the existing set', () => {
    let s = applyClick(emptySelection(), 0, { ctrl: false, shift: false })
    s = applyClick(s, 8, { ctrl: true, shift: false })
    s = applyClick(s, 10, { ctrl: true, shift: true })
    expect(arr(s)).toEqual([0, 8, 9, 10])
  })
})
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `src/renderer/selection.ts`:**

```ts
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
```

- [ ] **Step 4: Run → PASS. Report DONE.**

---

## Phase V3 — Renderer UI (PARALLEL group C, after V1 + V2)

### Task V3.1: TabBar — drag-reorder, close-focus, tab drop target

**Files:** Create `src/renderer/TabBar.tsx`; modify `src/renderer/App.tsx` (extract the tab strip into `<TabBar/>`, add reorder + close-focus). Consumes `useAppState()` (V2.3) for the drag payload.

**Behavioral spec (implementer authors the component to satisfy every checkbox):**

- [ ] **Close-focuses-most-recent:** track a per-tab `lastActivated: number` timestamp (bump on select). `closeTab(id)` removes the tab and, if it was active, sets active to the remaining tab with the highest `lastActivated`. **Never leave `active` pointing at nothing while ≥1 tab remains** (the blank-screen bug). Add a Vitest-free assertion in code review: closing the active tab among N>1 always yields a valid active id.
- [ ] **Drag-reorder:** each tab is `draggable`. On `dragstart` set a `reorderIndex`; on `dragover` a sibling tab, compute insert position and show an insertion marker; on `drop`, splice the tab array to the new order. Use HTML5 DnD with `dataTransfer.setData('application/x-ce-tab', id)`. Keep it simple (no animation library) — a 2px clay insertion bar via CSS is enough.
- [ ] **Tab as file drop target:** when `useAppState().drag` is non-null (a file drag started in a FileBrowser, see V3.2) and the pointer `dragenter`s a tab, switch the active tab to it after a 600ms hover (spring-loaded folders behavior) so the user can then drop into a folder in that tab. Dropping directly on the tab bar (not a folder) is a no-op (the actual move/copy happens on a folder row in V3.2).
- [ ] **Styling:** reuse the existing `.tab`/`.tab.active` classes; add `.tab.drag-over` (clay left-border insertion marker) and `.tab.spring-target` (subtle clay glow) in `index.css`.
- [ ] Report DONE.

---

### Task V3.2: FileBrowser — navigation chrome, file ops, selection, drag-drop, keyboard

**Files:** Modify `src/renderer/components/FileBrowser.tsx`; create `src/renderer/components/NavBar.tsx`, `src/renderer/components/StatusBar.tsx`; extend `src/renderer/components/ContextMenu.tsx` (support `separator` items and `disabled` items and an optional right-drag Move/Copy menu reuse). Consumes V2 modules (`selection`, `history`, `undo` factories, `appstate`) and the v2 `window.api`.

FileBrowser receives per-tab navigation state lifted to App (V4 will own the wiring); for this task, drive `history` internally via `useState` seeded from `cwd`, and call the existing `onNavigate` when the effective directory changes so App/tabs stay in sync.

**Behavioral spec — implementer authors the component to satisfy every checkbox:**

- [ ] **NavBar (left of the path):** render, in order, **◀ Back**, **▶ Forward**, **⟳ Refresh**, then the editable address/breadcrumb. Back/Forward use `history.ts` (`goBack`/`goForward`, disabled via `canBack`/`canForward`). Refresh re-runs `window.api.fsList(cwd)`. Keyboard: `Alt+Left`=back, `Alt+Right`=forward, `Backspace`=up one dir (when not renaming), `F5`=refresh. Address area: clicking it turns the breadcrumb into a text input pre-filled with the path; Enter navigates (validate via `window.api.fsExists`), Esc cancels.
- [ ] **Selection:** replace single `sel` with `selection.ts` state over the ordered `entries`. Row `onClick` calls `applyClick` with `{ ctrl: e.ctrlKey, shift: e.shiftKey }`. Selected rows use `.entry.selected`. `Ctrl+A` selects all; `Esc` clears.
- [ ] **Double-click:** folder → navigate; file → `window.api.openPath(entry.path)`.
- [ ] **Context menu (right-click):** build items dynamically from the current selection:
  `Open` (file→openPath / folder→navigate), `Open in Claude` (folder), `Open in external terminal` (folder), `separator`, `Cut`, `Copy`, `Paste` (disabled unless clipboard non-empty and target is a folder/cwd), `separator`, `Rename` (single selection only), `Delete`, `separator`, `New Folder`, `New File`, `separator`, `Reveal in File Explorer` (`revealPath`). Right-clicking empty space → the cwd-scoped subset (Paste / New Folder / New File / Reveal).
- [ ] **Clipboard ops (via `useAppState`):** `Cut`/`Ctrl+X` set `clipboard={mode:'cut',paths:selected}`; `Copy`/`Ctrl+C` set `mode:'copy'`. `Paste`/`Ctrl+V` into the target dir: for each path run the appropriate undo command — `copy` → `copyCmd`; `cut` → `moveCmd` — each wrapped in `appstate.withGuard([...involved])`; after a successful cut-paste, clear the clipboard. Collisions auto-resolve via the main-process `uniqueName` (already built in).
- [ ] **Rename:** `F2` or menu Rename on a single selection turns the row label into an inline `<input>` seeded with the name (extension pre-selected off for files). Enter commits via `undo.run(renameCmd(old, join(dir,newName)))` (guarded); Esc cancels; empty/unchanged name cancels.
- [ ] **Delete:** `Del` or menu Delete → confirm dialog (a simple in-app modal: "Delete N item(s)? They can be restored with Ctrl+Z or from the Recycle Bin." [Delete] [Cancel]). On confirm → `undo.run(deleteCmd(selectedPaths))` (guarded). Selection clears; list refreshes.
- [ ] **New Folder / New File:** menu or `Ctrl+Shift+N` (folder) → `undo.run(mkdirCmd(cwd,'New folder'))` / new file → `newFileCmd(cwd,'New file')`, then immediately enter inline-rename on the created item.
- [ ] **Undo/redo:** `Ctrl+Z` → `undo.undo()`, `Ctrl+Y` → `undo.redo()`, then refresh the list. These are global (V4 mounts the single stack); FileBrowser calls the shared stack from `useAppState`.
- [ ] **Drag-and-drop (within + cross-tab source):** rows are `draggable`; on `dragstart`, if the dragged row isn't in the current selection, select it first, then set `appstate.setDrag({paths:selectedPaths, sourceTabId})` and `dataTransfer.setData('application/x-ce-files', JSON.stringify(paths))`. A **folder row** is a drop target: on `dragover` add `.entry.drop-target`; on `drop`, resolve **move vs copy** by the Global-Constraints rule — `copy` if `e.ctrlKey` OR `!sameDrive(src, destFolder)`, `move` if `e.shiftKey` OR same drive; right-mouse drag opens the Move/Copy/Cancel menu at drop. Run one undo command per path (`moveCmd`/`copyCmd`) inside `withGuard`. **Refuse** (and toast) if any involved path `isBusy`. Cross-tab: because the drag payload lives in `appstate`, dropping onto a folder row in a *different* tab (after the V3.1 spring-load switches to it) uses the same handler — source paths come from `appstate.drag`.
- [ ] **StatusBar (bottom):** show `<n> items` and, when a selection exists, `<k> selected`. Thin bar using `--bg-sunken`/`--ink-soft`, mono.
- [ ] **CSS additions** (`index.css`): `.navbar` (flex row of icon buttons + address), `.nav-btn`/`.nav-btn:disabled`, `.address-input`, `.entry.drop-target` (inset clay ring), `.statusbar`, `.modal-backdrop`/`.modal` for the delete confirm, `.rename-input`. Match the Retro Claude tokens.
- [ ] Report DONE.

---

## Phase V4 — Integration (LINEAR)

### Task V4: Wire handlers, mount providers, guard, e2e

**Files:** Modify `src/main/index.ts`, `src/renderer/App.tsx` (mount `AppStateProvider` at root + lift per-tab nav state if needed), `src/renderer/index.css` (fold in any missing classes).

- [ ] **Step 1: Register new main handlers** in `whenReady` (alongside v1 ones):
```ts
registerFsMutateHandlers(); registerTrashHandlers(); registerOpenHandlers();
```
(and confirm `registerRecentsHandlers` now also binds `CH.recentsRemove`).

- [ ] **Step 2: Flush trash on quit.** In `app.on('will-quit', e => { e.preventDefault(); flushAll().finally(() => app.exit()) })` flush remaining staged items to the Recycle Bin using the `live` registry built in V1.2 (no renderer round-trip needed). Eviction-time flush is optional: since `flushAll` runs on quit, an evicted delete command simply keeps its staged files until then — acceptable, so `UndoStack.onEvict` may be left unwired in v2 (the capacity is 100; staged files persist harmlessly until quit).

- [ ] **Step 3: Mount `AppStateProvider`** wrapping the app in `App.tsx`; construct the single `UndoStack` there with `onEvict` wired to flush trashed deletes via a new tiny IPC call or by having `deleteCmd` records flushed through `window.api` (add a `flush` channel ONLY if needed — if so, that's a contract change requiring a flagged amendment; prefer flushing on quit to avoid it).

- [ ] **Step 4: Full build + test.** `npx tsc --noEmit` clean; `npm test` all green; `npx electron-vite build` passes.

- [ ] **Step 5: E2E gate (real hardware, manual).** Verify: (a) back/forward/refresh + Alt-arrows/Backspace/F5; (b) editable address bar; (c) multiselect ctrl/shift; (d) rename (F2), new folder/file (auto-inline-rename), delete (confirm→Recycle Bin), undo restores, redo re-deletes; (e) cut/copy/paste within a folder and **between two file tabs**; (f) drag files onto a subfolder (move same-drive, copy cross-drive, Ctrl/Shift override, right-drag menu); (g) drag a file onto another tab → spring-loads → drop into a folder there; (h) close a tab → focus jumps to most-recent, never blank; (i) drag-reorder tabs; (j) delete a recent entry from Open Recent; (k) double-click a file opens its default app; (l) busy-guard: starting a second op on an in-progress item is refused.

- [ ] **Step 6: Commit.** `feat(v2): full file-manager environment`.

---

## Deferred to a later version (explicitly out of v2 scope)

Sorting (name/date/size) and column headers; show/hidden-files toggle; file search within a folder; size column / folder-size computation; tree/side panel; thumbnails/preview pane; multi-window; per-tab "duplicate tab". Each is additive and can be its own plan. **YAGNI for now** — flag to the user before pulling any in.

## Self-Review Notes

- **Coverage vs request:** close-focus (V3.1), tab reorder (V3.1), back/forward left of path + refresh (V3.2 NavBar), rename/copy/cut/paste/delete as menu+shortcuts+Del (V3.2), Ctrl+Z/Y (V2.2+V3.2), new folder+rename (V3.2), delete recent from Open Recent (V1.4+RecentMenu wiring in V4/V3), cross-tab cut/paste + drag (V2.3 payload + V3.1 spring-load + V3.2 handlers), multiselect drag (V2.4+V3.2), refresh button (V3.2), in-flight guard (V2.3 `withGuard`). All mapped.
- **Contract discipline:** every new OS capability has a channel defined once in V0. UI tasks never touch `ipc.ts`.
- **Undo correctness:** factories capture the *actual* resolved dest/records in `do()` closures so `undo()` reverses reality, not the requested (pre-collision) path.
- **Delete/undo/Recycle-Bin reconciliation:** same-drive staging gives instant reversible undo; Recycle Bin is the durable destination on eviction/quit — both user requirements honored, documented in Global Constraints + V1.2 + V4.
- **RecentMenu delete wiring:** V1.4 provides `recentsRemove`; the small RecentMenu edit (an × on each recent row calling `window.api.recentsRemove` then refreshing) is folded into V4 Step 3 (it's a 3-line change to an existing component, not worth a parallel task).
```
