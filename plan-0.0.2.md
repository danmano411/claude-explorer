# Claude Explorer v0.0.2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add six workflow refinements to the tab/terminal experience: open-recent-in-new-tab, Ctrl/Shift+Enter newline in the embedded terminal, a live Claude-session status indicator, a tab right-click menu (rename / open in Explorer / open terminal / open in IDE), first-class in-app shell terminal tabs, and a direction-correct tab-drag drop indicator.

**Architecture:** Extend the frozen IPC contract once (V0), then fan out. The main process gains shell-PTY spawning, an IDE launcher, and a tiny settings store. The renderer gains a global PTY-status hook, a pure tab-reorder helper, a tab context menu, a settings modal, and small edits to `App.tsx`, `TabBar.tsx`, and `Terminal.tsx`. UI files with shared prop seams are decoupled by freezing their interfaces in this plan.

**Tech Stack:** Electron + electron-vite · React + TypeScript · node-pty · @xterm/xterm · Vitest.

## Global Constraints

- **Windows-only.** All paths, shells, and launch commands target win32.
- **Frozen IPC contract.** `src/shared/ipc.ts` is extended ONLY in Task V0. No other task edits it. Every channel needs: `CH` constant, `Api` method, preload binding, main handler — all four or none.
- **contextIsolation stays on.** Renderer reaches main only through `window.api`. Never add `nodeIntegration`.
- **No new runtime dependencies.** Use node stdlib (`child_process`), electron `shell`, and already-installed packages only.
- **Retro Claude design tokens.** Reuse existing CSS custom properties (`--clay`, `--ink`, `--ink-soft`, `--bg-panel`, `--bg`, etc.). New UI must not introduce a second palette.
- **Tests run with the ESM-require flag.** `npm test` already sets `NODE_OPTIONS=--experimental-require-module`. New tests live in `test/*.test.ts` and must pass under it.
- **Version bump.** `package.json` `version` → `0.0.2` (done in the final task, not scattered).
- **PTY data event is global.** Main broadcasts `pty:data`/`pty:exit` to the window for ALL ptyIds; renderer consumers filter by id. Do not change this contract.

---

## File Map

**Contract (V0):**
- Modify: `src/shared/ipc.ts` — extend `ptySpawn` opts; add `ideOpen`, `settingsGet`, `settingsSet`.
- Modify: `src/shared/types.ts` — add `Settings`, `PtyStatus`.
- Modify: `src/preload/index.ts` — bind the three new methods + updated `ptySpawn`.

**Main process (parallel after V0):**
- Modify: `src/main/pty.ts` — shell-vs-claude branch in `spawn`.
- Create: `src/main/settings.ts`, `src/main/settings.handlers.ts` — JSON settings store.
- Create: `src/main/ide.ts`, `src/main/ide.handlers.ts` — launch configured IDE.
- Modify: `src/main/index.ts` — register the two new handler groups.

**Renderer pure logic (parallel after V0):**
- Create: `src/renderer/tabreorder.ts` (+ `test/tabreorder.test.ts`) — drop-index math.
- Create: `src/renderer/ptystatus.ts` (+ `test/ptystatus.test.ts`) — status reducer + `usePtyStatus` hook.

**Renderer UI (after pure logic + main):**
- Modify: `src/renderer/tabs.ts` — extend `Tab`; add `newTerminalTab`.
- Modify: `src/renderer/App.tsx` — new-tab launches, shell tabs, rename state, tab-menu callbacks, status hook, settings modal mount.
- Modify: `src/renderer/TabBar.tsx` — status dot, tab context menu, direction-aware drop indicator, inline rename.
- Modify: `src/renderer/components/Terminal.tsx` — Ctrl/Shift+Enter newline.
- Create: `src/renderer/components/SettingsModal.tsx` — IDE-command config form.
- Modify: `src/renderer/index.css` — status dot, drop-left/right borders, tab ctx menu, settings modal, shell-tab icon.

---

## Task V0: Extend the IPC contract (LINEAR — blocks all main/UI tasks)

**Model:** sonnet

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/ipc.ts`
- Modify: `src/preload/index.ts`

**Interfaces produced (every later task consumes these):**

- [ ] **Step 1:** In `src/shared/types.ts`, append:

```ts
export interface Settings {
  ideCommand: string // e.g. "code"; launched as `<ideCommand> <folder>`
}

export type PtyStatus = 'running' | 'waiting' | 'stopped'
```

- [ ] **Step 2:** In `src/shared/ipc.ts`, add to `CH`:

```ts
  ideOpen: 'ide:open',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
