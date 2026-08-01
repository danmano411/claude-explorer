// KAN-83 — the main-process half: what settings.json is allowed to say for
// Settings.spaceKeybinds. Same reason agentallowance.test.ts is a separate
// file from workspace-less suites: getSettings()/setSettings() do REAL disk
// I/O through electron's userData path, so this needs a real, writable,
// per-run directory rather than the fake never-touched path other suites mock.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dirBox = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => dirBox.dir } }))

const { getSettings, setSettings } = await import('../src/main/settings')

beforeAll(() => { dirBox.dir = mkdtempSync(join(tmpdir(), `ce-k83-set-${process.pid}-`)) })
afterAll(() => { rmSync(dirBox.dir, { recursive: true, force: true }) })

const file = () => join(dirBox.dir, 'settings.json')
const handEdit = (raw: string) => writeFileSync(file(), raw, 'utf8')
const onDisk = () => JSON.parse(readFileSync(file(), 'utf8'))

beforeEach(() => { if (existsSync(file())) unlinkSync(file()) })

describe('Settings.spaceKeybinds', () => {
  it('is absent on a profile that has never been written — the pinned?/agentSpawned? precedent', () => {
    expect(getSettings().spaceKeybinds).toBeUndefined()
  })

  it('a valid switchUnpinned override round-trips through disk', () => {
    const saved = setSettings({ spaceKeybinds: { switchUnpinned: { alt: true } } })
    expect(saved.spaceKeybinds).toEqual({ switchUnpinned: { alt: true } })
    expect(onDisk().spaceKeybinds).toEqual({ switchUnpinned: { alt: true } })
    expect(getSettings().spaceKeybinds).toEqual({ switchUnpinned: { alt: true } })
  })

  it('a valid cycleNext override (mods AND key) round-trips', () => {
    const binding = { mods: { ctrl: true, alt: true }, key: ']' }
    setSettings({ spaceKeybinds: { cycleNext: binding } })
    expect(getSettings().spaceKeybinds).toEqual({ cycleNext: binding })
  })

  it('rebinding one action does not disturb an already-stored sibling', () => {
    setSettings({ spaceKeybinds: { switchUnpinned: { alt: true } } })
    setSettings({ spaceKeybinds: { switchUnpinned: { alt: true }, switchPinned: { alt: true, shift: true } } })
    expect(getSettings().spaceKeybinds).toEqual({
      switchUnpinned: { alt: true },
      switchPinned: { alt: true, shift: true },
    })
  })

  it('a Mods object with every modifier false falls back to unset — it would fire on every plain digit typed anywhere', () => {
    handEdit(JSON.stringify({ spaceKeybinds: { switchUnpinned: { ctrl: false, shift: false } } }))
    expect(getSettings().spaceKeybinds).toBeUndefined()
  })

  it('a switchUnpinned that is not an object falls back to unset, and does not take the rest of the map with it', () => {
    handEdit(JSON.stringify({ spaceKeybinds: { switchUnpinned: 'ctrl', switchPinned: { ctrl: true, shift: true } } }))
    expect(getSettings().spaceKeybinds).toEqual({ switchPinned: { ctrl: true, shift: true } })
  })

  it('a cycleNext missing its key falls back to unset — mods alone is not a KeyBinding', () => {
    handEdit(JSON.stringify({ spaceKeybinds: { cycleNext: { mods: { ctrl: true } } } }))
    expect(getSettings().spaceKeybinds).toBeUndefined()
  })

  it('a cycleNext whose key is not a string falls back to unset', () => {
    handEdit(JSON.stringify({ spaceKeybinds: { cycleNext: { mods: { ctrl: true }, key: 9 } } }))
    expect(getSettings().spaceKeybinds).toBeUndefined()
  })

  it('a mods field that is not boolean falls back to unset', () => {
    handEdit(JSON.stringify({ spaceKeybinds: { switchPinned: { ctrl: 'yes', shift: true } } }))
    expect(getSettings().spaceKeybinds).toBeUndefined()
  })

  it('a completely malformed spaceKeybinds (not an object) is dropped entirely, not partially kept', () => {
    handEdit(JSON.stringify({ spaceKeybinds: 'ctrl+1' }))
    expect(getSettings().spaceKeybinds).toBeUndefined()
  })

  it('two space actions hand-bound identically de-duplicate rather than leaving the loser unreachable', () => {
    // switchUnpinned and switchPinned both plain Ctrl: at match time
    // `spaceIndex` would ALWAYS win, so switchPinned would never fire no
    // matter how many pinned spaces exist — exactly the "action goes
    // unreachable" failure the ticket says a hand-edited value must not cause.
    handEdit(JSON.stringify({
      spaceKeybinds: { switchUnpinned: { ctrl: true }, switchPinned: { ctrl: true } },
    }))
    const s = getSettings()
    expect(s.spaceKeybinds?.switchUnpinned).toEqual({ ctrl: true })
    expect(s.spaceKeybinds?.switchPinned).toBeUndefined() // dropped back to "unset" -> its own default applies
  })

  it('two cycle actions hand-bound to the identical mods+key also de-duplicate', () => {
    handEdit(JSON.stringify({
      spaceKeybinds: {
        cycleNext: { mods: { ctrl: true }, key: ']' },
        cyclePrev: { mods: { ctrl: true }, key: ']' },
      },
    }))
    const s = getSettings()
    expect(s.spaceKeybinds?.cycleNext).toEqual({ mods: { ctrl: true }, key: ']' })
    expect(s.spaceKeybinds?.cyclePrev).toBeUndefined()
  })

  it('normalizes on WRITE too, so a renderer sending junk cannot park it on disk', () => {
    setSettings({ spaceKeybinds: { switchUnpinned: { ctrl: false } } } as never)
    expect(onDisk().spaceKeybinds).toBeUndefined()
  })

  it('a corrupt settings.json still yields a working default (absent), not a throw', () => {
    handEdit('{ this is not json')
    expect(getSettings().spaceKeybinds).toBeUndefined()
  })

  it('a missing key reads as absent, and the rest of an older file survives it', () => {
    handEdit(JSON.stringify({ ideCommand: 'subl', mode: 'developer', groupWithSource: false }))
    const s = getSettings()
    expect(s.spaceKeybinds).toBeUndefined()
    expect([s.ideCommand, s.mode, s.groupWithSource]).toEqual(['subl', 'developer', false])
  })
})
