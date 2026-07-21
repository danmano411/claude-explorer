import { ipcMain } from 'electron';
import { CH } from '../shared/ipc';
import { listRecents, addRecent, removeRecent } from './recents';

export function registerRecentsHandlers() {
  ipcMain.handle(CH.recentsList, () => listRecents());
  ipcMain.handle(CH.recentsAdd, (_e, path: string) => addRecent(path));
  ipcMain.handle(CH.recentsRemove, (_e, path: string) => removeRecent(path));
}
