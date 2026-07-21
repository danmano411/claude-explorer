# Claude Explorer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Windows desktop app that browses folders and, on one action, opens Claude Code in an embedded terminal — so going from "looking at a folder" to "Claude running in it" is one click, with recent folders and resumable sessions one menu away.

**Architecture:** Electron app. Main process owns all OS access (filesystem, pty, session-store reads) and exposes it through a single typed IPC contract (`src/shared/ipc.ts`). Renderer is React: a browser-style tab bar where **each tab independently holds one view — file-explorer OR CC-terminal**. Opening Claude in a file-explorer tab converts that tab into a terminal tab (its own pty running `claude`). Tabs are fully independent, so multiple Claude sessions run concurrently.

**Tech Stack:** Electron + electron-vite + React + TypeScript + Vitest. `node-pty` (real pty), `@xterm/xterm` + `@xterm/addon-fit` (terminal UI). No Rust.

## Global Constraints

- Platform: Windows 11. Paths use `\`; always handle spaces in paths (quote them, pass as argv arrays never shell strings).
- Node: v22 (installed). npm: v10 (installed).
- Every cross-process call goes through `src/shared/ipc.ts` channel constants + types. No ad-hoc `ipcRenderer.invoke('some-string')`.
- Renderer has **no** Node access (`contextIsolation: true`, `nodeIntegration: false`). All OS work is in main, reached via the `window.api` preload bridge.
- Claude session store lives at `~/.claude/projects/<slug>/<uuid>.jsonl`, where `slug = absolutePath.replace(/[^a-zA-Z0-9]/g, '-')`. This mapping is verified against the real machine.
- Environment is pre-installed (Phase 0 Task 0.1's installs are done): `electron`, `electron-vite`, `electron-builder`, `vite`, `@vitejs/plugin-react`, `typescript`, `vitest`, `@types/react(-dom)`, `electron-rebuild` (dev); `react`, `react-dom`, `node-pty`, `@xterm/xterm`, `@xterm/addon-fit` (runtime). node-pty's win32-x64 N-API prebuild is present, so no build toolchain is required. Task 0.1's remaining job is only to author the config + source files, not re-run installs.
- No file mutation in v1 (no copy/rename/delete). No in-file search. No settings UI (config is a JSON file only).
- Non-trivial logic ships ONE runnable check (Vitest, plain asserts): slug encoding, jsonl parsing, recents dedupe/ordering. No fixtures/frameworks beyond Vitest.

---

## Parallel Execution Map

Phase 0 is the foundation and MUST land first (it creates the scaffold + the shared contract every other task imports). After Phase 0, the two phases below can run concurrently across subagents:

- **Phase 1 — main process** (Tasks 1.1–1.5): `fs`, `recents`, `sessions`, `external`, `pty`. These share no files with each other (each is its own module + its own IPC handler registration). Safe to parallelize.
- **Phase 2 — renderer** (Tasks 2.1–2.4): `FileBrowser`, `Terminal`, `RecentMenu`, `App/tab-shell`. Each is its own component file. Safe to parallelize; they depend only on the Phase 0 contract, not on Phase 1 internals (they call `window.api.*` which is stubbed until wired).
- **Phase 3 — integration** (Tasks 3.1–3.2): wiring + packaging. Runs after 1 & 2 land. Single-threaded.

**Collision rule for parallel agents:** the only shared files are `src/shared/ipc.ts` (frozen after Phase 0 — do NOT edit in Phase 1/2; if a new channel is needed, note it for Phase 3) and `src/main/index.ts` / `src/preload/index.ts`. To avoid write-conflicts, Phase 1 tasks register their handlers by **exporting a `register<Module>Handlers(ipcMain)` function**; `src/main/index.ts` imports and calls them — each task adds ONE import line + ONE call line, but Phase 3 owns the final assembly, so Phase 1 tasks only create their own module files and their own `*.handlers.ts`. Same pattern for preload.

---

## File Structure

```
Claude Explorer/
  package.json
  electron.vite.config.ts
  tsconfig.json
  vitest.config.ts
  src/
    shared/
      ipc.ts              # THE CONTRACT: channel names + all payload/return types
      types.ts            # DirEntry, RecentFolder, ClaudeSession, TabState
    main/
      index.ts            # app bootstrap, window, calls register*Handlers
      fs.ts               # listDir(path) -> DirEntry[]
      fs.handlers.ts      # registerFsHandlers(ipcMain)
      recents.ts          # load/add/list recent folders (userData JSON)
      recents.handlers.ts
      sessions.ts         # slugForPath, listSessions(path) -> ClaudeSession[]
      sessions.handlers.ts
      external.ts         # openExternalTerminal(path)
      external.handlers.ts
      pty.ts              # PtyManager: spawn/write/resize/kill claude ptys
      pty.handlers.ts
    preload/
      index.ts            # exposes window.api typed from shared/ipc.ts
    renderer/
      main.tsx            # React root
      App.tsx             # tab bar + active-tab view switch
      tabs.ts             # tab state model (files|terminal), reducer
      components/
        FileBrowser.tsx   # dir grid, breadcrumb, context menu, open actions
        Breadcrumb.tsx
        ContextMenu.tsx
        Terminal.tsx      # xterm bound to a pty id over IPC
        RecentMenu.tsx    # top-left "Open Recent" dropdown
      index.css
  test/
    sessions.test.ts
    recents.test.ts
