import { ipcMain, BrowserWindow } from 'electron';
import { CH } from '../shared/ipc';
import { PtyManager } from './pty';

// Module scope since KAN-41: the MCP layer needs the live agent-session count
// for its cap, and a manager created inside register…() is unreachable from
// there. One app, one window, one PtyManager — the local was never doing more.
const mgr = new PtyManager();

/** Live Claude sessions the MCP tool started. Read by mcp.ts's spawn guard. */
export const agentSessionCount = (): number => mgr.agentSessions();

export function registerPtyHandlers(getWindow: () => BrowserWindow | null) {
  const send = (ch: string, ...args: unknown[]) => getWindow()?.webContents.send(ch, ...args);

  ipcMain.handle(CH.ptySpawn, (_e, opts: {
    path: string; resumeId?: string; shell?: boolean; sessionId?: string
    agentSpawned?: boolean // KAN-41, pass-through only — spawn() owns the rule
  }) =>
    mgr.spawn(opts, (id, d) => send(CH.ptyData, id, d), (id, code) => send(CH.ptyExit, id, code)));
  ipcMain.on(CH.ptyWrite, (_e, id: string, data: string) => mgr.write(id, data));
  ipcMain.on(CH.ptyResize, (_e, id: string, cols: number, rows: number) => mgr.resize(id, cols, rows));
  ipcMain.on(CH.ptyKill, (_e, id: string) => mgr.kill(id));
}
