import { ipcMain, BrowserWindow } from 'electron';
import { CH } from '../shared/ipc';
import { PtyManager } from './pty';
import { agentSpawnedTabCount } from './workspace';

// Module scope since KAN-41: the MCP layer needs the live agent-session count
// for its cap, and a manager created inside register…() is unreachable from
// there. One app, one window, one PtyManager — the local was never doing more.
const mgr = new PtyManager();

/**
 * Agent sessions the cap has to count. `mgr.agentSessions()` alone (KAN-41)
 * only sees a LIVE pty, so right after a restart a restored agent tab — which
 * spawns on first activation, not at launch — is invisible to it until the
 * user clicks it (KAN-64). `agentSpawnedTabCount()` reads the persisted
 * workspace instead, which counts a restored tab whether or not it has ever
 * been given a process.
 *
 * `Math.max`, not a sum: once a restored tab IS activated it is BOTH a live
 * handle in `mgr` AND (once the debounced persist catches up) still an
 * agent-spawned tab on disk — the same session, not a second one — so adding
 * the two would double-count it. Taking the max means the cap is never looser
 * than `mgr.agentSessions()` alone used to be (closing the gap can only make
 * it stricter), and it stays exact once every restored tab has settled either
 * to "activated" (mgr counts it) or "closed" (neither does).
 */
export const agentSessionCount = (): number => Math.max(mgr.agentSessions(), agentSpawnedTabCount());

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
