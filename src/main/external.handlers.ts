import { ipcMain } from 'electron';
import { CH } from '../shared/ipc';
import { openExternalTerminal } from './external';

export function registerExternalHandlers() {
  ipcMain.handle(CH.externalOpen, (_e, path: string) => openExternalTerminal(path));
}
