import { app } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import type { Settings } from '../shared/types'

const DEFAULTS: Settings = {
  ideCommand: 'code',
  mode: 'explorer',
  groupWithSource: true,
  // KAN-42: default ON. The merge below is what makes a settings.json written
  // before this key existed read as `true` rather than `undefined`.
  agentControl: true,
}
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
