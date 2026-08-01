// KAN-64 — the two ends of the free allowance that are neither the guard nor
// the app: what settings.json is allowed to say, and what `list_tabs` has to
// report for the reap to be able to tell a dead tab from a dormant one.
//
// A separate file from settings-less workspace tests for the reason
// workspace-agentcap.test.ts gives: getSettings()/setSettings() do REAL disk
// I/O through electron's userData path, so this needs a real, writable,
// per-run directory rather than the fake never-touched path other suites mock.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_FREE_SESSION_CHOICES, DEFAULT_AGENT_FREE_SESSIONS, type PtyStatus,
} from '../src/shared/types'
import { toControlTab, newTerminalTab, fromPersisted, type Tab } from '../src/renderer/tabs'

const dirBox = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => dirBox.dir } }))

const { getSettings, setSettings } = await import('../src/main/settings')

beforeAll(() => { dirBox.dir = mkdtempSync(join(tmpdir(), `ce-k64-set-${process.pid}-`)) })
afterAll(() => { rmSync(dirBox.dir, { recursive: true, force: true }) })

const file = () => join(dirBox.dir, 'settings.json')
const handEdit = (raw: string) => writeFileSync(file(), raw, 'utf8')
const onDisk = () => JSON.parse(readFileSync(file(), 'utf8'))

beforeEach(() => { if (existsSync(file())) unlinkSync(file()) })

describe('Settings.agentFreeSessions', () => {
  it('defaults to 8 on a profile that has never been written', () => {
    // Stated as the literal, not as the constant compared to itself: the
    // default is a deliberate, security-relevant choice (eight sessions used to
    // cost eight clicks and now cost none) and a test that reads
    // `DEFAULT_AGENT_FREE_SESSIONS` on both sides cannot notice it changing.
    expect(getSettings().agentFreeSessions).toBe(8)
    expect(DEFAULT_AGENT_FREE_SESSIONS).toBe(8)
  })

  it('offers exactly 0, 4, 8 and 16, and every one of them round-trips', () => {
    expect([...AGENT_FREE_SESSION_CHOICES]).toEqual([0, 4, 8, 16])
    for (const n of AGENT_FREE_SESSION_CHOICES) {
      expect(setSettings({ agentFreeSessions: n }).agentFreeSessions).toBe(n)
      expect(onDisk().agentFreeSessions).toBe(n) // on disk, so it survives a restart
      expect(getSettings().agentFreeSessions).toBe(n) // and reads back from there
    }
  })

  it('reads 0 as 0 — "ask every time" must not be swallowed as falsy', () => {
    // The whole reason 0 is in the set. A `|| DEFAULT` normalization (or a
    // truthiness check anywhere on the path) silently turns the strictest
    // setting into the loosest one, which is the worst direction available.
    setSettings({ agentFreeSessions: 0 })
    expect(getSettings().agentFreeSessions).toBe(0)
  })

  it('falls back to the default for a hand-edited value that is not offered', () => {
    // Each of these is a way a text editor can express "never ask again": a
    // number bigger than any tab count, a negative, a float that no comparison
    // treats as a member, and a string that `>=` compares false against
    // forever. None of them may disable the human gate.
    for (const junk of ['9999', '-1', '4.5', '"lots"', 'null', 'true', '[]']) {
      handEdit(`{"agentFreeSessions": ${junk}}`)
      expect(getSettings().agentFreeSessions).toBe(DEFAULT_AGENT_FREE_SESSIONS)
    }
  })

  it('a missing key reads as the default, and the rest of an older file survives it', () => {
    // The upgrade path: a settings.json written before this key existed.
    handEdit(JSON.stringify({ ideCommand: 'subl', mode: 'developer', groupWithSource: false }))
    const s = getSettings()
    expect(s.agentFreeSessions).toBe(DEFAULT_AGENT_FREE_SESSIONS)
    expect([s.ideCommand, s.mode, s.groupWithSource]).toEqual(['subl', 'developer', false])
  })

  it('normalizes on WRITE too, so junk cannot be parked on disk', () => {
    // setSettings takes a Partial<Settings> straight off an IPC channel. A
    // renderer (or anything that can reach the channel) sending 9999 must not
    // leave it in the file for the next reader to keep normalizing away.
    setSettings({ agentFreeSessions: 9999 as number })
    expect(onDisk().agentFreeSessions).toBe(DEFAULT_AGENT_FREE_SESSIONS)
  })

  it('a corrupt settings.json still yields a working default, not a throw', () => {
    handEdit('{ this is not json')
    expect(getSettings().agentFreeSessions).toBe(DEFAULT_AGENT_FREE_SESSIONS)
  })
})

// The renderer half of the dead-vs-dormant test. mcp.ts's reap can only ever
// close a tab it can SEE is agent-spawned and stopped, and this row is the only
// place those two facts appear together.
describe('toControlTab reports agentSpawned (KAN-64)', () => {
  const status = (m: Record<string, PtyStatus> = {}) => new Map(Object.entries(m))

  it('carries the flag for a tab the spawn tool opened', () => {
    const t = newTerminalTab('C:\\repo', 'claude', 'pty-1', 'repo', 'sess-1', true)
    expect(toControlTab(t, status({ 'pty-1': 'stopped' }))).toMatchObject({
      agentSpawned: true, status: 'stopped', ptyId: 'pty-1',
    })
  })

  it('leaves it absent for a tab the USER opened, however dead that tab is', () => {
    // The tab that must never be reaped no matter what its status says. Absent
    // rather than false: `agentSpawned?: true` has no second value, and a row
    // that carried `false` would still be falsy at the reap's filter.
    const t = newTerminalTab('C:\\repo', 'claude', 'pty-2', 'repo', 'sess-2')
    const row = toControlTab(t, status({ 'pty-2': 'stopped' }))
    expect(row.agentSpawned).toBeUndefined()
    expect(row.status).toBe('stopped')
  })

  it('a DORMANT restored agent tab reports the flag but NO status', () => {
    // The trap the reap is built around, stated as data. A restored tab has no
    // ptyId (PersistedTab has no such field and fromPersisted cannot invent
    // one), so it joins no status — and "no status" is therefore NOT evidence
    // of death. A reap keyed on `status !== 'running'` would close this tab,
    // which is the user's only surviving record of what the agent was doing.
    const restored = fromPersisted({
      id: 't1', view: 'terminal', cwd: 'C:\\repo', title: 'repo',
      terminalKind: 'claude', resumeSessionId: 'sess-3', agentSpawned: true,
    }) as Tab
    const row = toControlTab(restored, status({ 'pty-1': 'stopped' }))
    expect(row.agentSpawned).toBe(true)
    expect(row.ptyId).toBeUndefined()
    expect(row.status).toBeUndefined()
  })

  it('a freshly spawned agent tab that has not emitted yet also reports NO status', () => {
    // The second half of the same trap, and the reason the reap tests for
    // `=== 'stopped'` rather than for the absence of 'running': a live session
    // between spawn and first byte is indistinguishable from a dormant one here.
    const t = newTerminalTab('C:\\repo', 'claude', 'pty-9', 'repo', 'sess-9', true)
    expect(toControlTab(t, status()).status).toBeUndefined()
  })
})
