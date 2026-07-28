# M1 — File Safety & Explorer/Developer Modes: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Claude Explorer safe enough to trust as a primary file manager — a default user cannot destroy system state through the app, and a developer can opt into hidden files and risky operations without leaving it.

**Architecture:** A single policy chokepoint in the main process. `src/main/policy.ts` is a pure, Electron-free module that every mutating IPC handler consults before touching disk. The trust boundary is IPC, not the UI: `src/preload/index.ts` exposes `fsDelete`/`fsMove` directly to renderer JavaScript, so a guard living in `FileBrowser.tsx` would be bypassed by any call site that forgets it. The renderer renders verdicts; it never makes them.

**Tech Stack:** Electron 41 + electron-vite · React 19 + TypeScript 7 · Vitest 4 · node-pty · @xterm/xterm

Spec: `docs/superpowers/specs/2026-07-28-safety-and-modes-design.md`
JIRA: epic **KAN-1**, tickets **KAN-5**…**KAN-13**

## Global Constraints

- **Never push directly to `main`.** Feature branch → PR (`gh pr create`) → Dan merges manually. Do not merge without his explicit approval.
- Work branch for all M1 tasks: `feat/m1-safety-and-modes` (already created; spec committed at `6b70975`).
- **No new runtime dependencies.** Stdlib + Electron `shell` + already-installed packages only.
- Windows semantics everywhere: backslash paths, drive letters, UNC, `\\?\` long paths.
- Retro Claude design system: reuse the CSS custom properties already in `src/renderer/index.css` (`--clay` et al). **Never introduce a second palette.**
- `npm test` sets `NODE_OPTIONS=--experimental-require-module` — always run tests via `npm test`, never bare `vitest`.
- Type-check with `npx tsc --noEmit` across the whole tree.
- Mark deliberate corner-cuts with a `ponytail:` comment naming the ceiling and the upgrade path.
- The typed-confirmation word is the literal string `CONFIRM`, uniformly, for every operation.
- Tests live in `test/*.test.ts`.

## Spec amendment (supersedes the spec document)

Spec §6 says "`fsList` keeps its signature." That contradicts defect **D4**, which requires listing errors to be surfaced rather than thrown. **This plan is authoritative:** `fsList` returns a `ListResult` union. Task 1 defines it; Task 9 amends the spec text to match.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/shared/types.ts` | modify | `FileMode`, `OpResult<T>`, `ListResult`, extended `DirEntry`/`Settings` |
| `src/shared/ipc.ts` | modify | Frozen contract: `CH` constants + `Api` signatures |
| `src/preload/index.ts` | modify | Bridge bindings for changed signatures |
| `src/main/policy.ts` | **create** | The safety kernel. Pure, no Electron imports |
| `src/shared/pathutil.ts` | modify | `driveKey()`; fix `sameDrive` (D5) |
| `src/main/trash.ts` | modify | UNC/long-path trash root (D2); EXDEV-safe staging |
| `src/main/fs.ts` | modify | Junction classification (D1), hidden flags, typed errors (D4) |
| `src/main/fsmutate.ts` | modify | Reuse `winDirname` (D3) |
| `src/main/fsmutate.handlers.ts` | modify | Route through `policy.gate()` |
| `src/main/trash.handlers.ts` | modify | Route through `policy.gate()`; permanent delete |
| `src/main/settings.ts` | modify | `mode` default |
| `src/main/menu.ts` | modify | Mode toggle menu entry |
| `src/renderer/components/StatusBar.tsx` | modify | Mode indicator + toggle |
| `src/renderer/components/ConfirmDialog.tsx` | **create** | Simple + typed confirmation |
| `src/renderer/opresult.ts` | **create** | `unwrap()` — one place that handles `OpResult` |
| `src/renderer/components/FileBrowser.tsx` | modify | Consume flags, filter hidden, wire confirmations |

---

### Task 1: Freeze the IPC contract (KAN-5)

**This task lands alone. No other task may start until it is committed** — `CLAUDE.md` forbids two workers editing `ipc.ts`.

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/ipc.ts:36` (Api interface)
- Modify: `src/preload/index.ts:27-32`

**Interfaces:**
- Produces: `FileMode`, `OpResult<T>`, `ListResult`, `DirEntry.hidden`, `DirEntry.isSymlink`, `Settings.mode`. Every later task consumes these.

- [ ] **Step 1: Add the new types**

In `src/shared/types.ts`, extend `DirEntry` and `Settings`, and add the unions:

```ts
export interface DirEntry {
  name: string
  path: string // absolute
  isDirectory: boolean
  hidden: boolean // dotfile or known Windows noise
  isSymlink: boolean // junction / symlink / reparse point
}

export type FileMode = 'explorer' | 'developer'

export interface Settings {
  ideCommand: string // e.g. "code"; launched as `<ideCommand> <folder>`
  mode: FileMode // 'explorer' (default) hides risk; 'developer' unlocks it
}

/** Result of a policy-gated mutating operation. A union, not a thrown Error:
 *  ipcMain.handle serialises thrown Errors into a string-prefixed message, so
 *  structured data (which code? typed confirm?) does not survive a throw. */
export type OpResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'DENIED'; reason: string }
  | { ok: false; code: 'NEEDS_CONFIRM'; reason: string; typed: boolean }
  | { ok: false; code: 'ERROR'; reason: string }

/** Directory listing: a folder that cannot be read reports why instead of throwing. */
export type ListResult =
  | { ok: true; entries: DirEntry[] }
  | { ok: false; reason: string }
