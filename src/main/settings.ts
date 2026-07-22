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
