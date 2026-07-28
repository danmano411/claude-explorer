# Milestone 1 — File Safety & Explorer/Developer Modes

**Date:** 2026-07-28
**Status:** Design approved, implementation plan pending
**Scope:** `src/main/policy.ts` (new), `src/main/fs.ts`, `src/main/fsmutate.ts`, `src/main/trash.ts`, `src/shared/pathutil.ts`, `src/shared/ipc.ts`, `src/shared/types.ts`, renderer file browser + status bar

---

## 1. Context

Claude Explorer today is a companion to File Explorer, Claude Code, PowerShell, and VS Code. The goal of the current arc is to make it *replace* them for day-to-day project work. That arc is decomposed into four milestones:

| # | Milestone | Closes the gap with |
|---|---|---|
| **1** | **File safety & Explorer/Developer modes** | File Explorer's trust model |
| 2 | File viewer + git diff surface | VS Code (reading & supervising) |
| 3 | Search (filename + content) | File Explorer search |
| 4 | AI-integration surface | future agent runtimes |

This document specifies **Milestone 1 only**.

Milestone 1 comes first because it is foundational: hidden-file visibility, protected-path rules, and error surfacing are cross-cutting. Every later feature (the viewer deciding whether to render `.env`, search deciding whether to descend into `node_modules`) has to consult the same mode state. Building it after the fact means retrofitting mode-awareness into five call sites.

### Decisions already taken

- **Editing stays in Claude.** The viewer in M2 is read-only plus diff. No Monaco, no embedded IDE. Keeps the "no new runtime deps without good reason" rule intact and matches the product framing below.
- **Safety covers user actions, not Claude's writes.** Claude Code has its own permission prompts, and "what did Claude change" is answered by the M2 git-diff surface. We are not building a second, competing safety system in M1.

### Product framing

The app's differentiator is not "a worse VS Code." It is **the cockpit for supervising an AI that edits your files.** Safety work therefore serves a trust goal, not a compliance goal: a user must be able to hand a folder to Claude and know that neither Claude nor a mis-drag can quietly destroy something.

---

## 2. Goals & non-goals

**Goals**

1. A user in the default mode cannot destroy system state through the app, even by accident.
2. A developer can opt into hidden files and risky operations without leaving the app.
3. Every file operation that fails does so *visibly and legibly*, never as an unhandled rejection.
4. The five verified defects in §3 are fixed, with regression tests.

**Non-goals for M1** (explicitly deferred, not forgotten)

- File properties dialog; sort-by-size/date columns.
- Network share *enumeration/browsing* (the trash fix makes deleting on an already-reachable UNC path safe; discovering shares is out of scope).
- Real `FILE_ATTRIBUTE_HIDDEN` detection — see §6 ceiling.
- Snapshotting Claude's writes — deferred, may become its own milestone.

---

## 3. Verified defects

These were confirmed by execution, not inspection. Probe output:

```
link   isDirectory=false  isSymbolicLink=true            ← junctions classify as FILES
\\server\share\proj  →  trashRoot="\.claude-explorer-trash"
parent("newfolder")  =  "newfolde"
```

| # | Location | Defect | Consequence |
|---|---|---|---|
| D1 | `src/main/fs.ts:11` | `e.isDirectory()` is `false` for junctions and symlinks | `node_modules` junctions and OneDrive reparse points render as files; double-click, delete, and copy all take the wrong branch |
| D2 | `src/main/trash.ts:33` | `driveRoot()` = `p.slice(0,2)+'\\'` yields `\\\` for UNC and `\\?\` long paths | Delete on a network share stages to the wrong drive → `EXDEV` → raw unhandled error |
| D3 | `src/main/fsmutate.ts:14,23` | `path.slice(0, path.lastIndexOf('\\'))` returns `-1` for a bare name and ignores forward slashes | Parent directory silently resolves to a truncated string (`"newfolder"` → `"newfolde"`) |
| D4 | `src/main/fs.ts:6` | `readdir` has no `try/catch` | One permission-denied folder fails the entire listing with no user-facing message |
| D5 | `src/shared/pathutil.ts:2` | `sameDrive` compares `slice(0,1)`, which is `\` for every UNC path | All network paths compare as same-drive, so drag-and-drop picks move instead of copy |

**D3 is a reuse defect, not a missing helper.** `winDirname` at `pathutil.ts:10` already handles both separators and guards `i <= 0`. The fix is to delete the broken inline slices and call it.

---

## 4. Architecture — a single policy chokepoint in main

**The trust boundary is IPC, not the UI.** `src/preload/index.ts` exposes `fsDelete`, `fsMove`, and friends directly to renderer JavaScript. A guard implemented in `FileBrowser.tsx` is bypassed by any call site that forgets to invoke it, and by anything that reaches the preload bridge. Therefore:

> All safety decisions are made in the main process. The renderer only *renders* verdicts; it never *makes* them.

### New module: `src/main/policy.ts`

Pure, with **zero Electron imports**, so it unit-tests without a harness — matching the existing `fs.ts` ↔ `fs.handlers.ts` split convention.

```ts
export type FileMode = 'explorer' | 'developer'
export type Op = 'delete' | 'permanentDelete' | 'move' | 'copy' | 'rename' | 'mkdir' | 'newFile'

