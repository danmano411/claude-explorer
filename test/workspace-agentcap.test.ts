// KAN-64 — agentSpawnedTabCount(), the disk half of the agent-session cap.
//
// A SEPARATE file from workspace.test.ts on purpose: that file's `vi.mock`
// points `app.getPath` at a fake, never-touched 'C:\\userData' — every test in
// it calls the pure `sanitize()` and none does real disk I/O. This function
// DOES real disk I/O (getWorkspace() -> readFileSync), so it needs a real,
// writable, per-run directory — reusing the fake path would either skip real
// I/O (proving nothing) or start writing into a path nothing owns.
//
// CLAUDE.md rule: an assertion only earns its place if it fails against the
// UNMODIFIED build. `agentSpawnedTabCount` is new in this change, so there is
// no prior version of THIS function to revert to — the red proof instead
// reverts the caller this ticket is about (pty.handlers.ts's
// `agentSessionCount`, which is what the MCP cap actually reads) and shows it
// then reports live-only, invisible to a restored-but-unspawned tab. See the
// report for the exact captured RED/GREEN output; this file also stands on
// its own as GREEN-only coverage of the new function's counting rule.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PersistedTab, Workspace } from '../src/shared/types'

// vi.hoisted, not a plain module-level `let`: vi.mock factories are hoisted
// above every import, so a factory closing over an ordinary variable would
// read it before its `let` initializer ran. sessions.test.ts's `io` is the
// same pattern for the same reason.
const dirBox = vi.hoisted(() => ({ dir: '' }))

vi.mock('electron', () => ({ app: { getPath: () => dirBox.dir } }))

const { getWorkspace, setWorkspace, agentSpawnedTabCount, emptyWorkspace } =
  await import('../src/main/workspace')

beforeAll(() => {
  dirBox.dir = mkdtempSync(join(tmpdir(), `ce-kan64-${process.pid}-`))
})
afterAll(() => {
  rmSync(dirBox.dir, { recursive: true, force: true })
})

const tab = (id: string, extra: Partial<PersistedTab> = {}): PersistedTab => ({
  id, view: 'terminal', cwd: `C:\\${id}`, title: id, terminalKind: 'claude', ...extra,
})

const workspaceOf = (tabs: PersistedTab[]): Workspace => ({
  version: 1,
  spaces: [{ id: 's1', name: 'Space', tabIds: tabs.map((t) => t.id), layout: null }],
  groups: [],
  tabs,
  activeSpaceId: 's1',
})

describe('agentSpawnedTabCount', () => {
  it('is 0 against an empty (never-written) workspace, and is not just a stub that always says 0', () => {
    // getWorkspace() falls back to emptyWorkspace() when the file is absent —
    // exactly the state of a brand-new profile, which must not look like it
    // is already at the cap. On its own that expectation passes for a
    // function that unconditionally returns 0, so this test also writes an
    // agent-spawned tab afterward and requires the count to move to 1 — the
    // only way to tell "correctly computed 0 from an empty workspace" apart
    // from "always returns 0 no matter what's on disk".
    expect(agentSpawnedTabCount()).toBe(0)
    setWorkspace(workspaceOf([tab('boundary-check', { agentSpawned: true })]))
    expect(agentSpawnedTabCount()).toBe(1)
  })

  it('counts a restored terminal tab marked agentSpawned even though it has never had a process', () => {
    // This is the KAN-64 gap made concrete: `agentSpawned: true` with no
    // ptyId anywhere (PersistedTab has no ptyId field at all — a restored tab
    // is, by construction, never "live" until it is activated).
    setWorkspace(workspaceOf([tab('a', { agentSpawned: true }), tab('b')]))
    expect(agentSpawnedTabCount()).toBe(1)
  })

  it('counts every agentSpawned tab, not just one', () => {
    setWorkspace(workspaceOf([
      tab('a', { agentSpawned: true }),
      tab('b', { agentSpawned: true }),
      tab('c'), // a plain (non-agent) Claude tab — must not be counted
      { id: 'd', view: 'files', cwd: 'C:\\d', title: 'd' }, // not even a terminal
    ]))
    expect(agentSpawnedTabCount()).toBe(2)
  })

  it('drops back to 0 once every agent-spawned tab is closed', () => {
    setWorkspace(workspaceOf([tab('a')]))
    expect(agentSpawnedTabCount()).toBe(0)
  })

  it('round-trips through the real sanitize() a hand-built Workspace already exercises elsewhere', () => {
    // Not a fresh claim on its own (sanitize() itself is covered in
    // workspace.test.ts) — this just confirms agentSpawnedTabCount reads
    // whatever setWorkspace()/sanitize() actually persisted, not a shape this
    // test invented.
    setWorkspace(workspaceOf([tab('x', { agentSpawned: true })]))
    const onDisk = getWorkspace()
    expect(onDisk.tabs.find((t) => t.id === 'x')?.agentSpawned).toBe(true)
    expect(agentSpawnedTabCount()).toBe(1)
  })
})

// Guard rail: emptyWorkspace() itself must never carry an agent-spawned tab —
// otherwise the "0 on a fresh profile" test above would be trivially true for
// the wrong reason (a bug in emptyWorkspace(), not in the counting rule).
describe('emptyWorkspace', () => {
  it('has no tabs at all', () => {
    expect(emptyWorkspace().tabs).toEqual([])
  })
})