```

---

## Phase 0 — Scaffold + Contract (must land first)

### Task 0.1: Scaffold Electron + Vite + React + TS

**Files:**
- Create: `package.json`, `electron.vite.config.ts`, `tsconfig.json`, `vitest.config.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/main.tsx`, `src/renderer/App.tsx`, `src/renderer/index.html`

**Interfaces:**
- Produces: a runnable `npm run dev` opening a blank Electron window; `npm test` runs Vitest.

- [ ] **Step 1: Scaffold with electron-vite**

Run:
```bash
npm create @quick-start/electron@latest . -- --template react-ts
```
If the interactive prompt blocks, instead create the project manually with the files below.

- [ ] **Step 2: Install runtime + dev deps**

Run:
```bash
npm install
npm install node-pty @xterm/xterm @xterm/addon-fit
npm install -D vitest
```

- [ ] **Step 3: Configure `package.json` scripts**

Ensure these exist:
```json
{
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "start": "electron-vite preview",
    "test": "vitest run",
    "package": "electron-vite build && electron-builder --win"
  }
}
```

- [ ] **Step 4: Enforce security defaults in `src/main/index.ts`**

BrowserWindow must use:
```ts
webPreferences: {
  preload: join(__dirname, '../preload/index.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: false // required so preload can require node-pty bindings via main
}
```

- [ ] **Step 5: Run it**

Run: `npm run dev`
Expected: a blank Electron window opens with no console errors.

- [ ] **Step 6: Commit**

```bash
git init && git add -A && git commit -m "chore: scaffold electron-vite react-ts app"
```

---

### Task 0.2: The IPC contract + shared types (FROZEN after this task)

**Files:**
- Create: `src/shared/types.ts`, `src/shared/ipc.ts`

**Interfaces:**
- Produces: the channel constants and every payload/return type. Every other task imports from here and MUST NOT modify it.

- [ ] **Step 1: Write `src/shared/types.ts`**

```ts
export interface DirEntry {
  name: string;
  path: string;        // absolute
  isDirectory: boolean;
}

export interface RecentFolder {
  path: string;        // absolute
  name: string;        // basename
  lastOpened: number;  // epoch ms
}

export interface ClaudeSession {
  id: string;          // session UUID (jsonl filename without extension)
  folderPath: string;  // absolute cwd this session belongs to
  title: string;       // first user prompt, truncated to 80 chars, or "(untitled)"
  updated: number;     // epoch ms of newest line's timestamp (fallback: file mtime)
}

export type TabView = 'files' | 'terminal';
```

- [ ] **Step 2: Write `src/shared/ipc.ts`**

```ts
import type { DirEntry, RecentFolder, ClaudeSession } from './types';

export const CH = {
  fsList: 'fs:list',
  fsHome: 'fs:home',
  recentsList: 'recents:list',
  recentsAdd: 'recents:add',
  sessionsList: 'sessions:list',
  externalOpen: 'external:open',
  ptySpawn: 'pty:spawn',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyKill: 'pty:kill',
  ptyData: 'pty:data',   // main -> renderer event
  ptyExit: 'pty:exit',   // main -> renderer event
} as const;

// invoke (renderer -> main -> Promise) signatures
export interface Api {
  fsList(path: string): Promise<DirEntry[]>;
  fsHome(): Promise<string>;
  recentsList(): Promise<RecentFolder[]>;
  recentsAdd(path: string): Promise<void>;
  sessionsList(path: string): Promise<ClaudeSession[]>;
  externalOpen(path: string): Promise<void>;
  ptySpawn(opts: { path: string; resumeId?: string }): Promise<string>; // returns ptyId
  ptyWrite(ptyId: string, data: string): void;
  ptyResize(ptyId: string, cols: number, rows: number): void;
  ptyKill(ptyId: string): void;
  onPtyData(cb: (ptyId: string, data: string) => void): () => void; // returns unsubscribe
  onPtyExit(cb: (ptyId: string, code: number) => void): () => void;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/shared && git commit -m "feat: freeze IPC contract and shared types"
```

---

## Phase 1 — Main process modules (parallelizable after Phase 0)

### Task 1.1: Filesystem listing

**Files:**
- Create: `src/main/fs.ts`, `src/main/fs.handlers.ts`

**Interfaces:**
- Consumes: `DirEntry` from `shared/types`, `CH` from `shared/ipc`.
- Produces: `listDir(path: string): Promise<DirEntry[]>`, `registerFsHandlers(ipcMain: Electron.IpcMain): void`.

- [ ] **Step 1: Write `src/main/fs.ts`**

```ts
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DirEntry } from '../shared/types';

export async function listDir(path: string): Promise<DirEntry[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return entries
    .map((e): DirEntry => ({
      name: e.name,
      path: join(path, e.name),
      isDirectory: e.isDirectory(),
    }))
    .sort((a, b) =>
      a.isDirectory === b.isDirectory
        ? a.name.localeCompare(b.name)
        : a.isDirectory ? -1 : 1
    );
}
```

- [ ] **Step 2: Write `src/main/fs.handlers.ts`**

```ts
import { ipcMain, app } from 'electron';
import { CH } from '../shared/ipc';
import { listDir } from './fs';

export function registerFsHandlers(_ipcMain: typeof ipcMain = ipcMain) {
  ipcMain.handle(CH.fsList, (_e, path: string) => listDir(path));
  ipcMain.handle(CH.fsHome, () => app.getPath('home'));
}
```

- [ ] **Step 3: Commit** — `git add src/main/fs.ts src/main/fs.handlers.ts && git commit -m "feat: fs listing handler"`

---

### Task 1.2: Recent folders store

**Files:**
- Create: `src/main/recents.ts`, `src/main/recents.handlers.ts`, `test/recents.test.ts`

**Interfaces:**
- Consumes: `RecentFolder` from `shared/types`.
- Produces: `addRecent(path)`, `listRecents(): RecentFolder[]`, `registerRecentsHandlers(ipcMain)`. Store file: `app.getPath('userData')/recents.json`. Max 20 entries, most-recent-first, deduped by path.

- [ ] **Step 1: Write the failing test `test/recents.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { computeRecents } from '../src/main/recents';

describe('computeRecents', () => {
  it('dedupes by path, newest first, caps at 20', () => {
    let list = computeRecents([], 'C:\\a', 1000);
    list = computeRecents(list, 'C:\\b', 2000);
    list = computeRecents(list, 'C:\\a', 3000); // re-open a
    expect(list.map(r => r.path)).toEqual(['C:\\a', 'C:\\b']);
    expect(list[0].lastOpened).toBe(3000);

    let big: typeof list = [];
    for (let i = 0; i < 25; i++) big = computeRecents(big, `C:\\p${i}`, i);
    expect(big.length).toBe(20);
    expect(big[0].path).toBe('C:\\p24');
  });
});
```

- [ ] **Step 2: Run test, verify it fails** — `npx vitest run test/recents.test.ts` → FAIL (computeRecents not defined)

- [ ] **Step 3: Write `src/main/recents.ts`**

```ts
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { app } from 'electron';
import type { RecentFolder } from '../shared/types';

export function computeRecents(prev: RecentFolder[], path: string, now: number): RecentFolder[] {
  const without = prev.filter(r => r.path !== path);
  return [{ path, name: basename(path), lastOpened: now }, ...without].slice(0, 20);
}

const file = () => join(app.getPath('userData'), 'recents.json');

export function listRecents(): RecentFolder[] {
  try { return existsSync(file()) ? JSON.parse(readFileSync(file(), 'utf8')) : []; }
  catch { return []; }
}

export function addRecent(path: string): void {
  const next = computeRecents(listRecents(), path, Date.now());
  writeFileSync(file(), JSON.stringify(next, null, 2));
}
```

- [ ] **Step 4: Run test, verify it passes** — `npx vitest run test/recents.test.ts` → PASS

- [ ] **Step 5: Write `src/main/recents.handlers.ts`**

```ts
import { ipcMain } from 'electron';
import { CH } from '../shared/ipc';
import { listRecents, addRecent } from './recents';

export function registerRecentsHandlers() {
  ipcMain.handle(CH.recentsList, () => listRecents());
  ipcMain.handle(CH.recentsAdd, (_e, path: string) => addRecent(path));
}
```

- [ ] **Step 6: Commit** — `git add src/main/recents.* test/recents.test.ts && git commit -m "feat: recent folders store"`

---

### Task 1.3: Claude session-store reader

**Files:**
- Create: `src/main/sessions.ts`, `src/main/sessions.handlers.ts`, `test/sessions.test.ts`

**Interfaces:**
- Consumes: `ClaudeSession` from `shared/types`.
- Produces: `slugForPath(path): string`, `listSessions(path): Promise<ClaudeSession[]>`, `registerSessionsHandlers()`. Reads `~/.claude/projects/<slug>/*.jsonl`.

- [ ] **Step 1: Write the failing test `test/sessions.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { slugForPath, parseSession } from '../src/main/sessions';

describe('slugForPath', () => {
  it('replaces every non-alphanumeric char with a dash', () => {
    expect(slugForPath('C:\\Users\\danma\\Documents\\Dan\\Projects\\Claude Explorer'))
      .toBe('C--Users-danma-Documents-Dan-Projects-Claude-Explorer');
  });
});

describe('parseSession', () => {
  it('extracts first user prompt as title and newest timestamp', () => {
    const lines = [
      JSON.stringify({ type: 'user', timestamp: '2026-07-20T10:00:00.000Z', message: { role: 'user', content: 'Fix the login bug' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-07-20T10:01:00.000Z', message: { role: 'assistant', content: 'ok' } }),
    ].join('\n');
    const s = parseSession('abc-123', 'C:\\proj', lines, 0);
    expect(s.id).toBe('abc-123');
    expect(s.title).toBe('Fix the login bug');
    expect(s.updated).toBe(Date.parse('2026-07-20T10:01:00.000Z'));
  });

  it('falls back to (untitled) and mtime when no user text present', () => {
    const s = parseSession('x', 'C:\\p', '', 5000);
    expect(s.title).toBe('(untitled)');
    expect(s.updated).toBe(5000);
  });
});
```

- [ ] **Step 2: Run test, verify it fails** — `npx vitest run test/sessions.test.ts` → FAIL

- [ ] **Step 3: Write `src/main/sessions.ts`**

```ts
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ClaudeSession } from '../shared/types';

export function slugForPath(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-');
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const t = content.find((b: any) => b?.type === 'text');
    return t?.text ?? '';
  }
  return '';
}

export function parseSession(id: string, folderPath: string, jsonl: string, mtime: number): ClaudeSession {
  let title = '';
  let updated = 0;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
    if (!Number.isNaN(ts)) updated = Math.max(updated, ts);
    if (!title && obj.type === 'user' && obj.message?.role === 'user') {
      const t = textOf(obj.message.content).trim();
      if (t && !t.startsWith('<')) title = t.slice(0, 80);
    }
  }
  return { id, folderPath, title: title || '(untitled)', updated: updated || mtime };
}

export async function listSessions(folderPath: string): Promise<ClaudeSession[]> {
  const dir = join(homedir(), '.claude', 'projects', slugForPath(folderPath));
  let files: string[];
  try { files = (await readdir(dir)).filter(f => f.endsWith('.jsonl')); }
  catch { return []; }
  const out = await Promise.all(files.map(async (f) => {
    const full = join(dir, f);
    const [jsonl, st] = await Promise.all([readFile(full, 'utf8').catch(() => ''), stat(full)]);
    return parseSession(f.replace(/\.jsonl$/, ''), folderPath, jsonl, st.mtimeMs);
  }));
  return out.sort((a, b) => b.updated - a.updated);
}
```

- [ ] **Step 4: Run test, verify it passes** — `npx vitest run test/sessions.test.ts` → PASS

- [ ] **Step 5: Write `src/main/sessions.handlers.ts`**

```ts
import { ipcMain } from 'electron';
import { CH } from '../shared/ipc';
import { listSessions } from './sessions';

export function registerSessionsHandlers() {
  ipcMain.handle(CH.sessionsList, (_e, path: string) => listSessions(path));
}
```

- [ ] **Step 6: Commit** — `git add src/main/sessions.* test/sessions.test.ts && git commit -m "feat: claude session-store reader"`

---

### Task 1.4: External terminal launcher

**Files:**
- Create: `src/main/external.ts`, `src/main/external.handlers.ts`

**Interfaces:**
- Produces: `openExternalTerminal(path): void`, `registerExternalHandlers()`. Prefers Windows Terminal, falls back to PowerShell. Passes path as argv (never a shell-concatenated string) to survive spaces.

- [ ] **Step 1: Write `src/main/external.ts`**

```ts
import { spawn } from 'node:child_process';

// ponytail: assumes `claude` is on PATH in the spawned shell; add a config override if not.
export function openExternalTerminal(path: string): void {
  // Windows Terminal: -d sets the start dir; run claude in a persistent PowerShell.
  try {
    const wt = spawn('wt.exe', ['-d', path, 'powershell', '-NoExit', '-Command', 'claude'], {
      detached: true, stdio: 'ignore',
    });
    wt.on('error', () => fallback(path));
    wt.unref();
  } catch {
    fallback(path);
  }
}

function fallback(path: string): void {
  const ps = spawn('powershell', ['-NoExit', '-Command', `Set-Location -LiteralPath '${path.replace(/'/g, "''")}'; claude`], {
    detached: true, stdio: 'ignore', shell: false,
  });
  ps.unref();
}
```

- [ ] **Step 2: Write `src/main/external.handlers.ts`**

```ts
import { ipcMain } from 'electron';
import { CH } from '../shared/ipc';
import { openExternalTerminal } from './external';

export function registerExternalHandlers() {
  ipcMain.handle(CH.externalOpen, (_e, path: string) => openExternalTerminal(path));
}
```

- [ ] **Step 3: Manual check + commit**

Manual: from a scratch script, call `openExternalTerminal(process.cwd())` and confirm a Windows Terminal window opens running claude. Then:
`git add src/main/external.* && git commit -m "feat: external terminal launcher"`

---

### Task 1.5: Pty manager (embedded terminal backend)

**Files:**
- Create: `src/main/pty.ts`, `src/main/pty.handlers.ts`

**Interfaces:**
- Produces: `PtyManager` with `spawn({path, resumeId})->ptyId`, `write(id,data)`, `resize(id,cols,rows)`, `kill(id)`, and emits `data`/`exit` per id. `registerPtyHandlers(getWindow)`.
- Consumes: `CH` from `shared/ipc`. Emits `CH.ptyData` / `CH.ptyExit` to the renderer via `webContents.send`.

- [ ] **Step 1: Write `src/main/pty.ts`**

```ts
import * as pty from 'node-pty';
import { randomUUID } from 'node:crypto';

type Handle = { proc: pty.IPty };

export class PtyManager {
  private handles = new Map<string, Handle>();

  spawn(opts: { path: string; resumeId?: string }, onData: (id: string, d: string) => void, onExit: (id: string, code: number) => void): string {
    const id = randomUUID();
    // claude launched directly (no shell wrapper) so exit closes the tab cleanly.
    const args = opts.resumeId ? ['--resume', opts.resumeId] : [];
    const proc = pty.spawn('claude', args, {
      name: 'xterm-color',
      cwd: opts.path,
      cols: 80,
      rows: 24,
      env: process.env as Record<string, string>,
    });
    proc.onData((d) => onData(id, d));
    proc.onExit(({ exitCode }) => { onExit(id, exitCode); this.handles.delete(id); });
    this.handles.set(id, { proc });
    return id;
  }

  write(id: string, data: string) { this.handles.get(id)?.proc.write(data); }
  resize(id: string, cols: number, rows: number) { this.handles.get(id)?.proc.resize(cols, rows); }
  kill(id: string) { this.handles.get(id)?.proc.kill(); this.handles.delete(id); }
}
```

- [ ] **Step 2: Write `src/main/pty.handlers.ts`**

```ts
import { ipcMain, BrowserWindow } from 'electron';
import { CH } from '../shared/ipc';
import { PtyManager } from './pty';

export function registerPtyHandlers(getWindow: () => BrowserWindow | null) {
  const mgr = new PtyManager();
  const send = (ch: string, ...args: unknown[]) => getWindow()?.webContents.send(ch, ...args);

  ipcMain.handle(CH.ptySpawn, (_e, opts: { path: string; resumeId?: string }) =>
    mgr.spawn(opts, (id, d) => send(CH.ptyData, id, d), (id, code) => send(CH.ptyExit, id, code)));
  ipcMain.on(CH.ptyWrite, (_e, id: string, data: string) => mgr.write(id, data));
  ipcMain.on(CH.ptyResize, (_e, id: string, cols: number, rows: number) => mgr.resize(id, cols, rows));
  ipcMain.on(CH.ptyKill, (_e, id: string) => mgr.kill(id));
}
```

- [ ] **Step 3: Manual check + commit**

Manual: after Phase 3 wiring, spawn a pty on a known folder and confirm claude starts and echoes input. For now: `git add src/main/pty.* && git commit -m "feat: embedded pty manager"`

**Note:** `node-pty` is a native module but ships **prebuilt N-API binaries** (`node_modules/node-pty/prebuilds/win32-x64/pty.node`, verified present on this machine). N-API is ABI-stable across Node and Electron, so it should load in Electron with NO compilation, NO Python, NO MSVC. Only if `npm run dev` throws an ABI/`NODE_MODULE_VERSION` error (unexpected) fall back to `npx electron-rebuild -f -w node-pty` (electron-rebuild is already in devDeps).

---

## Phase 2 — Renderer (parallelizable after Phase 0)

### Task 2.1: Preload bridge

**Files:**
- Create/replace: `src/preload/index.ts`

**Interfaces:**
- Produces: `window.api` implementing the `Api` interface from `shared/ipc`.

- [ ] **Step 1: Write `src/preload/index.ts`**

```ts
import { contextBridge, ipcRenderer } from 'electron';
import { CH } from '../shared/ipc';
import type { Api } from '../shared/ipc';

const api: Api = {
  fsList: (p) => ipcRenderer.invoke(CH.fsList, p),
  fsHome: () => ipcRenderer.invoke(CH.fsHome),
  recentsList: () => ipcRenderer.invoke(CH.recentsList),
  recentsAdd: (p) => ipcRenderer.invoke(CH.recentsAdd, p),
  sessionsList: (p) => ipcRenderer.invoke(CH.sessionsList, p),
  externalOpen: (p) => ipcRenderer.invoke(CH.externalOpen, p),
  ptySpawn: (o) => ipcRenderer.invoke(CH.ptySpawn, o),
  ptyWrite: (id, d) => ipcRenderer.send(CH.ptyWrite, id, d),
  ptyResize: (id, c, r) => ipcRenderer.send(CH.ptyResize, id, c, r),
  ptyKill: (id) => ipcRenderer.send(CH.ptyKill, id),
  onPtyData: (cb) => {
    const h = (_e: unknown, id: string, d: string) => cb(id, d);
    ipcRenderer.on(CH.ptyData, h);
    return () => ipcRenderer.off(CH.ptyData, h);
  },
  onPtyExit: (cb) => {
    const h = (_e: unknown, id: string, c: number) => cb(id, c);
    ipcRenderer.on(CH.ptyExit, h);
    return () => ipcRenderer.off(CH.ptyExit, h);
  },
};

contextBridge.exposeInMainWorld('api', api);
```

- [ ] **Step 2: Add global typing** — create `src/renderer/global.d.ts`:
```ts
import type { Api } from '../shared/ipc';
declare global { interface Window { api: Api } }
```

- [ ] **Step 3: Commit** — `git add src/preload/index.ts src/renderer/global.d.ts && git commit -m "feat: preload api bridge"`

---

### Task 2.2: Tab model + App shell

**Files:**
- Create: `src/renderer/tabs.ts`, `src/renderer/App.tsx`

**Interfaces:**
- Produces: tab state where each tab is `{ id, view: 'files'|'terminal', cwd, ptyId? }`. App renders a tab bar (`+` adds a files tab at home dir), the active tab's view, and the RecentMenu. Converting a files tab to terminal mutates that same tab in place.
- Consumes: `window.api`, `FileBrowser`, `Terminal`, `RecentMenu`.

- [ ] **Step 1: Write `src/renderer/tabs.ts`**

```ts
import { randomUUID } from 'crypto'; // ponytail: use crypto.randomUUID() in browser; see step note

export interface Tab {
  id: string;
  view: 'files' | 'terminal';
  cwd: string;
  ptyId?: string;
  title: string;
}

export function newFilesTab(cwd: string): Tab {
  return { id: crypto.randomUUID(), view: 'files', cwd, title: cwd.split(/[\\/]/).pop() || cwd };
}
```
Note: browsers expose `crypto.randomUUID()` globally — drop the `import`. Keep the helper pure so it's trivially testable.

- [ ] **Step 2: Write `src/renderer/App.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { newFilesTab, type Tab } from './tabs';
import { FileBrowser } from './components/FileBrowser';
import { Terminal } from './components/Terminal';
import { RecentMenu } from './components/RecentMenu';

export function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string>('');

  useEffect(() => {
    window.api.fsHome().then((home) => {
      const t = newFilesTab(home);
      setTabs([t]); setActive(t.id);
    });
  }, []);

  const update = (id: string, patch: Partial<Tab>) =>
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  const addTab = async () => {
    const home = await window.api.fsHome();
    const t = newFilesTab(home);
    setTabs((ts) => [...ts, t]); setActive(t.id);
  };

  const closeTab = (id: string) => {
    const t = tabs.find((x) => x.id === id);
    if (t?.ptyId) window.api.ptyKill(t.ptyId);
    setTabs((ts) => ts.filter((x) => x.id !== id));
  };

  const openClaude = async (id: string, cwd: string, resumeId?: string) => {
    await window.api.recentsAdd(cwd);
    const ptyId = await window.api.ptySpawn({ path: cwd, resumeId });
    update(id, { view: 'terminal', cwd, ptyId, title: cwd.split(/[\\/]/).pop() || cwd });
  };

  const activeTab = tabs.find((t) => t.id === active);

  return (
    <div className="app">
      <div className="tabbar">
        <RecentMenu onOpen={(p, resumeId) => activeTab && openClaude(activeTab.id, p, resumeId)} onOpenFolder={(p) => { const t = newFilesTab(p); setTabs((ts)=>[...ts,t]); setActive(t.id); }} />
        {tabs.map((t) => (
          <button key={t.id} className={t.id === active ? 'tab active' : 'tab'} onClick={() => setActive(t.id)}>
            {t.view === 'terminal' ? '▶ ' : '📁 '}{t.title}
            <span className="close" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}>×</span>
          </button>
        ))}
        <button className="tab add" onClick={addTab}>+</button>
      </div>
      <div className="content">
        {activeTab?.view === 'files' && (
          <FileBrowser
            cwd={activeTab.cwd}
            onNavigate={(p) => update(activeTab.id, { cwd: p, title: p.split(/[\\/]/).pop() || p })}
            onOpenClaude={(p) => openClaude(activeTab.id, p)}
            onOpenExternal={(p) => window.api.externalOpen(p)}
          />
        )}
        {activeTab?.view === 'terminal' && activeTab.ptyId && (
          <Terminal ptyId={activeTab.ptyId} />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit** — `git add src/renderer/tabs.ts src/renderer/App.tsx && git commit -m "feat: tab shell with per-tab view switching"`

---

### Task 2.3: FileBrowser + Breadcrumb + ContextMenu

**Files:**
- Create: `src/renderer/components/FileBrowser.tsx`, `Breadcrumb.tsx`, `ContextMenu.tsx`

**Interfaces:**
- Consumes: `window.api.fsList`, `DirEntry`. Props: `{ cwd, onNavigate(path), onOpenClaude(path), onOpenExternal(path) }`.
- Behavior: lists `cwd`; double-click folder → `onNavigate`; Enter on a selected folder or the current folder → `onOpenClaude`; right-click folder → context menu with "Open in Claude" / "Open in external terminal" / "Open folder". Breadcrumb segments navigate up.

- [ ] **Step 1: Write `Breadcrumb.tsx`**

```tsx
export function Breadcrumb({ cwd, onNavigate }: { cwd: string; onNavigate: (p: string) => void }) {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  const sep = cwd.includes('\\') ? '\\' : '/';
  return (
    <div className="breadcrumb">
      {parts.map((seg, i) => (
        <span key={i} className="crumb" onClick={() => onNavigate(parts.slice(0, i + 1).join(sep))}>{seg}{sep}</span>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Write `ContextMenu.tsx`**

```tsx
export interface MenuItem { label: string; onClick: () => void }
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  return (
    <div className="ctx-backdrop" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <ul className="ctx-menu" style={{ left: x, top: y }} onClick={(e) => e.stopPropagation()}>
        {items.map((it, i) => (
          <li key={i} onClick={() => { it.onClick(); onClose(); }}>{it.label}</li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 3: Write `FileBrowser.tsx`**

```tsx
import { useEffect, useState } from 'react';
import type { DirEntry } from '../../shared/types';
import { Breadcrumb } from './Breadcrumb';
import { ContextMenu, type MenuItem } from './ContextMenu';

export function FileBrowser({ cwd, onNavigate, onOpenClaude, onOpenExternal }: {
  cwd: string; onNavigate: (p: string) => void; onOpenClaude: (p: string) => void; onOpenExternal: (p: string) => void;
}) {
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  useEffect(() => { window.api.fsList(cwd).then(setEntries).catch(() => setEntries([])); }, [cwd]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Enter') onOpenClaude(sel ?? cwd); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [sel, cwd, onOpenClaude]);

  const folderMenu = (p: string): MenuItem[] => [
    { label: 'Open in Claude', onClick: () => onOpenClaude(p) },
    { label: 'Open in external terminal', onClick: () => onOpenExternal(p) },
    { label: 'Open folder', onClick: () => onNavigate(p) },
  ];

  return (
    <div className="filebrowser">
      <div className="toolbar">
        <Breadcrumb cwd={cwd} onNavigate={onNavigate} />
        <button onClick={() => onOpenClaude(cwd)}>Open this folder in Claude</button>
      </div>
      <ul className="entries">
        {entries.map((e) => (
          <li
            key={e.path}
            className={e.path === sel ? 'entry selected' : 'entry'}
            onClick={() => setSel(e.path)}
            onDoubleClick={() => e.isDirectory ? onNavigate(e.path) : undefined}
            onContextMenu={(ev) => { if (e.isDirectory) { ev.preventDefault(); setSel(e.path); setMenu({ x: ev.clientX, y: ev.clientY, items: folderMenu(e.path) }); } }}
          >
            {e.isDirectory ? '📁' : '📄'} {e.name}
          </li>
        ))}
      </ul>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
```

- [ ] **Step 4: Commit** — `git add src/renderer/components/{FileBrowser,Breadcrumb,ContextMenu}.tsx && git commit -m "feat: file browser with open-in-claude"`

---

### Task 2.4: Embedded Terminal (xterm) + RecentMenu

**Files:**
- Create: `src/renderer/components/Terminal.tsx`, `src/renderer/components/RecentMenu.tsx`

**Interfaces:**
- `Terminal` props: `{ ptyId }`. Binds an xterm instance to that pty over `window.api` (`onPtyData`, `ptyWrite`, `ptyResize`), fits on resize.
- `RecentMenu` props: `{ onOpen(path, resumeId?), onOpenFolder(path) }`. Dropdown listing recent folders (`recentsList`); expanding a folder lists its sessions (`sessionsList`) — clicking a session calls `onOpen(path, session.id)` (resume), clicking the folder header calls `onOpen(path)` (new session) or `onOpenFolder` to just browse it.

- [ ] **Step 1: Write `Terminal.tsx`**

```tsx
import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export function Terminal({ ptyId }: { ptyId: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const term = new XTerm({ cursorBlink: true, fontFamily: 'Cascadia Mono, Consolas, monospace', fontSize: 13 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);
    fit.fit();

    const offData = window.api.onPtyData((id, d) => { if (id === ptyId) term.write(d); });
    const offExit = window.api.onPtyExit((id) => { if (id === ptyId) term.write('\r\n[session ended]\r\n'); });
    term.onData((d) => window.api.ptyWrite(ptyId, d));

    const resize = () => { fit.fit(); window.api.ptyResize(ptyId, term.cols, term.rows); };
    const ro = new ResizeObserver(resize);
    ro.observe(ref.current);
    resize();

    return () => { offData(); offExit(); ro.disconnect(); term.dispose(); };
  }, [ptyId]);

  return <div className="terminal" ref={ref} style={{ width: '100%', height: '100%' }} />;
}
```

- [ ] **Step 2: Write `RecentMenu.tsx`**

```tsx
import { useState } from 'react';
import type { RecentFolder, ClaudeSession } from '../../shared/types';

export function RecentMenu({ onOpen, onOpenFolder }: {
  onOpen: (path: string, resumeId?: string) => void;
  onOpenFolder: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [recents, setRecents] = useState<RecentFolder[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);

  const toggle = async () => {
    if (!open) setRecents(await window.api.recentsList());
    setOpen(!open);
  };

  const expand = async (path: string) => {
    setExpanded(path);
    setSessions(await window.api.sessionsList(path));
  };

  return (
    <div className="recentmenu">
      <button onClick={toggle}>Open Recent ▾</button>
      {open && (
        <ul className="recent-list">
          {recents.length === 0 && <li className="empty">No recent folders</li>}
          {recents.map((r) => (
            <li key={r.path}>
              <div className="recent-row">
                <span onClick={() => { onOpenFolder(r.path); setOpen(false); }}>{r.name}</span>
                <button onClick={() => onOpen(r.path)}>New</button>
                <button onClick={() => expand(r.path)}>Sessions</button>
              </div>
              {expanded === r.path && (
                <ul className="session-list">
                  {sessions.length === 0 && <li className="empty">No sessions</li>}
                  {sessions.map((s) => (
                    <li key={s.id} onClick={() => { onOpen(r.path, s.id); setOpen(false); }}>
                      {s.title} <span className="ts">{new Date(s.updated).toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Commit** — `git add src/renderer/components/{Terminal,RecentMenu}.tsx && git commit -m "feat: embedded terminal and recent/session menu"`

---

## Phase 3 — Integration + packaging (after Phase 1 & 2)

### Task 3.1: Wire handlers into main, verify end-to-end

**Files:**
- Modify: `src/main/index.ts`, `src/renderer/main.tsx`, `src/renderer/index.css`

**Interfaces:**
- Consumes: every `register*Handlers` from Phase 1, `App` from Phase 2.

- [ ] **Step 1: Register all handlers in `src/main/index.ts`**

In `app.whenReady()`, after creating the window:
```ts
import { registerFsHandlers } from './fs.handlers';
import { registerRecentsHandlers } from './recents.handlers';
import { registerSessionsHandlers } from './sessions.handlers';
import { registerExternalHandlers } from './external.handlers';
import { registerPtyHandlers } from './pty.handlers';

let mainWindow: BrowserWindow | null = null;
// ...after createWindow assigns mainWindow...
registerFsHandlers();
registerRecentsHandlers();
registerSessionsHandlers();
registerExternalHandlers();
registerPtyHandlers(() => mainWindow);
```

- [ ] **Step 2: Mount App in `src/renderer/main.tsx`**
```tsx
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';
createRoot(document.getElementById('root')!).render(<App />);
```

- [ ] **Step 3: Minimal styling in `index.css`** — tab bar as a horizontal flex row, `.content` fills remaining height, context menu `position: fixed`, entries list scrollable. (Author concrete CSS; keep it under ~80 lines.)

- [ ] **Step 4: Rebuild native module if needed**

If `npm run dev` throws a node-pty ABI error:
```bash
npm install -D electron-rebuild
npx electron-rebuild -f -w node-pty
```

- [ ] **Step 5: End-to-end manual test**

Run `npm run dev`. Verify: (a) home dir lists; (b) double-click navigates; (c) breadcrumb goes up; (d) right-click folder → "Open in Claude" converts the tab to a live claude terminal; (e) `+` adds a files tab; tabs switch independently; (f) "Open Recent" shows the just-opened folder; expanding it lists sessions; clicking one resumes (`claude --resume`); (g) right-click → external terminal opens Windows Terminal.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: wire main handlers and renderer, e2e working"`

---

### Task 3.2: Package as Windows app

**Files:**
- Modify: `package.json` (electron-builder config), create `electron-builder.yml` if preferred.

- [ ] **Step 1: Add electron-builder**
```bash
npm install -D electron-builder
```

- [ ] **Step 2: Config `win` target** in `package.json`:
```json
"build": {
  "appId": "com.danma.claude-explorer",
  "productName": "Claude Explorer",
  "win": { "target": "nsis" },
  "files": ["out/**/*", "resources/**/*"],
  "asarUnpack": ["**/node_modules/node-pty/**"]
}
```
`asarUnpack` for node-pty is required — its native `.node` binary can't run from inside asar.

- [ ] **Step 3: Build + smoke test**
```bash
npm run package
```
Run the produced installer from `dist/`, launch the installed app, repeat the Task 3.1 Step 5 checks.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "chore: windows packaging via electron-builder"`

---

## Self-Review Notes

- **Spec coverage:** browse+navigate (2.3), open-in-Claude embedded (1.5/2.4/2.2), external option (1.4/2.3), per-tab files|terminal model with concurrent sessions (2.2), Open Recent = folders + parsed sessions (1.2/1.3/2.4), resume via `--resume` (2.2/2.4). All covered.
- **Frozen contract:** `shared/ipc.ts` defined once in 0.2; Phase 1/2 only import it. If a task discovers a missing channel, it stops and flags for a contract amendment rather than editing in parallel.
- **Native module risk:** node-pty ABI + asar are the two known Electron footguns; both are called out with fixes (3.1 step 4, 3.2 step 2).
- **Type consistency:** `ptyId: string` everywhere; `ClaudeSession.id` = jsonl basename; `slugForPath` single source of truth.
