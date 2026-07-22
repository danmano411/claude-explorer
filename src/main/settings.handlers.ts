import { ipcMain } from 'electron'
import { CH } from '../shared/ipc'
import { getSettings, setSettings } from './settings'
import type { Settings } from '../shared/types'

export function registerSettingsHandlers() {
  ipcMain.handle(CH.settingsGet, () => getSettings())
  ipcMain.handle(CH.settingsSet, (_e, patch: Partial<Settings>) => setSettings(patch))
}