```

- [ ] **Step 2: Update the Api interface**

In `src/shared/ipc.ts`, import `FileMode`, `OpResult`, `ListResult` alongside the existing type imports, then change these signatures (leave every other method untouched):

```ts
  fsList(path: string): Promise<ListResult>
  fsRename(from: string, to: string, confirm?: string): Promise<OpResult<void>>
  fsMkdir(path: string, confirm?: string): Promise<OpResult<string>>
  fsNewFile(path: string, confirm?: string): Promise<OpResult<string>>
  fsCopy(src: string, destDir: string, confirm?: string): Promise<OpResult<string>>
  fsMove(src: string, destDir: string, confirm?: string): Promise<OpResult<string>>
  fsDelete(paths: string[], opts?: { permanent?: boolean; confirm?: string }): Promise<OpResult<TrashRecord[]>>
```

No new `CH` constants are needed — permanent delete rides on `CH.fsDelete` via `opts.permanent`.

- [ ] **Step 3: Update the preload bindings**

In `src/preload/index.ts`, replace lines 27-32 so the new arguments actually cross the bridge. **A missing argument here fails silently at runtime** — the handler sees `undefined` and every confirmation is rejected:

```ts
  fsRename: (from, to, confirm) => ipcRenderer.invoke(CH.fsRename, from, to, confirm),
  fsMkdir: (p, confirm) => ipcRenderer.invoke(CH.fsMkdir, p, confirm),
  fsNewFile: (p, confirm) => ipcRenderer.invoke(CH.fsNewFile, p, confirm),
  fsCopy: (src, dst, confirm) => ipcRenderer.invoke(CH.fsCopy, src, dst, confirm),
  fsMove: (src, dst, confirm) => ipcRenderer.invoke(CH.fsMove, src, dst, confirm),
  fsDelete: (paths, opts) => ipcRenderer.invoke(CH.fsDelete, paths, opts),
```

- [ ] **Step 4: Verify the contract compiles**

Run: `npx tsc --noEmit`
Expected: errors **only** in consumer files that have not been migrated yet (`fs.ts`, `fsmutate.handlers.ts`, `trash.handlers.ts`, `settings.ts`, `FileBrowser.tsx`). Zero errors inside `types.ts`, `ipc.ts`, `preload/index.ts`. Those consumer errors are the work of Tasks 3–7 and are expected here.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/shared/ipc.ts src/preload/index.ts
git commit -m "feat(ipc): freeze M1 contract — OpResult, ListResult, DirEntry flags, Settings.mode (KAN-5)"
```

---

### Task 2: The policy kernel (KAN-6)

**Files:**
- Create: `src/main/policy.ts`
- Test: `test/policy.test.ts`

**Interfaces:**
- Consumes: `FileMode` from Task 1.
- Produces: `Op`, `PathClass`, `Verdict`, `CONFIRM_WORD`, `DEFAULT_SYSTEM_ROOTS`, `classify()`, `check()`, `gate()`. Task 5 calls `gate()`.

- [ ] **Step 1: Write the failing tests**

Create `test/policy.test.ts`. Note the `roots` injection — this is what lets the whole matrix run against temp paths instead of a real `C:\Windows`:

```ts
import { describe, it, expect } from 'vitest'
import { classify, check, gate, CONFIRM_WORD } from '../src/main/policy'

const ROOTS = ['C:\\FakeWindows', 'C:\\Fake Program Files']

describe('classify', () => {
  it('flags a system root and any descendant', () => {
    expect(classify('C:\\FakeWindows', ROOTS)).toBe('system')
    expect(classify('C:\\FakeWindows\\System32\\drivers', ROOTS)).toBe('system')
  })
  it('is case- and separator-insensitive', () => {
    expect(classify('c:/fakewindows/system32', ROOTS)).toBe('system')
    expect(classify('C:\\FakeWindows\\', ROOTS)).toBe('system')
  })
  it('does not flag a sibling with a shared prefix', () => {
    expect(classify('C:\\FakeWindowsBackup', ROOTS)).toBe('normal')
  })
  it('flags drive roots', () => {
    expect(classify('C:\\', ROOTS)).toBe('driveRoot')
    expect(classify('D:\\', ROOTS)).toBe('driveRoot')
  })
  it('flags the app trash dir at any depth', () => {
    expect(classify('C:\\.claude-explorer-trash', ROOTS)).toBe('trash')
    expect(classify('C:\\.claude-explorer-trash\\abc\\f.txt', ROOTS)).toBe('trash')
  })
  it('treats ordinary paths as normal', () => {
    expect(classify('C:\\Users\\dan\\proj', ROOTS)).toBe('normal')
  })
})

describe('check', () => {
  it('allows normal deletes in both modes with no confirmation', () => {
    expect(check('delete', ['C:\\Users\\dan\\a'], 'explorer', ROOTS).kind).toBe('allow')
    expect(check('delete', ['C:\\Users\\dan\\a'], 'developer', ROOTS).kind).toBe('allow')
  })
  it('denies system paths in explorer mode and names the way forward', () => {
    const v = check('delete', ['C:\\FakeWindows\\x'], 'explorer', ROOTS)
    expect(v.kind).toBe('deny')
    if (v.kind === 'deny') expect(v.reason).toMatch(/Developer mode/i)
  })
  it('requires typed confirmation for system paths in developer mode', () => {
    const v = check('delete', ['C:\\FakeWindows\\x'], 'developer', ROOTS)
    expect(v.kind).toBe('confirm')
    if (v.kind === 'confirm') expect(v.typed).toBe(true)
  })
  it('denies the trash dir in BOTH modes', () => {
    for (const m of ['explorer', 'developer'] as const) {
      expect(check('delete', ['C:\\.claude-explorer-trash\\x'], m, ROOTS).kind).toBe('deny')
    }
  })
  it('denies permanent delete outright in explorer mode', () => {
    expect(check('permanentDelete', ['C:\\Users\\dan\\a'], 'explorer', ROOTS).kind).toBe('deny')
  })
  it('requires typed confirmation for permanent delete in developer mode', () => {
    const v = check('permanentDelete', ['C:\\Users\\dan\\a'], 'developer', ROOTS)
    expect(v.kind).toBe('confirm')
    if (v.kind === 'confirm') expect(v.typed).toBe(true)
  })
  it('blocks if ANY path in a multi-select is protected', () => {
    const v = check('delete', ['C:\\Users\\dan\\ok', 'C:\\FakeWindows\\bad'], 'explorer', ROOTS)
    expect(v.kind).toBe('deny')
  })
})

describe('gate', () => {
  it('returns null when allowed', () => {
    expect(gate('delete', ['C:\\Users\\dan\\a'], 'explorer', undefined, ROOTS)).toBeNull()
  })
  it('returns the verdict when denied, even with a confirm value', () => {
    expect(gate('delete', ['C:\\FakeWindows\\x'], 'explorer', CONFIRM_WORD, ROOTS)).not.toBeNull()
  })
  it('rejects a wrong or missing typed confirmation', () => {
    expect(gate('delete', ['C:\\FakeWindows\\x'], 'developer', undefined, ROOTS)).not.toBeNull()
    expect(gate('delete', ['C:\\FakeWindows\\x'], 'developer', 'yes', ROOTS)).not.toBeNull()
    expect(gate('delete', ['C:\\FakeWindows\\x'], 'developer', 'confirm', ROOTS)).not.toBeNull()
  })
  it('passes with the exact confirm word', () => {
    expect(gate('delete', ['C:\\FakeWindows\\x'], 'developer', CONFIRM_WORD, ROOTS)).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- policy`
