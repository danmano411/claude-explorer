import { ipcMain } from 'electron';
import { CH } from '../shared/ipc';
import { listSessions } from './sessions';

export function registerSessionsHandlers() {
  ipcMain.handle(CH.sessionsList, (_e, path: string) => listSessions(path));
}