export type Verdict =
  | { kind: 'allow' }
  | { kind: 'deny';    reason: string }
  | { kind: 'confirm'; reason: string; typed: boolean }

export function classify(path: string, roots?: string[]):
  'system' | 'driveRoot' | 'trash' | 'normal'

export function check(op: Op, paths: string[], mode: FileMode, roots?: string[]): Verdict
```

`roots` is injectable and defaults to the real system roots. **This is what makes the safety layer testable without a VM:** tests pass temp directories as `roots` and exercise every branch against disposable paths, never against a real `C:\Windows`.

### Policy rules

| Target | Explorer mode | Developer mode |
|---|---|---|
| `C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)`, `C:\ProgramData` | **deny** | **typed confirm** |
| Drive root (`C:\`, `D:\`, …) | **deny** | **typed confirm** |
| App's own `.claude-explorer-trash` | **deny** | **deny** — live staging; deleting it corrupts pending undo |
| Everything else | allow | allow |

Classification matches on a normalized, case-folded, trailing-separator-stripped path, and must match **the path itself or any ancestor** — deleting `C:\Windows\System32\drivers` is a system-path operation even though the literal string isn't in the roots list.

### Explorer-parity note on confirmations

Normal deletes get **no confirmation dialog in either mode.** This is deliberate File Explorer parity: Windows 11 does not confirm Recycle Bin deletes, because undo exists. Claude Explorer already has both trash staging and `Ctrl+Z`. Adding a confirm here would be *less* Explorer-like, not safer.

Confirmation is reserved for: protected paths, and permanent delete.

### Permanent delete (`Shift+Del`)

`Shift+Del` bypasses trash staging and is **Developer-mode only**, with typed confirmation. In Explorer mode the shortcut is denied with a reason pointing at the mode toggle. This is the "risky manoeuvre" half of the toggle, and it restores an Explorer protocol the app currently lacks entirely.

Because it bypasses staging, permanent delete is **not undoable** — `Ctrl+Z` cannot restore it, and the confirm dialog says so explicitly.

---

## 5. The confirm protocol

Electron's `ipcMain.handle` serializes a thrown `Error` into a string-prefixed message on the renderer side, so structured error data does not survive a `throw`. Mutating operations therefore return a **discriminated union** rather than throwing:

```ts
export type OpResult<T> =
  | { ok: true;  value: T }
  | { ok: false; code: 'DENIED';        reason: string }
  | { ok: false; code: 'NEEDS_CONFIRM'; reason: string; typed: boolean }
  | { ok: false; code: 'ERROR';         reason: string }
```

Flow:

1. Renderer invokes the operation normally.
2. Main runs `check()`. If the verdict is `confirm`, main returns `NEEDS_CONFIRM` **without touching disk**.
3. Renderer shows the dialog — a simple `[Cancel] [Continue]`, or for `typed: true`, a field requiring the literal word **`CONFIRM`**. One word for every typed operation, regardless of op type: a per-operation vocabulary is memorable to nobody and adds a branch for no safety gain.
4. Renderer re-invokes with `confirm: '<typed word>'`.
5. **Main re-runs `check()` and validates the confirm value.** The second call is not trusted to have earned its confirmation.

There is no server-side token or pending-operation state. Re-validation on every call is what makes the protocol safe; the renderer cannot skip the check by simply not asking.

`ERROR` carries a humanized message (`EACCES` → "Access denied", `EBUSY` → "File is in use by another program", `ENOENT` → "No longer exists"), which also resolves **D4**.

---

## 6. Data model & IPC contract changes

Per `CLAUDE.md`, the IPC contract is frozen and extended in **one** task before any fan-out. The complete delta:

**`src/shared/types.ts`**
```ts
export interface DirEntry {
  name: string
  path: string
  isDirectory: boolean
  hidden: boolean      // NEW
  isSymlink: boolean   // NEW — junction / symlink / reparse point
}

