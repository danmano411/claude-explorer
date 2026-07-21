import { ipcMain, BrowserWindow } from 'electron';
import { CH } from '../shared/ipc';
import { PtyManager } from './pty';

export function registerPtyHandlers(getWindow: () => BrowserWindow | null) {
  const mgr = new PtyManager();
  const send = (ch: string, ...args: unknown[]) => getWindow()?.webContents.send(ch, ...args);

  ipcMain.handle(CH.ptySpawn, (_e, opts: { path: string; resumeId?: string }) =>
    mgr.spawn(opts, (id, d) => send(CH.ptyData, id, d), (id, code) => send(CH.ptyExit, id, code)));
  ipcMain.on(CH.ptyWrite, (_e, id: string, data: string) => mgr.write(id, data));
  ipcMain.on(CH.ptyResize, (_e, id: string, cols: number, rows: number) => mgr.resize(id, cols, rows));
  ipcMain.on(CH.ptyKill, (_e, id: string) => mgr.kill(id));
}
