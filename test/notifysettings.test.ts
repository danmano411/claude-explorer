// KAN-77/79 — the settings.ts half: what settings.json is allowed to say for
// the three notification switches, and the mechanism the whole show-once rule
// depends on (needsNotifSetup in notify.ts is proven at the pure-logic level
// in notify.test.ts; THIS file proves that `getSettings()` actually hands it
// an absent key on a profile that has never written one — real disk I/O,
// same harness shape as test/agentallowance.test.ts).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dirBox = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => dirBox.dir } }))

const { getSettings, setSettings } = await import('../src/main/settings')

beforeAll(() => { dirBox.dir = mkdtempSync(join(tmpdir(), `ce-k77-set-${process.pid}-`)) })
afterAll(() => { rmSync(dirBox.dir, { recursive: true, force: true }) })

const file = () => join(dirBox.dir, 'settings.json')
const handEdit = (raw: string) => writeFileSync(file(), raw, 'utf8')
const onDisk = () => JSON.parse(readFileSync(file(), 'utf8'))

beforeEach(() => { if (existsSync(file())) unlinkSync(file()) })

describe('Settings.notifySound / notifyDesktop / autoSwitchOnInput', () => {
  it('all three default to false on a profile that has never been written (KAN-77 acceptance #1)', () => {
    const s = getSettings()
    expect(s.notifySound).toBe(false)
    expect(s.notifyDesktop).toBe(false)
    expect(s.autoSwitchOnInput).toBe(false)
  })

  it('each round-trips true, on disk and back through getSettings', () => {
    setSettings({ notifySound: true })
    expect(onDisk().notifySound).toBe(true)
    expect(getSettings().notifySound).toBe(true)
    setSettings({ notifySound: false })

    setSettings({ notifyDesktop: true })
    expect(onDisk().notifyDesktop).toBe(true)
    expect(getSettings().notifyDesktop).toBe(true)
    setSettings({ notifyDesktop: false })

    setSettings({ autoSwitchOnInput: true })
    expect(onDisk().autoSwitchOnInput).toBe(true)
    expect(getSettings().autoSwitchOnInput).toBe(true)
    setSettings({ autoSwitchOnInput: false })
  })

  it('falls back to false for a hand-edited non-boolean value, normalized on read', () => {
    for (const junk of ['"yes"', '1', 'null', '[]', '"true"']) {
      handEdit(`{"notifySound": ${junk}}`)
      expect(getSettings().notifySound).toBe(false)
    }
  })

  it('normalizes on WRITE too, so a non-boolean sent over IPC cannot be parked on disk', () => {
    setSettings({ notifySound: 'yes' as unknown as boolean })
    expect(onDisk().notifySound).toBe(false)
  })

  it('a settings.json from before these keys existed reads all three as false, and the rest survives', () => {
    handEdit(JSON.stringify({ ideCommand: 'subl', mode: 'developer' }))
    const s = getSettings()
    expect([s.notifySound, s.notifyDesktop, s.autoSwitchOnInput]).toEqual([false, false, false])
    expect([s.ideCommand, s.mode]).toEqual(['subl', 'developer'])
  })
})

describe('Settings.notifSetupSeen — the KAN-79 show-once mechanism', () => {
  it('is absent (not false) on a fresh profile — the fresh-install case', () => {
    expect(getSettings().notifSetupSeen).toBeUndefined()
  })

  it('is STILL absent for an upgrading user whose settings.json predates the key entirely', () => {
    // This is the exact case the ticket names: "an upgrading user already has a
    // settings.json, so the absence of the key is the signal, not the absence
    // of the file". DEFAULTS (settings.ts) deliberately does not mention this
    // key, so `{...DEFAULTS, ...parsed}` cannot manufacture a value for it.
    handEdit(JSON.stringify({ ideCommand: 'code', mode: 'explorer', groupWithSource: true }))
    expect(getSettings().notifSetupSeen).toBeUndefined()
  })

  it('becomes true once the first-run card writes it, and stays true across a re-read', () => {
    setSettings({ notifSetupSeen: true })
    expect(onDisk().notifSetupSeen).toBe(true)
    expect(getSettings().notifSetupSeen).toBe(true)
  })
})
