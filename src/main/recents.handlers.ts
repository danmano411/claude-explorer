import { ipcMain } from 'electron';
import { CH } from '../shared/ipc';
import { listRecents, addRecent, removeRecent } from './recents';
import { buildMenu } from './menu';

// The recents list IS the File > Open Recent tree (KAN-55), and a native menu is
// a static template — so every mutation has to rebuild it. Fire-and-forget: the
// renderer's `await recentsAdd(...)` should not wait on reading every recent
// folder's session directory.
export function registerRecentsHandlers() {
  ipcMain.handle(CH.recentsList, () => listRecents());
  ipcMain.handle(CH.recentsAdd, (_e, path: string) => { addRecent(path); void buildMenu(); });
  ipcMain.handle(CH.recentsRemove, (_e, path: string) => { removeRecent(path); void buildMenu(); });
}