```

- [ ] **Step 3:** In `src/shared/ipc.ts`, import `Settings` and change the `ptySpawn` signature + add three methods on `Api`:

```ts
import type { DirEntry, RecentFolder, ClaudeSession, TrashRecord, Settings } from './types'
// ...
  ptySpawn(opts: { path: string; resumeId?: string; shell?: boolean }): Promise<string>
  // ...append at end of interface:
  ideOpen(path: string): Promise<void>
  settingsGet(): Promise<Settings>
  settingsSet(patch: Partial<Settings>): Promise<Settings> // returns merged settings
```

- [ ] **Step 4:** In `src/preload/index.ts`, add bindings:

```ts
  ideOpen: (p) => ipcRenderer.invoke(CH.ideOpen, p),
  settingsGet: () => ipcRenderer.invoke(CH.settingsGet),
  settingsSet: (patch) => ipcRenderer.invoke(CH.settingsSet, patch),
```

(The existing `ptySpawn: (o) => ipcRenderer.invoke(CH.ptySpawn, o)` binding already forwards the whole opts object — no change needed there.)

- [ ] **Step 5:** Run `npx tsc --noEmit`. Expected: clean (no handlers exist yet, but types compile because preload only references `CH`/`Api`).

- [ ] **Step 6:** Commit: `git commit -am "feat(v0.0.2): extend IPC contract — shell pty, ide launch, settings"`

---

## Task M1: Shell PTY support

**Model:** haiku
**Depends on:** V0

**Files:**
- Modify: `src/main/pty.ts`

**Interfaces:**
- Consumes: `ptySpawn` opts `{ path; resumeId?; shell? }` from V0.
- Produces: when `opts.shell` is true, `spawn` launches PowerShell in `opts.path` instead of Claude.

- [ ] **Step 1:** In `src/main/pty.ts`, at the top of `spawn(...)`, before the Claude-arg logic, branch on shell:

```ts
  spawn(
    opts: { path: string; resumeId?: string; shell?: boolean },
    onData: (id: string, d: string) => void,
    onExit: (id: string, code: number) => void,
  ): string {
    const id = randomUUID()

    // Plain interactive shell tab (feature 5) — no Claude.
    if (opts.shell) {
      let proc: pty.IPty
      try {
        proc = pty.spawn('powershell.exe', ['-NoLogo'], {
          name: 'xterm-color', cwd: opts.path, cols: 80, rows: 24,
          env: process.env as Record<string, string>,
        })
      } catch (err) {
        const msg = `\r\n\x1b[31mFailed to launch shell: ${(err as Error).message}\x1b[0m\r\n`
        queueMicrotask(() => { onData(id, msg); onExit(id, 1) })
        return id
      }
      proc.onData((d) => onData(id, d))
      proc.onExit(({ exitCode }) => { onExit(id, exitCode); this.handles.delete(id) })
      this.handles.set(id, { proc })
      return id
    }

    // ...existing Claude path unchanged, but reuse the `id` already created above:
    const claudeArgs = opts.resumeId ? ['--resume', opts.resumeId] : []
    // ... (delete the old `const id = randomUUID()` line further down)
```

Make sure the original `const id = randomUUID()` that appeared inside the Claude path is removed (it is now created once at the top).

- [ ] **Step 2:** Run `npx tsc --noEmit`. Expected: clean.
- [ ] **Step 3:** Manual sanity (optional, controller may skip): `npm run dev`, right-click a tab → Open Terminal once U-tab work lands. For this task, tsc-clean is the gate.
- [ ] **Step 4:** Commit: `git commit -am "feat(v0.0.2): pty can spawn a plain PowerShell shell"`

---

## Task M2: Settings store + IDE launcher

**Model:** sonnet
**Depends on:** V0

**Files:**
- Create: `src/main/settings.ts`
- Create: `src/main/settings.handlers.ts`
- Create: `src/main/ide.ts`
- Create: `src/main/ide.handlers.ts`
- Modify: `src/main/index.ts` (register both handler groups)

**Interfaces:**
- Consumes: `CH.settingsGet/Set/ideOpen`, `Settings` from V0.
- Produces: `getSettings()`, `setSettings(patch)`, `openInIde(folder)`.

- [ ] **Step 1:** Create `src/main/settings.ts`:

```ts
import { app } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import type { Settings } from '../shared/types'

const DEFAULTS: Settings = { ideCommand: 'code' }
const file = () => join(app.getPath('userData'), 'settings.json')

export function getSettings(): Settings {
  try {
    if (!existsSync(file())) return { ...DEFAULTS }
    return { ...DEFAULTS, ...JSON.parse(readFileSync(file(), 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

export function setSettings(patch: Partial<Settings>): Settings {
  const merged = { ...getSettings(), ...patch }
  writeFileSync(file(), JSON.stringify(merged, null, 2), 'utf8')
  return merged
}
```

- [ ] **Step 2:** Create `src/main/settings.handlers.ts`:

```ts
import { ipcMain } from 'electron'
import { CH } from '../shared/ipc'
import { getSettings, setSettings } from './settings'
import type { Settings } from '../shared/types'

export function registerSettingsHandlers() {
  ipcMain.handle(CH.settingsGet, () => getSettings())
  ipcMain.handle(CH.settingsSet, (_e, patch: Partial<Settings>) => setSettings(patch))
}
```

- [ ] **Step 3:** Create `src/main/ide.ts`:

```ts
import { spawn } from 'node:child_process'
import { getSettings } from './settings'

// Launches the configured IDE against a folder. shell:true resolves .cmd shims
// like VS Code's `code` on Windows. ponytail: assumes the command is on PATH;
// the settings modal is the knob to change it.
export function openInIde(folder: string): void {
  const cmd = getSettings().ideCommand || 'code'
  const child = spawn(cmd, [folder], { detached: true, stdio: 'ignore', shell: true })
  child.unref()
}
```

- [ ] **Step 4:** Create `src/main/ide.handlers.ts`:

```ts
import { ipcMain } from 'electron'
import { CH } from '../shared/ipc'
import { openInIde } from './ide'

export function registerIdeHandlers() {
  ipcMain.handle(CH.ideOpen, (_e, path: string) => openInIde(path))
}
```

- [ ] **Step 5:** In `src/main/index.ts`, import and call both registrars alongside the existing `register*Handlers()` calls:

```ts
import { registerSettingsHandlers } from './settings.handlers'
import { registerIdeHandlers } from './ide.handlers'
// ...where other handlers are registered:
registerSettingsHandlers()
registerIdeHandlers()
```

- [ ] **Step 6:** Run `npx tsc --noEmit`. Expected: clean.
- [ ] **Step 7:** Commit: `git commit -am "feat(v0.0.2): settings store + IDE launcher (main)"`

---

## Task R1: Tab-reorder drop math (pure + tested)

**Model:** haiku
**Depends on:** V0 (only for repo state; logically independent)

**Files:**
- Create: `src/renderer/tabreorder.ts`
- Create: `test/tabreorder.test.ts`

**Interfaces:**
- Produces: `dropIndex(from, over, side)`, `reorder(list, from, insert)`.

- [ ] **Step 1:** Write the failing test `test/tabreorder.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { dropIndex, reorder } from '../src/renderer/tabreorder'

describe('dropIndex', () => {
  it('drops to the right of the target (dragging rightward)', () => {
    expect(dropIndex(0, 2, 'right')).toBe(2) // A onto C-right in [A,B,C,D]
  })
  it('drops to the left of the target (dragging leftward)', () => {
    expect(dropIndex(3, 1, 'left')).toBe(1) // D onto B-left in [A,B,C,D]
  })
  it('drops to the right of an adjacent target', () => {
    expect(dropIndex(0, 1, 'right')).toBe(1)
  })
})

describe('reorder', () => {
  it('moves A to the right of C', () => {
    expect(reorder(['A','B','C','D'], 0, dropIndex(0, 2, 'right'))).toEqual(['B','C','A','D'])
  })
  it('moves D to the left of B', () => {
    expect(reorder(['A','B','C','D'], 3, dropIndex(3, 1, 'left'))).toEqual(['A','D','B','C'])
  })
  it('is a no-op when dropping a tab onto its own right edge neighbor position', () => {
    expect(reorder(['A','B','C'], 1, dropIndex(1, 1, 'left'))).toEqual(['A','B','C'])
  })
})
```

- [ ] **Step 2:** Run `npx vitest run test/tabreorder.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3:** Create `src/renderer/tabreorder.ts`:

```ts
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
```

- [ ] **Step 4:** Run `npx vitest run test/tabreorder.test.ts`. Expected: PASS (6 assertions).
- [ ] **Step 5:** Commit: `git commit -am "feat(v0.0.2): pure tab-reorder drop-index helper + tests"`

---

## Task R2: PTY status reducer + hook

**Model:** sonnet
**Depends on:** V0

**Files:**
- Create: `src/renderer/ptystatus.ts`
- Create: `test/ptystatus.test.ts`

**Interfaces:**
- Consumes: `PtyStatus` from V0; `window.api.onPtyData/onPtyExit`.
- Produces: `usePtyStatus(): Map<string, PtyStatus>` and a pure `applyEvent` used by the hook and the test.

**Design:** A claude/shell PTY is `running` while it emits output, flips to `waiting` after `IDLE_MS` of silence (Claude is at a prompt / asking a question), and becomes `stopped` on exit. The reducer is pure and timer-free so it is unit-testable; the hook wires the timers. Only status *transitions* call `setState` (data fires constantly) to avoid render storms.

- [ ] **Step 1:** Write the failing test `test/ptystatus.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { applyEvent } from '../src/renderer/ptystatus'

describe('applyEvent', () => {
  it('marks a pty running on data', () => {
    const m = applyEvent(new Map(), { id: 'a', kind: 'data' })
    expect(m.get('a')).toBe('running')
  })
  it('marks waiting on idle', () => {
    let m = applyEvent(new Map(), { id: 'a', kind: 'data' })
    m = applyEvent(m, { id: 'a', kind: 'idle' })
    expect(m.get('a')).toBe('waiting')
  })
  it('marks stopped on exit and idle cannot revive it', () => {
    let m = applyEvent(new Map(), { id: 'a', kind: 'exit' })
    expect(m.get('a')).toBe('stopped')
    m = applyEvent(m, { id: 'a', kind: 'idle' })
    expect(m.get('a')).toBe('stopped')
  })
  it('returns the same Map reference when status is unchanged', () => {
    const m1 = applyEvent(new Map(), { id: 'a', kind: 'data' })
    const m2 = applyEvent(m1, { id: 'a', kind: 'data' })
    expect(m2).toBe(m1) // no transition -> no new map -> no re-render
  })
})
```

- [ ] **Step 2:** Run `npx vitest run test/ptystatus.test.ts`. Expected: FAIL.

- [ ] **Step 3:** Create `src/renderer/ptystatus.ts`:

```ts
import { useEffect, useRef, useState } from 'react'
import type { PtyStatus } from '../shared/types'

export const IDLE_MS = 700

type Event = { id: string; kind: 'data' | 'idle' | 'exit' }

// Pure transition. Returns the SAME map reference when nothing changes so the
// hook can skip re-rendering on the (very frequent) data events.
export function applyEvent(prev: Map<string, PtyStatus>, ev: Event): Map<string, PtyStatus> {
  const cur = prev.get(ev.id)
  if (cur === 'stopped') return prev // terminal state
  const next: PtyStatus | undefined =
    ev.kind === 'exit' ? 'stopped' : ev.kind === 'data' ? 'running' : 'waiting'
  if (next === cur) return prev
  const m = new Map(prev)
  m.set(ev.id, next!)
  return m
}

export function usePtyStatus(): Map<string, PtyStatus> {
  const [map, setMap] = useState<Map<string, PtyStatus>>(new Map())
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    const bump = (id: string) => {
      const t = timers.current.get(id)
      if (t) clearTimeout(t)
      timers.current.set(id, setTimeout(() => setMap((m) => applyEvent(m, { id, kind: 'idle' })), IDLE_MS))
    }
    const offData = window.api.onPtyData((id) => {
      setMap((m) => applyEvent(m, { id, kind: 'data' }))
      bump(id)
    })
    const offExit = window.api.onPtyExit((id) => {
      const t = timers.current.get(id)
      if (t) { clearTimeout(t); timers.current.delete(id) }
      setMap((m) => applyEvent(m, { id, kind: 'exit' }))
    })
    return () => {
      offData(); offExit()
      timers.current.forEach(clearTimeout); timers.current.clear()
    }
  }, [])

  return map
}
```

- [ ] **Step 4:** Run `npx vitest run test/ptystatus.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit: `git commit -am "feat(v0.0.2): pty status reducer + usePtyStatus hook + tests"`

---

## Task U1: Tab model + `newTerminalTab`

**Model:** haiku
**Depends on:** V0

**Files:**
- Modify: `src/renderer/tabs.ts`

**Interfaces produced (App + TabBar consume):**

- [ ] **Step 1:** Replace `src/renderer/tabs.ts` with:

```ts
export interface Tab {
  id: string
  view: 'files' | 'terminal'
  cwd: string
  ptyId?: string
  title: string
  terminalKind?: 'claude' | 'shell' // set when view === 'terminal'
  renamed?: boolean // user set a custom title; suppress auto-title-on-navigate
}

const base = (cwd: string) => cwd.split(/[\\/]/).pop() || cwd

export function newFilesTab(cwd: string): Tab {
  return { id: crypto.randomUUID(), view: 'files', cwd, title: base(cwd) }
}

export function newTerminalTab(
  cwd: string, kind: 'claude' | 'shell', ptyId: string, title: string,
): Tab {
  return { id: crypto.randomUUID(), view: 'terminal', cwd, ptyId, terminalKind: kind, title }
}
```

- [ ] **Step 2:** Run `npx tsc --noEmit`. Expected: errors in `App.tsx`/`TabBar.tsx` are OK for now (they change in U2/U3); `tabs.ts` itself must be clean.
- [ ] **Step 3:** Commit: `git commit -am "feat(v0.0.2): Tab gains terminalKind + newTerminalTab helper"`

---

## Task U2: App integration — new-tab launches, shell tabs, rename, tab-menu callbacks, status, settings

**Model:** sonnet
**Depends on:** U1, R1 (reorder), R2 (usePtyStatus), M2 (settings/ide api via window.api), U4 (SettingsModal — freeze its props below)

**Files:**
- Modify: `src/renderer/App.tsx`

**Frozen prop contracts this task defines (U3 TabBar and U4 SettingsModal consume verbatim):**

```ts
// TabBar props (U3 implements against this):
interface TabBarProps {
  tabs: Tab[]
  activeId: string
  status: Map<string, PtyStatus>
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onAdd: () => void
  onReorder: (from: number, insert: number) => void // insert index is post-splice (from R1)
  onRename: (id: string, title: string) => void
  onOpenExplorer: (id: string) => void
  onOpenTerminal: (id: string) => void
  onOpenIde: (id: string) => void
  recentMenu: ReactNode
}

// SettingsModal props (U4 implements against this):
interface SettingsModalProps { onClose: () => void }
```

- [ ] **Step 1:** Update `App.tsx`. Key changes (keep existing structure, apply these deltas):

Imports:
```tsx
import { newFilesTab, newTerminalTab, type Tab } from './tabs'
import { reorder } from './tabreorder'
import { usePtyStatus } from './ptystatus'
import { SettingsModal } from './components/SettingsModal'
```

State + hook:
```tsx
  const status = usePtyStatus()
  const [showSettings, setShowSettings] = useState(false)
```

Feature 1 — Open Recent opens a NEW tab (do not override current):
```tsx
  const openClaudeNewTab = async (cwd: string, resumeId?: string) => {
    await window.api.recentsAdd(cwd)
    const ptyId = await window.api.ptySpawn({ path: cwd, resumeId })
    const t = newTerminalTab(cwd, 'claude', ptyId, cwd.split(/[\\/]/).pop() || cwd)
    setTabs((ts) => [...ts, t]); selectTab(t.id)
  }
```

Feature 5 — open a shell terminal tab at a folder:
```tsx
  const openShellTab = async (cwd: string) => {
    const ptyId = await window.api.ptySpawn({ path: cwd, shell: true })
    const t = newTerminalTab(cwd, 'shell', ptyId, 'Terminal')
    setTabs((ts) => [...ts, t]); selectTab(t.id)
  }
```

Feature 4 callbacks (resolve the tab's cwd, then act):
```tsx
  const cwdOf = (id: string) => tabs.find((t) => t.id === id)?.cwd
  const onOpenExplorer = (id: string) => { const p = cwdOf(id); if (p) window.api.openPath(p) }
  const onOpenTerminal = (id: string) => { const p = cwdOf(id); if (p) openShellTab(p) }
  const onOpenIde = (id: string) => { const p = cwdOf(id); if (p) window.api.ideOpen(p) }
  const onRename = (id: string, title: string) =>
    update(id, { title: title.trim() || (cwdOf(id)?.split(/[\\/]/).pop() ?? 'Tab'), renamed: true })
```

Reorder now takes an insert index:
```tsx
  const reorderTabs = (from: number, insert: number) =>
    setTabs((ts) => reorder(ts, from, insert))
```

Guard files-tab auto-title against a user rename (in the FileBrowser `onNavigate`):
```tsx
            onNavigate={(p) =>
              update(activeTab.id, {
                cwd: p,
                ...(activeTab.renamed ? {} : { title: p.split(/[\\/]/).pop() || p }),
              })
            }
```

Wire RecentMenu to the NEW-tab launcher (feature 1):
```tsx
          <RecentMenu
            onOpen={(p, resumeId) => openClaudeNewTab(p, resumeId)}
            onOpenFolder={openFolderTab}
          />
```

Pass the new props to `<TabBar>`:
```tsx
      <TabBar
        tabs={tabs}
        activeId={active}
        status={status}
        onSelect={selectTab}
        onClose={closeTab}
        onAdd={addTab}
        onReorder={reorderTabs}
        onRename={onRename}
        onOpenExplorer={onOpenExplorer}
        onOpenTerminal={onOpenTerminal}
        onOpenIde={onOpenIde}
        recentMenu={/* existing RecentMenu, now wired to openClaudeNewTab */}
      />
```

Add a settings gear button and mount the modal. Put the gear just after `<TabBar>` open or inside the tabbar row — simplest is a small button in the `.app` header area:
```tsx
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
```
And a trigger — add a `⚙` button to the tabbar via a new prop OR render it next to RecentMenu. To avoid widening TabBar props, pass the gear as part of `recentMenu` node:
```tsx
        recentMenu={
          <>
            <RecentMenu onOpen={(p, r) => openClaudeNewTab(p, r)} onOpenFolder={openFolderTab} />
            <button className="gear" title="Settings" onClick={() => setShowSettings(true)}>⚙</button>
          </>
        }
```

Keep the existing `openClaude(id, ...)` (used by FileBrowser's orange arrow — converts the current files tab in place; unchanged this release).

- [ ] **Step 2:** Run `npx tsc --noEmit`. Expected: errors only from `TabBar.tsx` until U3 lands; `App.tsx` references must all resolve against the frozen contracts.
- [ ] **Step 3:** Commit: `git commit -am "feat(v0.0.2): App wires new-tab launches, shell tabs, rename, tab-menu, status, settings"`

> **Open question for the human (surface at review):** the FileBrowser orange-arrow still converts the current files tab into a Claude terminal in place. Feature 1 only names Open Recent. Leave as-is, or make the arrow open a new tab too? Default: leave as-is.

---

## Task U3: TabBar — status dot, context menu, direction-aware drop, inline rename

**Model:** sonnet
**Depends on:** U1 (Tab), R1 (dropIndex), U2 (frozen TabBarProps), and reuses `components/ContextMenu`.

**Files:**
- Modify: `src/renderer/TabBar.tsx`

**Interfaces:**
- Consumes: `TabBarProps` (verbatim from U2), `dropIndex` from R1, `ContextMenu`/`MenuItem` from `components/ContextMenu`, `PtyStatus`.

**Behavioral spec:**

1. **Props:** replace the current `Props` with `TabBarProps` from U2 (adds `status`, `onRename`, `onOpenExplorer`, `onOpenTerminal`, `onOpenIde`; `onReorder` is now `(from, insert)`).

2. **Status dot (feature 3):** for a `view === 'terminal'` tab, render `<span className={'tab-status ' + status.get(t.ptyId!)}>` before the title. `undefined` status (freshly spawned, no event yet) → treat as `running`. Map: `running`→`tab-status running`, `waiting`→`tab-status waiting`, `stopped`→`tab-status stopped`. Files tabs render no dot (keep the `📁` glyph). Terminal tabs: replace the `▶`/`📁` prefix with the status dot; keep a small `▶`/shell glyph if desired but the dot is the indicator.

3. **Direction-aware drop indicator (feature 6):** track `over: { index: number; side: 'left' | 'right' } | null`. In `onDragOver` for a tab-reorder drag (`types.includes(TAB_MIME)`), compute side from the pointer vs the tab's midpoint:
```tsx
onDragOver={(e) => {
  if (e.dataTransfer.types.includes(TAB_MIME)) {
    e.preventDefault()
    const r = e.currentTarget.getBoundingClientRect()
    const side: 'left' | 'right' = e.clientX > r.left + r.width / 2 ? 'right' : 'left'
    setOver({ index: i, side })
  } else if (drag) { e.preventDefault() }
}}
```
Class on the tab: `over?.index === i` → add `over.side === 'right' ? 'drop-right' : 'drop-left'`. (Remove the old unconditional `drag-over` left border.) On drop:
```tsx
onDrop={(e) => {
  clearSpring(); const dropped = over; setOver(null)
  const id = e.dataTransfer.getData(TAB_MIME)
  if (id && dragFrom !== null && dropped) {
    e.preventDefault()
    const insert = dropIndex(dragFrom, dropped.index, dropped.side)
    if (insert !== dragFrom) onReorder(dragFrom, insert)
  }
  setDragFrom(null)
}}
```
Keep the spring-load file-drop behavior (`application/x-ce-files`) intact.

4. **Right-click context menu (feature 4):** track `menu: { x: number; y: number; id: string } | null`. On a tab's `onContextMenu`: `e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, id: t.id })`. Render at the end of the component:
```tsx
{menu && (
  <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
    { label: 'Rename', onClick: () => startRename(menu.id) },
    { label: 'Open in File Explorer', onClick: () => onOpenExplorer(menu.id) },
    { label: 'Open Terminal', onClick: () => onOpenTerminal(menu.id) },
    { label: 'Open in IDE', onClick: () => onOpenIde(menu.id) },
    { separator: true },
    { label: 'Close', onClick: () => onClose(menu.id) },
  ]} />
)}
```

5. **Inline rename:** `renaming: string | null` + `draft: string`. `startRename(id)` sets `renaming=id`, `draft=` that tab's current title. When `renaming === t.id`, render an `<input className="tab-rename" autoFocus>` in place of the title; commit on Enter/blur via `onRename(id, draft)` then clear; cancel on Escape. Guard the input's `onClick`/`onDragStart` with `stopPropagation` so editing doesn't select/drag the tab. While renaming, set the tab `draggable={false}`.

- [ ] **Step 1:** Implement the above in `TabBar.tsx`.
- [ ] **Step 2:** Run `npx tsc --noEmit`. Expected: clean (assuming U1/U2/R1 merged).
- [ ] **Step 3:** Commit: `git commit -am "feat(v0.0.2): tab status dot, context menu, direction-aware drop, inline rename"`

---

## Task U4: Settings modal

**Model:** haiku
**Depends on:** M2 (settings api), U2 freezes `SettingsModalProps`.

**Files:**
- Create: `src/renderer/components/SettingsModal.tsx`

- [ ] **Step 1:** Create `src/renderer/components/SettingsModal.tsx`:

```tsx
import { useEffect, useState } from 'react'

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [ideCommand, setIdeCommand] = useState('')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    window.api.settingsGet().then((s) => { setIdeCommand(s.ideCommand); setLoaded(true) })
  }, [])

  const save = async () => {
    await window.api.settingsSet({ ideCommand: ideCommand.trim() || 'code' })
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <label className="settings-field">
          <span>IDE command</span>
          <input
            value={ideCommand}
            placeholder="code"
            disabled={!loaded}
            onChange={(e) => setIdeCommand(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onClose() }}
          />
        </label>
        <p className="settings-hint">
          Launched as <code>&lt;command&gt; &lt;folder&gt;</code>. Examples: <code>code</code> (VS Code),
          <code>cursor</code>, <code>idea</code>, <code>subl</code>.
        </p>
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2:** Run `npx tsc --noEmit`. Expected: clean once V0 preload types are merged.
- [ ] **Step 3:** Commit: `git commit -am "feat(v0.0.2): settings modal for IDE command"`

---

## Task U5: Terminal — Ctrl/Shift+Enter newline

**Model:** haiku
**Depends on:** none (uses existing `ptyWrite`).

**Files:**
- Modify: `src/renderer/components/Terminal.tsx`

**Design:** Plain Enter must still submit (send `\r`). Ctrl+Enter and Shift+Enter should insert a newline — mirroring the external terminal, which delivers a bare LF (`\n`) that Claude Code treats as a newline rather than submit. Intercept with xterm's custom key handler.

- [ ] **Step 1:** In `Terminal.tsx`, after `term.open(ref.current)` and before/after `fit.fit()`, add:

```tsx
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.key === 'Enter' && (e.ctrlKey || e.shiftKey)) {
        window.api.ptyWrite(ptyId, '\n') // LF = insert newline (plain Enter still sends CR = submit)
        return false // stop xterm from also sending its default
      }
      return true
    })
```

- [ ] **Step 2:** Run `npx tsc --noEmit`. Expected: clean.
- [ ] **Step 3:** Commit: `git commit -am "feat(v0.0.2): Ctrl/Shift+Enter inserts a newline in the embedded terminal"`

> **Note (verify at manual QA):** if Claude Code does not treat LF as a newline on your build, the tunable knob is this one write — swap `'\n'` for the escape your external terminal sends (e.g. `'\x1b\r'`). Flagged for the human's manual test.

---

## Task U6: CSS

**Model:** haiku
**Depends on:** U3 (class names), U4 (modal classes).

**Files:**
- Modify: `src/renderer/index.css`

- [ ] **Step 1:** Add (reuse existing tokens; do not invent colors beyond the status semantics):

```css
/* --- tab status dot (feature 3) --- */
.tab-status {
  display: inline-block; width: 8px; height: 8px; border-radius: 50%;
  margin-right: 6px; vertical-align: middle; background: var(--ink-soft);
}
.tab-status.running { background: #6a9a5b; animation: ce-pulse 1.2s ease-in-out infinite; }
.tab-status.waiting { background: #d99a2b; }
.tab-status.stopped { background: var(--ink-soft); opacity: 0.5; }
@keyframes ce-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }

/* --- direction-aware drop indicator (feature 6) --- */
.tab.drop-left  { box-shadow: inset 2px 0 0 var(--clay); }
.tab.drop-right { box-shadow: inset -2px 0 0 var(--clay); }

/* --- inline tab rename --- */
.tab-rename {
  font: inherit; color: var(--ink); background: var(--bg);
  border: 1px solid var(--clay); border-radius: 3px; padding: 0 4px; width: 8em;
}

/* --- settings gear + modal --- */
.gear { background: none; border: none; cursor: pointer; font-size: 15px; padding: 4px 8px; color: var(--ink-soft); }
.gear:hover { color: var(--clay); }
.settings-field { display: flex; flex-direction: column; gap: 4px; margin: 12px 0; }
.settings-field span { font-size: 13px; color: var(--ink-soft); }
.settings-field input { font: inherit; padding: 6px 8px; border: 1px solid var(--ink-soft); border-radius: 4px; background: var(--bg); color: var(--ink); }
.settings-hint { font-size: 12px; color: var(--ink-soft); }
.settings-hint code { background: var(--bg-panel); padding: 0 3px; border-radius: 3px; }

/* primary action button (settings Save). .modal-actions button base already exists. */
.modal-actions button.primary { background: var(--clay); border-color: var(--clay); color: #fff; }
```

`.modal-backdrop`, `.modal`, and `.modal-actions` already exist (delete-confirm modal) — reuse them, do NOT redeclare. `.primary` does NOT exist yet, so the rule above is required. `.danger` exists and is unrelated. Verify by searching `index.css` before adding.

- [ ] **Step 2:** `npm run build` — expect a clean electron-vite build.
- [ ] **Step 3:** Commit: `git commit -am "style(v0.0.2): status dot, drop indicators, rename input, settings modal"`

---

## Task FINAL: Integration, build, tests, version bump (controller)

**Model:** opus (whole-branch review + integration)

- [ ] **Step 1:** `npx tsc --noEmit` — clean across the whole tree.
- [ ] **Step 2:** `npm test` — all suites green (existing 21 + tabreorder + ptystatus).
- [ ] **Step 3:** `npm run build` — clean.
- [ ] **Step 4:** Bump `package.json` `version` to `0.0.2`.
- [ ] **Step 5:** Manual QA checklist (`npm run dev`):
  - Open Recent → New / a session → opens a **new** tab, current tab untouched.
  - In a Claude tab, Ctrl+Enter and Shift+Enter insert a newline; plain Enter submits.
  - Tab status dot: green/pulsing while Claude works, amber when it stops for input, grey when the session ends.
  - Right-click a tab → Rename (inline edit), Open in File Explorer (Windows Explorer at the folder), Open Terminal (new in-app PowerShell tab at the folder), Open in IDE (launches `code`, or the configured command).
  - Settings (⚙) → change IDE command → Open in IDE uses it.
  - Drag a tab rightward past another → the target's **right** border highlights and the tab lands to its right; leftward → left border.
- [ ] **Step 6:** Whole-branch review, then merge to `main` and push. (Do NOT auto-push before the human signs off on QA.)

---

## Parallelism Summary

```
Phase 0 (linear):      V0  ─────────────────────────────┐
                                                         │
Phase 1 (parallel):    M1   M2   R1   R2   U1   U5(Terminal, independent)
                        └────┴────┴────┴────┴──────────► │
Phase 2 (parallel):    U2(App)   U3(TabBar)   U4(SettingsModal)
                        └──────────┴─────────────────► │
Phase 3 (linear):      U6(CSS)
                        └────────────────────────────► │
Phase 4 (linear):      FINAL (tsc + test + build + QA + review)
```

- **Phase 1** tasks touch disjoint files (`pty.ts`, new `settings.*`/`ide.*`, `tabreorder.ts`, `ptystatus.ts`, `tabs.ts`, `Terminal.tsx`) and are safe to run concurrently.
- **Phase 2**: `App.tsx`, `TabBar.tsx`, `SettingsModal.tsx` are disjoint files decoupled by the frozen `TabBarProps`/`SettingsModalProps` contracts in U2 — concurrent-safe. tsc will show cross-file gaps until all three land; that is expected.
- **U5 (Terminal)** has no dependencies and can run in Phase 1 or anytime.
- **Phase 3 (CSS)** is single-owner to avoid `index.css` collisions and runs after the class names are fixed by U3/U4.

## Self-Review (done)

- **Coverage:** feature 1 → U2 (`openClaudeNewTab` + RecentMenu rewire); feature 2 → U5; feature 3 → R2 + U3 dot + U6 CSS; feature 4 → U3 menu + U2 callbacks + M2 (ide/explorer/terminal); feature 5 → M1 + U1 + U2 `openShellTab`; feature 6 → R1 + U3 side detection + U6 borders. IDE-configurable → M2 settings + U4 modal. All six + configurability mapped.
- **Type consistency:** `onReorder(from, insert)` used identically in U2 (App) and U3 (TabBar), fed by `dropIndex` (R1). `PtyStatus` from V0 flows through R2 → U3 → U6. `newTerminalTab` signature in U1 matches both call sites in U2.
- **Contract discipline:** only V0 edits `ipc.ts`; `ptySpawn` opts extended once and consumed by M1/U2.
- **No placeholders:** pure modules and contract carry full code; UI tasks carry exact snippets + frozen props.
