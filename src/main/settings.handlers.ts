import { ipcMain } from 'electron'
import { CH } from '../shared/ipc'
import { getSettings, setSettings } from './settings'
import type { Settings } from '../shared/types'

/**
 * `onChange` is KAN-42's kill switch, passed in rather than imported so this
 * file stays a leaf (index.ts owns the agent-control lifecycle). AWAITED before
 * the reply: a renderer that saves `agentControl` and then spawns a tab must not
 * race the listener binding or going away.
 */
export function registerSettingsHandlers(onChange: () => void | Promise<void> = () => {}) {
  ipcMain.handle(CH.settingsGet, () => getSettings())
  ipcMain.handle(CH.settingsSet, async (_e, patch: Partial<Settings>) => {
    const merged = setSettings(patch)
    await onChange()
    return merged
  })
}
