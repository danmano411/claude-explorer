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
function normalize(s: Settings): Settings {
  const n = (AGENT_FREE_SESSION_CHOICES as readonly number[]).includes(s.agentFreeSessions)
    ? s.agentFreeSessions
    : DEFAULT_AGENT_FREE_SESSIONS
  return n === s.agentFreeSessions ? s : { ...s, agentFreeSessions: n }
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