export interface Settings {
  ideCommand: string
  mode: FileMode       // NEW, default 'explorer'
}
```

**`src/shared/ipc.ts`** — mutating methods gain an optional `confirm` and return `OpResult<T>`:

```ts
fsRename(from: string, to: string, confirm?: string): Promise<OpResult<void>>
fsMkdir(path: string, confirm?: string): Promise<OpResult<string>>
fsNewFile(path: string, confirm?: string): Promise<OpResult<string>>
fsCopy(src: string, destDir: string, confirm?: string): Promise<OpResult<string>>
fsMove(src: string, destDir: string, confirm?: string): Promise<OpResult<string>>
fsDelete(paths: string[], opts?: { permanent?: boolean; confirm?: string }): Promise<OpResult<TrashRecord[]>>
```

`fsList` keeps its signature; the richer `DirEntry` flows through unchanged. Read operations are not policy-gated — **browsing** `C:\Windows` is always allowed in both modes. Only mutation is gated.

### Hidden-file detection

`hidden` is `true` when the name starts with `.`, or is in a known Windows-noise list: `$Recycle.Bin`, `System Volume Information`, `pagefile.sys`, `hiberfil.sys`, `swapfile.sys`, `desktop.ini`, `Thumbs.db`, `.claude-explorer-trash`.

> `ponytail:` name-based heuristic, not real `FILE_ATTRIBUTE_HIDDEN`. Reading true Win32 attributes needs either a native dependency or an `attrib` process spawn per directory listing, both of which cost more than this is worth today. Upgrade path: if a genuinely hidden non-dotfile slips through in practice, add a native attribute read behind the same `hidden` flag — no call sites change.

Explorer mode filters hidden entries out of the listing; Developer mode shows them dimmed. **Filtering happens in the renderer** — main always returns the full listing with flags. Policy enforcement must be main-side; display filtering need not be, and keeping one listing shape avoids a mode-dependent cache.

---

## 7. UI surface

- **Mode toggle** in the status bar (persistent, always-visible current state) and in the menu bar. Switching is instant and re-renders the listing; no restart.
- **Symlinks/junctions** render with a distinguishing marker and correct directory affordance (fixes **D1**).
- **Hidden entries** in Developer mode render dimmed, using the existing `--clay` palette — no second palette, per `CLAUDE.md`.
- **Denied operations** surface an inline, plain-English reason naming the mode: *"System folder — switch to Developer mode if you really need this."* A dead-end refusal with no stated path forward is a worse experience than the risk it prevents.
- **Confirm dialog** reuses the existing modal styling from `SettingsModal.tsx`.
- **Listing errors** (D4) render inline in the file pane, not as a toast — the error belongs to the folder.

---

## 8. Testing strategy

Pure logic gets unit tests, consistent with the existing `test/*.test.ts` layout.

| Test file | Covers |
|---|---|
| `test/policy.test.ts` | Full rules matrix: every `Op` × both modes × all four classifications. Ancestor matching (`C:\Windows\System32\x` is `system`). Case/separator normalization. Confirm-value validation, including a wrong typed word being rejected. |
| `test/pathutil.test.ts` (extend) | `sameDrive` UNC (**D5**); `winDirname` on bare names and forward slashes (**D3**). |
| `test/trash.test.ts` (extend) | `driveRoot`/`trashRootFor` for `C:\`, UNC, and `\\?\` long paths (**D2**); fallback to `userData` when the drive root is unwritable. |
| `test/fs.test.ts` (new) | Junction classified as a directory (**D1**) — creates a real junction via `mklink /J` in a temp dir. `hidden` flagging. `listDir` returning a typed error instead of throwing (**D4**). |

Every defect in §3 gets a test that fails against current `main`. The junction test is a direct port of the probe used to verify D1.

**No VM or elevated sandbox is required.** The injectable `roots` parameter (§4) means the protected-path matrix is exercised entirely against temp directories.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| Contract change touches every mutating call site at once | Freeze `ipc.ts` + `types.ts` in a single first task, then fan out to disjoint files — the workflow already mandated by `CLAUDE.md` |
| `OpResult` union makes renderer call sites noisier | One small `unwrap()` helper in the renderer that handles `DENIED`/`ERROR` uniformly and surfaces `NEEDS_CONFIRM` to the dialog |
| Name-based hidden detection misses a real hidden file | Accepted, ceiling documented in §6 with a no-call-site-change upgrade path |
| Developer mode becomes a footgun | Typed confirmation on every system-path mutation; trash directory is deny-always in *both* modes |

---

## 10. Definition of done

- [ ] All five defects (D1–D5) fixed, each with a test that fails on current `main`.
- [ ] `policy.ts` exists, is Electron-free, and has full rules-matrix coverage.
- [ ] Every mutating IPC handler routes through `check()`; no mutation path bypasses it.
- [ ] Mode persists in `settings.json` and is toggleable from the status bar and menu.
- [ ] `npm test` green; `npx tsc --noEmit` clean; `npm run package` produces a working installer.
- [ ] Manual verification: Explorer mode refuses a `C:\Windows` delete; Developer mode allows it after typed confirm; hidden files appear only in Developer mode; a junction behaves as a directory.
