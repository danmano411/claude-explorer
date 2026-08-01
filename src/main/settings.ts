import { app } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import {
  AGENT_FREE_SESSION_CHOICES, DEFAULT_AGENT_FREE_SESSIONS, type Settings,
} from '../shared/types'

const DEFAULTS: Settings = {
  ideCommand: 'code',
  mode: 'explorer',
  groupWithSource: true,
  // KAN-42: default ON. The merge below is what makes a settings.json written
  // before this key existed read as `true` rather than `undefined`.
  agentControl: true,
  agentFreeSessions: DEFAULT_AGENT_FREE_SESSIONS,
  // KAN-77/79. All three off by default — see the doc comments on these three
  // fields in shared/types.ts for why each one specifically defaults false
  // (notifyDesktop's "ask here" pre-selection is a NotifSetupCard presentation
  // choice, not a second default here). Deliberately no `notifSetupSeen` key in
  // this object at all — see that field's own doc comment for why its absence
  // from DEFAULTS is what makes an upgrading user's settings.json (which also
  // lacks it) read as "never asked".
  notifySound: false,
  notifyDesktop: false,
  autoSwitchOnInput: false,
}
const file = () => join(app.getPath('userData'), 'settings.json')

/**
 * KAN-64. The one field with values a hand edit can make MEANINGFUL nonsense
 * of: `agentControl: "no"` is merely truthy, but `agentFreeSessions: 9999` (or
 * `"lots"`, which `n >= allowance` compares false against for every n) would
 * read as "never ask", i.e. it would disable the human gate from a text file.
 * So anything outside the offered set falls back to the DEFAULT — never to
 * unlimited, and never to a value that skips the prompt.
 *
 * Applied on read AND on write: on read because that is what the guard consults
 * and the file is user-editable, on write so a renderer sending junk cannot
 * park it on disk for the next reader to normalize again.
 */
// KAN-77. Same "meaningful nonsense" bar as agentFreeSessions above: a
// hand-edited `"notifySound": "yes"` is truthy in JS but was never one of the
// two values this field can hold, so it falls back to DEFAULT rather than
// being read as `true` (or, worse, as `false` via some other stringly-typed
// guess) by whatever happens to consume it next.
const bool = (v: unknown, def: boolean): boolean => (typeof v === 'boolean' ? v : def)

function normalize(s: Settings): Settings {
  const n = (AGENT_FREE_SESSION_CHOICES as readonly number[]).includes(s.agentFreeSessions)
    ? s.agentFreeSessions
    : DEFAULT_AGENT_FREE_SESSIONS
  const spaceKeybinds = normalizeSpaceKeybinds(s.spaceKeybinds)
  const notifySound = bool(s.notifySound, DEFAULTS.notifySound)
  const notifyDesktop = bool(s.notifyDesktop, DEFAULTS.notifyDesktop)
  const autoSwitchOnInput = bool(s.autoSwitchOnInput, DEFAULTS.autoSwitchOnInput)
  // `spaceKeybinds` is only `=== s.spaceKeybinds` in the common case where
  // both are `undefined` (nobody has touched this yet) — otherwise
  // `normalizeSpaceKeybinds` always returns a freshly built object, so this
  // check exists to skip a needless rewrite for that common case, not to
  // detect "no change" in the customized one.
  return (
    n === s.agentFreeSessions && spaceKeybinds === s.spaceKeybinds &&
    notifySound === s.notifySound && notifyDesktop === s.notifyDesktop &&
    autoSwitchOnInput === s.autoSwitchOnInput
  )
    ? s
    : { ...s, agentFreeSessions: n, spaceKeybinds, notifySound, notifyDesktop, autoSwitchOnInput }
}

type ModsLike = { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }
type KeyBindingLike = { mods: ModsLike; key: string }
type SpaceKeybindsLike = NonNullable<Settings['spaceKeybinds']>

function isMods(v: unknown): v is ModsLike {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  // At least one modifier must be true. A binding with none is not merely
  // unusual — since neither switch action's window listener checks
  // `isTypingTarget` (only the app's OWN inputs, `isTextBox`), an unmodified
  // digit would fire on every plain "3" typed anywhere else in the app,
  // including into a terminal — silently breaking ordinary typing rather
  // than merely picking an odd chord. Same "dangerous, not just unusual"
  // bar KAN-64's normalize applies to agentFreeSessions.
  const hasAModifier = !!o.ctrl || !!o.shift || !!o.alt || !!o.meta
  return (
    hasAModifier &&
    (o.ctrl === undefined || typeof o.ctrl === 'boolean') &&
    (o.shift === undefined || typeof o.shift === 'boolean') &&
    (o.alt === undefined || typeof o.alt === 'boolean') &&
    (o.meta === undefined || typeof o.meta === 'boolean')
  )
}

function isKeyBinding(v: unknown): v is KeyBindingLike {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return isMods(o.mods) && typeof o.key === 'string' && o.key.length > 0
}

const modsSignature = (m: ModsLike): string => `${!!m.ctrl}|${!!m.shift}|${!!m.alt}|${!!m.meta}`

/**
 * KAN-83, same spirit as `normalize` above: a stored binding that is missing,
 * wrongly shaped, or has no modifier at all is dropped back to "unset" field
 * by field — never left in a shape that could brick the ACTION it belongs
 * to — and `undefined` (not `{}`) when nothing survives, so a caller's
 * `resolveSpaceKeybinds` sees exactly what an old settings.json with no
 * keybinds section at all would give it.
 */
function normalizeSpaceKeybinds(raw: unknown): Settings['spaceKeybinds'] {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  const out: SpaceKeybindsLike = {}
  if (isMods(o.switchUnpinned)) out.switchUnpinned = o.switchUnpinned
  if (isMods(o.switchPinned)) out.switchPinned = o.switchPinned
  if (isKeyBinding(o.cycleNext)) out.cycleNext = o.cycleNext
  if (isKeyBinding(o.cyclePrev)) out.cyclePrev = o.cyclePrev

  // Pairwise de-dup, fixed precedence (switchUnpinned/cycleNext win). A
  // settings.json hand-edited into binding two actions identically would
  // otherwise make the LOSER unreachable at match time — exactly what this
  // whole function exists to prevent — rather than refused up front the way
  // the Settings modal's own conflict check refuses it before it is ever
  // saved. ponytail: one pass, not a fixed-point over all four; dropping the
  // loser back to "unset" can only ever re-collide with a rebind that ALSO
  // happens to equal that action's own built-in default, which the modal's
  // capture flow already refuses on the way in. Revisit if that stops holding.
  if (
    out.switchUnpinned && out.switchPinned &&
    modsSignature(out.switchUnpinned) === modsSignature(out.switchPinned)
  ) delete out.switchPinned
  if (
    out.cycleNext && out.cyclePrev &&
    modsSignature(out.cycleNext.mods) === modsSignature(out.cyclePrev.mods) &&
    out.cycleNext.key === out.cyclePrev.key
  ) delete out.cyclePrev

  return Object.keys(out).length ? out : undefined
}

export function getSettings(): Settings {
  try {
    if (!existsSync(file())) return { ...DEFAULTS }
    return normalize({ ...DEFAULTS, ...JSON.parse(readFileSync(file(), 'utf8')) })
  } catch {
    return { ...DEFAULTS }
  }
}

export function setSettings(patch: Partial<Settings>): Settings {
  const merged = normalize({ ...getSettings(), ...patch })
  writeFileSync(file(), JSON.stringify(merged, null, 2), 'utf8')
  return merged
}