Expected: FAIL — cannot resolve `../src/main/policy`.

- [ ] **Step 3: Implement `policy.ts`**

Create `src/main/policy.ts`. **No Electron imports** — that is what keeps it unit-testable:

```ts
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
      reason: 'Permanent delete is a Developer mode operation. Switch modes in the status bar if you really need it.',
    }
  }

  for (const p of paths) {
    const cls = classify(p, roots)
    if (cls === 'trash') {
      return {
        kind: 'deny',
        reason: "That's Claude Explorer's own undo staging folder — changing it would break pending undo.",
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- policy`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/main/policy.ts test/policy.test.ts
git commit -m "feat(policy): safety kernel with injectable system roots (KAN-6)"
```

---

### Task 3: D2 + D5 — UNC and long-path handling (KAN-7)

**Files:**
- Modify: `src/shared/pathutil.ts:1-3`
- Modify: `src/main/trash.ts:9-20,33-37`
- Test: `test/pathutil.test.ts`, `test/trash.test.ts`

**Interfaces:**
- Produces: `driveKey(path): string` in `pathutil.ts`. Nothing else consumes it yet; `sameDrive` and `trash.ts` both use it.

- [ ] **Step 1: Write the failing tests**

Append to `test/pathutil.test.ts`:

```ts
import { driveKey, sameDrive } from '../src/shared/pathutil'

describe('driveKey', () => {
  it('reduces a local path to its drive letter', () => {
    expect(driveKey('C:\\Users\\dan')).toBe('c:')
  })
  it('reduces a UNC path to \\\\server\\share, not a bare backslash', () => {
    expect(driveKey('\\\\server\\share\\proj')).toBe('\\\\server\\share')
  })
  it('strips the \\\\?\\ long-path prefix', () => {
    expect(driveKey('\\\\?\\C:\\very\\long')).toBe('c:')
  })
})

describe('sameDrive', () => {
  it('matches same local drive regardless of case', () => {
    expect(sameDrive('C:\\a', 'c:\\b')).toBe(true)
  })
  it('does NOT treat two different UNC shares as the same drive', () => {
    expect(sameDrive('\\\\alpha\\one\\x', '\\\\beta\\two\\y')).toBe(false)
  })
  it('matches the same UNC share', () => {
    expect(sameDrive('\\\\alpha\\one\\x', '\\\\alpha\\one\\y')).toBe(true)
  })
})
```

Append to `test/trash.test.ts`:

```ts
import { driveRootOf } from '../src/main/trash'

