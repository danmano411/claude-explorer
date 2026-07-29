import { ipcMain } from 'electron'
import { CH } from '../shared/ipc'
import { getWorkspace, setWorkspace } from './workspace'
import type { Workspace } from '../shared/types'

export function registerWorkspaceHandlers(): void {
  ipcMain.handle(CH.workspaceGet, () => getWorkspace())
  ipcMain.handle(CH.workspaceSet, (_e, w: Workspace) => setWorkspace(w))
}
