import { ipcMain } from 'electron';
import { CH } from '../shared/ipc';
import { listRecents, addRecent } from './recents';

export function registerRecentsHandlers() {
  ipcMain.handle(CH.recentsList, () => listRecents());
  ipcMain.handle(CH.recentsAdd, (_e, path: string) => addRecent(path));
}
