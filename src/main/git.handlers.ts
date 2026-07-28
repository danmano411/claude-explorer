import { ipcMain } from 'electron'
import { CH } from '../shared/ipc'
import { gitStatus, gitDiff } from './git'

// Read-only: no policy gate, and nothing throws — every refusal is a typed arm.
export function registerGitHandlers(): void {
  ipcMain.handle(CH.gitStatus, (_e, dir: string) => gitStatus(dir))
  ipcMain.handle(CH.gitDiff, (_e, path: string) => gitDiff(path))
}
