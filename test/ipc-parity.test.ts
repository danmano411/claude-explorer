// KAN-31 — IPC parity guard.
//
// CLAUDE.md's rule: a channel is only "real" when all four pieces exist — a
// `CH` constant, an `Api` method, a preload binding, and a main handler.
// `fs:exists` shipped with the first three and no handler; the only symptom
// was the address bar silently doing nothing. This file walks `CH` and
// proves all four are present for every channel, in both directions.
//
// `Api` is a TypeScript interface — erased at build time, so there is no
// runtime object to introspect for the CH <-> Api direction. Reading
// src/shared/ipc.ts as TEXT and regexing method names out of the interface
// body is legitimate here: it's the only way to check parity against
// something the compiler deletes. No runtime registry is added to
// production code just to make this easier — the test does the work.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = process.cwd() // `npx vitest run` is always invoked from the repo root here

// ---------------------------------------------------------------------------
// electron mock. Every register*Handlers() and the preload module touch a
// handful of electron APIs at call/import time. Recording stubs let us
// capture what actually gets wired up without a real Electron process.
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => ({
  ipcMainHandlers: new Map<string, unknown>(), // channel -> ipcMain.handle callback
  ipcMainOn: new Map<string, unknown>(), // channel -> ipcMain.on callback
  exposedApi: undefined as Record<string, unknown> | undefined, // captured from contextBridge.exposeInMainWorld
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: unknown) => h.ipcMainHandlers.set(ch, fn),
    on: (ch: string, fn: unknown) => h.ipcMainOn.set(ch, fn),
  },
  app: {
    getPath: () => 'C:\\fake\\userData',
    getAppPath: () => 'C:\\fake\\app',
    isPackaged: false,
  },
  shell: {
    trashItem: vi.fn(),
    openPath: vi.fn(async () => ''),
    showItemInFolder: vi.fn(),
  },
  BrowserWindow: class {},
  clipboard: { readText: () => '' },
  contextBridge: {
    exposeInMainWorld: (_name: string, api: Record<string, unknown>) => {
      h.exposedApi = api
    },
  },
  ipcRenderer: {
    invoke: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  },
}))

import { CH } from '../src/shared/ipc'

// Every register*Handlers() src/main/index.ts actually calls, in the same
// order. Deliberately NOT importing index.ts itself — it calls
// app.whenReady() and creates a real BrowserWindow.
import { registerFsHandlers } from '../src/main/fs.handlers'
import { registerRecentsHandlers } from '../src/main/recents.handlers'
import { registerSessionsHandlers } from '../src/main/sessions.handlers'
import { registerExternalHandlers } from '../src/main/external.handlers'
import { registerPtyHandlers } from '../src/main/pty.handlers'
import { registerFsMutateHandlers } from '../src/main/fsmutate.handlers'
import { registerTrashHandlers } from '../src/main/trash.handlers'
import { registerOpenHandlers } from '../src/main/open.handlers'
import { registerSettingsHandlers } from '../src/main/settings.handlers'
import { registerIdeHandlers } from '../src/main/ide.handlers'
import { registerFileReadHandlers } from '../src/main/fileread.handlers'
import { registerGitHandlers } from '../src/main/git.handlers'
import { registerSearchHandlers } from '../src/main/search.handlers'
import { registerWorkspaceHandlers } from '../src/main/workspace.handlers'
import { registerControlHandlers } from '../src/main/control.handlers'
import { registerSpawnConfirmHandlers } from '../src/main/spawnconfirm.handlers'

// Side-effect import: runs contextBridge.exposeInMainWorld('api', api) at
// module load, which the mock above captures into h.exposedApi.
import '../src/preload/index'

registerFsHandlers()
registerRecentsHandlers()
registerSessionsHandlers()
registerExternalHandlers()
registerPtyHandlers(() => null)
registerFsMutateHandlers()
registerTrashHandlers()
registerOpenHandlers()
registerSettingsHandlers()
registerIdeHandlers()
registerFileReadHandlers()
registerGitHandlers()
registerSearchHandlers(() => null)
registerWorkspaceHandlers()
registerControlHandlers(() => null)
registerSpawnConfirmHandlers(() => null, () => {})