describe('driveRootOf', () => {
  it('returns the drive root for a local path', () => {
    expect(driveRootOf('C:\\Users\\dan\\f.txt')).toBe('C:\\')
  })
  it('returns the share root for a UNC path', () => {
    expect(driveRootOf('\\\\server\\share\\proj\\f.txt')).toBe('\\\\server\\share')
  })
  it('handles \\\\?\\ long paths', () => {
    expect(driveRootOf('\\\\?\\C:\\deep\\f.txt')).toBe('C:\\')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- pathutil trash`
Expected: FAIL — `driveKey` and `driveRootOf` are not exported.

- [ ] **Step 3: Implement the fixes**

In `src/shared/pathutil.ts`, **replace** the existing `sameDrive` (lines 1-3) with:

```ts
/** Reduces a path to the volume it lives on: "c:" for local paths,
 *  "\\\\server\\share" for UNC. The old implementation used slice(0,1), which
 *  returned "\" for EVERY UNC path — making all network paths compare equal. */
export function driveKey(p: string): string {
  const s = p.replace(/^\\\\\?\\/, '') // strip \\?\ long-path prefix
  const unc = /^\\\\([^\\]+)\\([^\\]+)/.exec(s)
  if (unc) return `\\\\${unc[1]}\\${unc[2]}`.toLowerCase()
  return s.slice(0, 2).toLowerCase()
}

export function sameDrive(a: string, b: string): boolean {
  return driveKey(a) === driveKey(b)
}
```

In `src/main/trash.ts`, **replace** `driveRoot` and `trashRootFor` (lines 33-37) with:

```ts
/** Exported for tests. "C:\" for local, "\\\\server\\share" for UNC. */
export function driveRootOf(p: string): string {
  const key = driveKey(p)
  return key.startsWith('\\\\') ? key : key.toUpperCase() + '\\'
}

function trashRootFor(p: string): string {
  try {
    const root = driveRootOf(p)
    accessSync(root, constants.W_OK)
    return join(root, '.claude-explorer-trash')
  } catch {
    // ponytail: falls back to userData when the volume root is unwritable
    // (read-only share, locked-down drive). This can be a different volume,
    // which is why stageInto handles EXDEV below.
    return join(app.getPath('userData'), 'trash')
  }
}
```

Add these imports at the top of `trash.ts`:

```ts
import { accessSync, constants } from 'node:fs'
import { cp, rm } from 'node:fs/promises'
import { driveKey } from '../shared/pathutil'
```

Then make `stageInto` survive a cross-volume fallback — **replace** the bare `await rename(original, staged)` on line 16 with:

```ts
    try {
      await rename(original, staged)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
      await cp(original, staged, { recursive: true })
      await rm(original, { recursive: true, force: true })
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- pathutil trash`
Expected: PASS. The pre-existing `trash.test.ts` staging tests must still pass.

- [ ] **Step 5: Commit**

```bash
git add src/shared/pathutil.ts src/main/trash.ts test/pathutil.test.ts test/trash.test.ts
git commit -m "fix(paths): D2/D5 — UNC and \\\\?\\ long-path handling in trash root and sameDrive (KAN-7)"
```

---

### Task 4: D1 + D4 — junctions, hidden flags, legible errors (KAN-8)

**Files:**
- Modify: `src/main/fs.ts` (whole file)
- Modify: `src/main/fs.handlers.ts:6`
- Test: `test/fs.test.ts` (create)

**Interfaces:**
- Consumes: `DirEntry`, `ListResult` from Task 1.
- Produces: `listDir(path): Promise<ListResult>`, `isHidden(name): boolean`, `humanizeFsError(err): string`. Task 5 imports `humanizeFsError`.

- [ ] **Step 1: Write the failing tests**

Create `test/fs.test.ts`. The junction test creates a **real** junction — `mklink /J` needs no admin rights:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listDir, isHidden, humanizeFsError } from '../src/main/fs'

let base: string

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'ce-fs-'))
  mkdirSync(join(base, 'real'))
  writeFileSync(join(base, 'real', 'keep.txt'), 'payload')
  writeFileSync(join(base, 'plain.txt'), 'x')
  writeFileSync(join(base, '.hidden'), 'x')
  execFileSync('cmd', ['/c', 'mklink', '/J', join(base, 'link'), join(base, 'real')])
})

afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('listDir', () => {
  it('classifies a directory junction as a directory (D1)', async () => {
    const r = await listDir(base)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const link = r.entries.find((e) => e.name === 'link')!
    expect(link.isDirectory).toBe(true)
    expect(link.isSymlink).toBe(true)
  })

  it('marks a plain folder as not a symlink', async () => {
    const r = await listDir(base)
    if (!r.ok) return
    expect(r.entries.find((e) => e.name === 'real')!.isSymlink).toBe(false)
  })

  it('flags dotfiles as hidden', async () => {
    const r = await listDir(base)
    if (!r.ok) return
    expect(r.entries.find((e) => e.name === '.hidden')!.hidden).toBe(true)
    expect(r.entries.find((e) => e.name === 'plain.txt')!.hidden).toBe(false)
  })

  it('returns a typed reason instead of throwing on a missing folder (D4)', async () => {
    const r = await listDir(join(base, 'does-not-exist'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('No longer exists')
  })
})

describe('isHidden', () => {
  it('flags dotfiles and known Windows noise, case-insensitively', () => {
    expect(isHidden('.git')).toBe(true)
    expect(isHidden('Thumbs.db')).toBe(true)
    expect(isHidden('THUMBS.DB')).toBe(true)
    expect(isHidden('$Recycle.Bin')).toBe(true)
    expect(isHidden('src')).toBe(false)
  })
})

describe('humanizeFsError', () => {
  it('maps errno codes to plain English', () => {
    expect(humanizeFsError({ code: 'EACCES' })).toBe('Access denied')
    expect(humanizeFsError({ code: 'EBUSY' })).toBe('In use by another program')
    expect(humanizeFsError({})).toMatch(/Could not read/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- fs`
Expected: FAIL — `isHidden`/`humanizeFsError` not exported; `link.isDirectory` is `false`.

- [ ] **Step 3: Implement `fs.ts`**

Replace the entire contents of `src/main/fs.ts`:

```ts
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DirEntry, ListResult } from '../shared/types'

// ponytail: name-based hidden detection, not real FILE_ATTRIBUTE_HIDDEN.
// Reading true Win32 attributes needs a native dep or an `attrib` spawn per
// listing. Upgrade behind this same function; no call sites change.
const NOISE = new Set([
  '$recycle.bin',
  'system volume information',
  'pagefile.sys',
  'hiberfil.sys',
  'swapfile.sys',
  'desktop.ini',
  'thumbs.db',
  '.claude-explorer-trash',
])

export function isHidden(name: string): boolean {
  return name.startsWith('.') || NOISE.has(name.toLowerCase())
}

export function humanizeFsError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return 'Access denied'
    case 'ENOENT':
      return 'No longer exists'
    case 'EBUSY':
      return 'In use by another program'
    case 'ENOTDIR':
      return 'Not a folder'
    default:
      return code ? `Could not read this folder (${code})` : 'Could not read this folder'
  }
}

export async function listDir(path: string): Promise<ListResult> {
  let raw
  try {
    raw = await readdir(path, { withFileTypes: true })
  } catch (err) {
    return { ok: false, reason: humanizeFsError(err) }
  }

  const entries = await Promise.all(
    raw.map(async (e): Promise<DirEntry> => {
      const full = join(path, e.name)
      const isSymlink = e.isSymbolicLink()
      let isDirectory = e.isDirectory()
      // Dirent reports junctions/symlinks as neither file nor directory, so a
      // junction to a folder would otherwise render as a file. stat() follows
      // the link; a dangling target falls back to "not a directory".
      if (isSymlink) {
        try {
          isDirectory = (await stat(full)).isDirectory()
        } catch {
          isDirectory = false
        }
      }
      return { name: e.name, path: full, isDirectory, isSymlink, hidden: isHidden(e.name) }
    }),
  )

  entries.sort((a, b) =>
    a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1,
  )
  return { ok: true, entries }
}
```

`src/main/fs.handlers.ts` needs no change — it forwards whatever `listDir` returns.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- fs`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/main/fs.ts test/fs.test.ts
git commit -m "fix(fs): D1/D4 — junction classification, hidden flags, typed listing errors (KAN-8)"
```

---

### Task 5: D3 + route every mutation through the chokepoint (KAN-9)

**Files:**
- Modify: `src/main/fsmutate.ts:13-28`
- Modify: `src/main/fsmutate.handlers.ts` (whole file)
- Modify: `src/main/trash.handlers.ts` (whole file)

**Interfaces:**
- Consumes: `gate()` from Task 2, `humanizeFsError()` from Task 4, `OpResult` from Task 1, `getSettings()` from `src/main/settings.ts`.

- [ ] **Step 1: Fix D3 by reusing the existing helper**

In `src/main/fsmutate.ts`, add `winDirname` to the existing import from `../shared/pathutil`, then replace both broken parent-path computations.

Line 14 becomes:
```ts
  const dir = winDirname(path)
```
Line 23 becomes:
```ts
  const dir = winDirname(path)
```
and line 24's `join(dir, finalName)` now uses that `dir`. Delete the `path.slice(0, path.lastIndexOf('\\'))` expressions entirely — `winDirname` at `pathutil.ts:10` already handles both separators and guards `i <= 0`.

- [ ] **Step 2: Route the mutate handlers through the gate**

Replace the entire contents of `src/main/fsmutate.handlers.ts`:

```ts
import { ipcMain } from 'electron'
import { CH } from '../shared/ipc'
import type { OpResult } from '../shared/types'
import { rename, mkdir, newFile, copy, move } from './fsmutate'
import { gate, type Op, type Verdict } from './policy'
import { getSettings } from './settings'
import { humanizeFsError } from './fs'
import { winDirname } from '../shared/pathutil'

function blocked(v: Verdict): OpResult<never> {
  return v.kind === 'deny'
    ? { ok: false, code: 'DENIED', reason: v.reason }
    : { ok: false, code: 'NEEDS_CONFIRM', reason: v.reason, typed: v.kind === 'confirm' && v.typed }
}

/** Single wrapper so no handler can forget the gate. */
async function guarded<T>(
  op: Op,
  paths: string[],
  confirm: string | undefined,
  run: () => Promise<T>,
): Promise<OpResult<T>> {
  const v = gate(op, paths, getSettings().mode, confirm)
  if (v) return blocked(v)
  try {
    return { ok: true, value: await run() }
  } catch (err) {
    return { ok: false, code: 'ERROR', reason: humanizeFsError(err) }
  }
}

export function registerFsMutateHandlers() {
  ipcMain.handle(CH.fsRename, (_e, from: string, to: string, confirm?: string) =>
    guarded('rename', [from, to], confirm, () => rename(from, to)),
  )
  // mkdir/newFile create INSIDE a directory, so the parent is what gets gated.
  ipcMain.handle(CH.fsMkdir, (_e, path: string, confirm?: string) =>
    guarded('mkdir', [winDirname(path)], confirm, () => mkdir(path)),
  )
  ipcMain.handle(CH.fsNewFile, (_e, path: string, confirm?: string) =>
    guarded('newFile', [winDirname(path)], confirm, () => newFile(path)),
  )
  ipcMain.handle(CH.fsCopy, (_e, src: string, destDir: string, confirm?: string) =>
    guarded('copy', [destDir], confirm, () => copy(src, destDir)),
  )
  // move both removes from src and writes to dest — gate both.
  ipcMain.handle(CH.fsMove, (_e, src: string, destDir: string, confirm?: string) =>
    guarded('move', [src, destDir], confirm, () => move(src, destDir)),
  )
}
```

- [ ] **Step 3: Route the trash handlers through the gate**

Replace the entire contents of `src/main/trash.handlers.ts`:

```ts
import { ipcMain } from 'electron'
import { shell } from 'electron'
import { rm } from 'node:fs/promises'
import { CH } from '../shared/ipc'
import type { OpResult, TrashRecord } from '../shared/types'
import { trashItems, restoreAndUntrack } from './trash'
import { gate } from './policy'
import { getSettings } from './settings'
import { humanizeFsError } from './fs'

export function registerTrashHandlers() {
  ipcMain.handle(
    CH.fsDelete,
    async (
      _e,
      paths: string[],
      opts?: { permanent?: boolean; confirm?: string },
    ): Promise<OpResult<TrashRecord[]>> => {
      const op = opts?.permanent ? 'permanentDelete' : 'delete'
      const v = gate(op, paths, getSettings().mode, opts?.confirm)
      if (v) {
        return v.kind === 'deny'
          ? { ok: false, code: 'DENIED', reason: v.reason }
          : { ok: false, code: 'NEEDS_CONFIRM', reason: v.reason, typed: v.typed }
      }
      try {
        if (opts?.permanent) {
          // Bypasses staging entirely: no TrashRecord, so no undo entry. Try the
          // Recycle Bin first so the OS still has a copy; fall back to a hard rm.
          for (const p of paths) {
            try {
              await shell.trashItem(p)
            } catch {
              await rm(p, { recursive: true, force: true })
            }
          }
          return { ok: true, value: [] }
        }
        return { ok: true, value: await trashItems(paths) }
      } catch (err) {
        return { ok: false, code: 'ERROR', reason: humanizeFsError(err) }
      }
    },
  )
  ipcMain.handle(CH.fsRestore, (_e, records) => restoreAndUntrack(records))
}
```

- [ ] **Step 4: Verify no mutation path bypasses the gate**

Run: `npx tsc --noEmit` (expect remaining errors only in `FileBrowser.tsx`, fixed in Task 7)

Then audit by hand — this is the whole point of the chokepoint, and one missed call site voids the guarantee:

Run: `grep -rn "ipcMain.handle" src/main/`
Expected: every handler for `fsRename`, `fsMkdir`, `fsNewFile`, `fsCopy`, `fsMove`, `fsDelete` visibly calls `guarded(...)` or `gate(...)`. Read-only handlers (`fsList`, `fsHome`, `fsExists`, `sessionsList`, `recents*`, `settings*`) correctly do not.

- [ ] **Step 5: Commit**

```bash
git add src/main/fsmutate.ts src/main/fsmutate.handlers.ts src/main/trash.handlers.ts
git commit -m "feat(policy): D3 + route every mutating handler through the chokepoint (KAN-9)"
```

---

### Task 6: Mode toggle — persistence, status bar, menu (KAN-10)

**Files:**
- Modify: `src/main/settings.ts:6`
- Modify: `src/main/menu.ts:52-57`
- Modify: `src/renderer/components/StatusBar.tsx` (whole file)

**Interfaces:**
- Produces: `StatusBar` prop seam `{ count, selected, mode, onToggleMode }` — Task 7 relies on this exact shape. Menu command string `'toggle-mode'`.

- [ ] **Step 1: Default the setting**

In `src/main/settings.ts` line 6:

```ts
const DEFAULTS: Settings = { ideCommand: 'code', mode: 'explorer' }
```

`getSettings()` already spreads `DEFAULTS` before the parsed JSON, so a v0.1.0 `settings.json` with no `mode` key loads as `explorer`. No migration needed — verify this in Task 9 rather than assuming it.

- [ ] **Step 2: Add the menu entry**

In `src/main/menu.ts`, add to the `Settings` submenu (after the existing `Preferences…` item):

```ts
        { type: 'separator' },
        {
          label: 'Toggle Developer Mode',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => send('toggle-mode'),
        },
```

- [ ] **Step 3: Extend the status bar**

Replace the entire contents of `src/renderer/components/StatusBar.tsx`:

```tsx
import type { FileMode } from '../../shared/types'

export function StatusBar({
  count,
  selected,
  mode,
  onToggleMode,
}: {
  count: number
  selected: number
  mode: FileMode
  onToggleMode(): void
}) {
  const dev = mode === 'developer'
  return (
    <div className="statusbar">
      <span>{count} items</span>
      {selected > 0 && <span>{selected} selected</span>}
      <button
        className={`mode-toggle${dev ? ' mode-toggle--dev' : ''}`}
        onClick={onToggleMode}
        title={
          dev
            ? 'Developer mode: hidden files shown, risky operations unlocked. Click to switch to Explorer mode.'
            : 'Explorer mode: hidden files and system paths protected. Click to switch to Developer mode.'
        }
      >
        {dev ? 'Developer' : 'Explorer'}
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Style the toggle**

Append to `src/renderer/index.css`, reusing existing custom properties — **do not introduce new colour literals**:

```css
.mode-toggle {
  margin-left: auto;
  font: inherit;
  background: none;
  border: 1px solid var(--clay);
  color: var(--clay);
  border-radius: 3px;
  padding: 0 8px;
  cursor: pointer;
}
.mode-toggle--dev {
  background: var(--clay);
  color: var(--paper);
}
```

If `--paper` is not the exact name used in `index.css`, substitute the existing background custom property rather than adding one.

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit` — `StatusBar` call sites in `FileBrowser.tsx` will error until Task 7. That is expected.

```bash
git add src/main/settings.ts src/main/menu.ts src/renderer/components/StatusBar.tsx src/renderer/index.css
git commit -m "feat(mode): Explorer/Developer toggle in settings, menu, and status bar (KAN-10)"
```

---

### Task 7: Renderer — confirmations, hidden filtering, symlink display (KAN-11)

**Files:**
- Create: `src/renderer/opresult.ts`
- Create: `src/renderer/components/ConfirmDialog.tsx`
- Modify: `src/renderer/components/FileBrowser.tsx`

**Interfaces:**
- Consumes: `OpResult`, `ListResult`, `DirEntry.hidden`, `DirEntry.isSymlink` (Task 1); `StatusBar` props (Task 6); `CONFIRM_WORD` — redeclare it locally as `'CONFIRM'` rather than importing from `src/main/`, so the renderer bundle never pulls in a main-process module.

**No other task may touch `FileBrowser.tsx` — it is the largest file in the repo and the highest-collision-risk file in M1.**

- [ ] **Step 1: Create the `unwrap` helper**

Create `src/renderer/opresult.ts`. One place handles the union, so no call site can quietly ignore an `ok: false`:

```ts
import type { OpResult } from '../shared/types'

export const CONFIRM_WORD = 'CONFIRM'

export interface ConfirmRequest {
  reason: string
  typed: boolean
  retry(confirm: string): Promise<void>
}

/**
 * Runs a policy-gated operation.
 *  - success            → returns the value
 *  - DENIED / ERROR     → onMessage(reason), returns undefined
 *  - NEEDS_CONFIRM      → onConfirm(request), returns undefined
 * The caller supplies `run` so the retry re-invokes the identical operation
 * with a confirm value; main re-validates it, so this is not a trust hole.
 */
export async function unwrap<T>(
  run: (confirm?: string) => Promise<OpResult<T>>,
  onMessage: (msg: string) => void,
  onConfirm: (req: ConfirmRequest) => void,
): Promise<T | undefined> {
  const r = await run()
  if (r.ok) return r.value
  if (r.code === 'NEEDS_CONFIRM') {
    onConfirm({
      reason: r.reason,
      typed: r.typed,
      retry: async (confirm: string) => {
        const again = await run(confirm)
        if (!again.ok) onMessage(again.reason)
      },
    })
    return undefined
  }
  onMessage(r.reason)
  return undefined
}
```

- [ ] **Step 2: Create the confirm dialog**

Create `src/renderer/components/ConfirmDialog.tsx`:

```tsx
import { useState } from 'react'
import { CONFIRM_WORD, type ConfirmRequest } from '../opresult'

export function ConfirmDialog({
  request,
  onClose,
}: {
  request: ConfirmRequest
  onClose(): void
}) {
  const [typed, setTyped] = useState('')
  const ready = !request.typed || typed === CONFIRM_WORD

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <p>{request.reason}</p>
        {request.typed && (
          <input
            autoFocus
            value={typed}
            placeholder={CONFIRM_WORD}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && ready) {
                void request.retry(typed).finally(onClose)
              }
            }}
          />
        )}
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button
            disabled={!ready}
            onClick={() => void request.retry(typed).finally(onClose)}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  )
}
```

Reuse the `modal-backdrop` / `modal` / `modal-actions` class names already used by `SettingsModal.tsx`. If those exact names differ, match whatever `SettingsModal.tsx` uses — do not add a parallel set.

- [ ] **Step 3: Wire `FileBrowser.tsx`**

Make these changes, leaving existing selection/drag/undo logic intact:

1. **Listing** — `api.fsList` now returns `ListResult`. Where the result is consumed, branch on `ok`: on success use `r.entries`; on failure store `r.reason` in a `listError` state and render it inline in the file pane instead of the (empty) list.
2. **Hidden filtering** — derive the rendered list: `const shown = mode === 'developer' ? entries : entries.filter((e) => !e.hidden)`. Pass `shown.length` to `StatusBar`'s `count`.
3. **Mode state** — load via `api.settingsGet()`, persist via `api.settingsSet({ mode })`. Subscribe to `api.onMenuCommand` for `'toggle-mode'` so the menu and status-bar button share one path.
4. **Symlink display** — render an entry with `isSymlink` with a trailing `↗` marker and the existing dimmed style; keep directory affordances driven by `isDirectory`.
5. **Hidden entries in Developer mode** — render at reduced opacity via a `dimmed` class.
6. **Mutations** — route every `api.fsRename` / `fsMkdir` / `fsNewFile` / `fsCopy` / `fsMove` / `fsDelete` call through `unwrap(...)`, passing a `run` closure that forwards the confirm value. Example for delete:

```ts
const records = await unwrap(
  (confirm) => window.api.fsDelete(paths, { confirm }),
  setMessage,
  setConfirmRequest,
)
if (records) undo.push(makeDeleteCommand(records))
```

**Only push an undo entry when the operation actually returned a value.** A denied or unconfirmed operation must not enter the undo stack — an undo entry for work that never happened corrupts the stack.

7. **Render** `{confirmRequest && <ConfirmDialog request={confirmRequest} onClose={() => setConfirmRequest(null)} />}` and an inline `{message}` banner.

- [ ] **Step 4: Verify the whole tree compiles**

Run: `npx tsc --noEmit`
Expected: **zero errors across the entire tree.** This is the task where the contract change finishes landing.

Run: `npm test`
Expected: all suites PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/
git commit -m "feat(ui): confirm dialog, OpResult handling, hidden filtering, symlink display (KAN-11)"
```

---

### Task 8: Shift+Del permanent delete (KAN-12)

**Files:**
- Modify: `src/renderer/components/FileBrowser.tsx` (key handler only)

**Interfaces:**
- Consumes: `fsDelete(paths, {permanent, confirm})` (Task 1), `unwrap` (Task 7). Main-side enforcement already exists from Task 5 — this task is only the key binding.

- [ ] **Step 1: Bind Shift+Del**

In the existing `Delete` key handler, branch on `e.shiftKey`:

```ts
if (e.key === 'Delete') {
  e.preventDefault()
  const paths = [...selection]
  if (paths.length === 0) return
  if (e.shiftKey) {
    void unwrap(
      (confirm) => window.api.fsDelete(paths, { permanent: true, confirm }),
      setMessage,
      setConfirmRequest,
    ).then((r) => { if (r) void refresh() })
    return
  }
  // ...existing trash-delete path, unchanged...
}
```

**No undo entry is pushed for the permanent path.** It returns `[]` and bypasses staging, so there is nothing to restore — pushing an unexecutable undo command is worse than pushing none.

- [ ] **Step 2: Verify behaviour manually**

Run: `npm run dev`

- In Explorer mode, `Shift+Del` on a test file → refused, message names Developer mode.
- Switch to Developer mode, `Shift+Del` → typed dialog appears, text says it cannot be undone.
- Type `CONFIRM` → file is gone; `Ctrl+Z` does **not** resurrect it.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/FileBrowser.tsx
git commit -m "feat(delete): Shift+Del permanent delete, Developer mode only (KAN-12)"
```

---

### Task 9: Integration, verification, release (KAN-13)

**Files:**
- Modify: `docs/superpowers/specs/2026-07-28-safety-and-modes-design.md` (§6 `fsList` amendment)
- Modify: `README.md`
- Modify: `package.json` (version)

- [ ] **Step 1: Amend the spec's `fsList` contradiction**

In §6, replace "`fsList` keeps its signature; the richer `DirEntry` flows through unchanged." with:

```markdown
`fsList` returns `ListResult` — a folder that cannot be read reports why instead of throwing (D4). The richer `DirEntry` flows through inside it.
```

- [ ] **Step 2: Full automated verification**

```bash
npm test
npx tsc --noEmit
npm run package
```
Expected: all suites pass; zero type errors; installer produced at `dist/Claude Explorer Setup <version>.exe`.

- [ ] **Step 3: Prove the regression tests actually regress**

For each of D1–D5, `git stash` the fix, confirm the test **fails**, restore. A test that passes before its fix is testing nothing.

- [ ] **Step 4: Manual QA against the installed build**

1. Explorer mode: deleting inside `C:\Windows` is refused, reason names the mode toggle.
2. Developer mode: same operation succeeds only after typing `CONFIRM`.
3. `.git` / `.env` appear **only** in Developer mode.
4. A `node_modules` junction opens as a folder on double-click.
5. A permission-denied folder shows "Access denied" inline; the app stays usable.
6. `Shift+Del` refused in Explorer mode; works in Developer mode with typed confirm.
7. **Upgrade path:** an existing `settings.json` from v0.1.0 (no `mode` key) loads as Explorer mode.

- [ ] **Step 5: Update the README**

Add a **Safety** section covering the two modes, what Developer mode unlocks, and that system paths are protected by default.

- [ ] **Step 6: Bump version and open the PR**

```bash
# package.json version -> 0.2.0
git add -A
git commit -m "chore: v0.2.0 — file safety and Explorer/Developer modes (KAN-1)"
git push -u origin feat/m1-safety-and-modes
gh pr create --title "M1 — File safety & Explorer/Developer modes" --body "Closes KAN-1. Implements KAN-5..KAN-13."
```

**Do not merge.** Dan merges manually. Move the JIRA tickets to In Review when the PR is open.

---

## Self-Review

**Spec coverage:** §4 policy chokepoint → T2, T5. §4 rules table → T2. §5 confirm protocol → T1, T5, T7. §5 permanent delete → T5, T8. §6 contract → T1. §6 hidden detection → T4. §7 UI surface → T6, T7. §8 testing → T2, T3, T4 + T9 step 3. §3 defects: D1/D4 → T4, D2/D5 → T3, D3 → T5. §10 definition of done → T9. **No gaps.**

**Placeholder scan:** No TBD/TODO. Every code step carries real code. The two prose-directed steps (T7 step 3, T9 step 5) enumerate each specific change rather than saying "wire it up".

**Type consistency:** `OpResult<T>`/`ListResult` defined in T1, consumed identically in T4/T5/T7. `gate(op, paths, mode, confirm?, roots?)` defined in T2, called with that exact arity in T5. `humanizeFsError` exported in T4, imported in T5. `StatusBar` props defined in T6, consumed in T7. `CONFIRM_WORD` exists twice by design — `src/main/policy.ts` for enforcement, `src/renderer/opresult.ts` for display — so the renderer bundle never imports a main-process module. Both are the literal `'CONFIRM'`; T9's manual QA exercises the pairing.

**Known deviation:** the spec's §6 `fsList` line contradicts D4. Flagged at the top of this plan; T9 step 1 amends the spec.