// ---------------------------------------------------------------------------
// CH <-> Api parity via text (Api is erased at runtime — see header comment).
// ---------------------------------------------------------------------------
const ipcText = readFileSync(resolve(ROOT, 'src/shared/ipc.ts'), 'utf8')
const apiMatch = ipcText.match(/export interface Api \{([\s\S]*?)\n\}/)
if (!apiMatch) throw new Error('ipc-parity: could not find `export interface Api { ... }` in ipc.ts')
const apiMethodNames = new Set<string>()
for (const line of apiMatch[1].split('\n')) {
  const m = line.match(/^\s*(\w+)\s*\(/)
  if (m) apiMethodNames.add(m[1])
}

// Main -> renderer event channels: no ipcMain handler exists (or should
// exist) for these, and their preload binding is an `onXxx` subscriber, not
// a direct call. Explicit named allowlist, not a special case in the check
// logic below — the point is to make "this channel is an event, not a call"
// a deliberate, visible statement.
const EVENT_CHANNELS = new Set<string>([
  CH.ptyData, // main -> renderer: pty output
  CH.ptyExit, // main -> renderer: pty process exit
  CH.searchHits, // main -> renderer: streamed search results
  CH.searchDone, // main -> renderer: search finished
  CH.menuCommand, // main -> renderer: File/Settings menu clicks
  CH.menuSession, // main -> renderer: native File > Open Recent rows (KAN-55)
  CH.trashWarn, // main -> renderer: a flush couldn't reach the Recycle Bin (KAN-32)
  CH.controlRequest, // main -> renderer: control-channel request (KAN-39)
  // NOT CH.controlReply: that half travels renderer -> main, so it has a real
  // ipcMain.on listener (control.handlers.ts) and must be checked like one.
  CH.spawnConfirm, // main -> renderer: "an agent wants to start Claude here" (KAN-41)
  // NOT CH.spawnConfirmAnswer: renderer -> main, real ipcMain.on listener in
  // spawnconfirm.handlers.ts, checked like one.
  CH.claudeState, // main -> renderer: Claude session state, from hooks (KAN-73)
])

function apiNameFor(key: string, value: string): string {
  if (EVENT_CHANNELS.has(value)) return 'on' + key[0].toUpperCase() + key.slice(1)
  return key
}

const channelEntries = Object.entries(CH) // [key, 'channel:value'][]

// What this found on its first run: src/main/git.handlers.ts exported
// registerGitHandlers(), but src/main/index.ts never called it — so git:status
// and git:diff had a CH entry, an Api method and a preload binding, and no
// handler at runtime. The entire M2 diff surface was dead in a real build. Same
// bug class as fs:exists (KAN-30), which is why this file exists. Now wired.

describe('IPC parity: every CH channel has an Api method', () => {
  for (const [key, value] of channelEntries) {
    it(`CH.${key} (${value})`, () => {
      expect(apiMethodNames.has(apiNameFor(key, value))).toBe(true)
    })
  }
})

describe('IPC parity: every CH channel has a preload binding', () => {
  for (const [key, value] of channelEntries) {
    it(`CH.${key} (${value}) -> api.${apiNameFor(key, value)}`, () => {
      expect(typeof h.exposedApi?.[apiNameFor(key, value)]).toBe('function')
    })
  }
})

describe('IPC parity: every CH channel has a main handler', () => {
  for (const [key, value] of channelEntries) {
    const registered = () => h.ipcMainHandlers.has(value) || h.ipcMainOn.has(value)
    if (EVENT_CHANNELS.has(value)) {
      it(`CH.${key} (${value}) is an event channel, so no ipcMain handler`, () => {
        expect(registered()).toBe(false)
      })
    } else {
      it(`CH.${key} (${value})`, () => {
        expect(registered()).toBe(true)
      })
    }
  }

})

describe('IPC parity: reverse — no handler registered for a channel outside CH', () => {
  const chValues = new Set<string>(Object.values(CH))
  const registeredChannels = [...h.ipcMainHandlers.keys(), ...h.ipcMainOn.keys()]
  for (const ch of registeredChannels) {
    it(`registered channel "${ch}" is declared in CH`, () => {
      expect(chValues.has(ch)).toBe(true)
    })
  }
})

// ---------------------------------------------------------------------------
// Every register*Handlers() export is actually wired into index.ts. A
// register function that exists but is never called is its own bug class —
// registerGitHandlers above is exactly this, caught here a second, cheaper
// way (plain text containment, no import graph resolution).
// ---------------------------------------------------------------------------
describe('every register*Handlers export is called from src/main/index.ts', () => {
  const mainDir = resolve(ROOT, 'src/main')
  const indexText = readFileSync(resolve(mainDir, 'index.ts'), 'utf8')
  const handlerFiles = readdirSync(mainDir).filter((f) => f.endsWith('.handlers.ts'))
  const registerNames = new Set<string>()
  for (const file of handlerFiles) {
    const text = readFileSync(resolve(mainDir, file), 'utf8')
    const re = /export function (register\w+)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) registerNames.add(m[1])
  }

  for (const name of registerNames) {
    it(`${name} is called from index.ts`, () => {
      expect(indexText.includes(name)).toBe(true)
    })
  }
})
