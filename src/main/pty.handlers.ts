import { ipcMain, BrowserWindow } from 'electron';
import { CH } from '../shared/ipc';
import { PtyManager } from './pty';
import { agentSpawnedTabCount } from './workspace';
import type { ClaudeState } from '../shared/types';

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

/**
 * KAN-73. Module scope for the same reason `mgr` is: the hook route lives in
 * mcp.ts, which is reached from an http listener and not from any window
 * closure. Set by registerPtyHandlers below, which src/main/index.ts calls
 * before the window exists and long before any pty can be spawned — so a state
 * arriving before that is impossible rather than merely unlikely, and the
 * `?.` chain below covers the window being closed while a session runs on.
 */
let window: () => BrowserWindow | null = () => null;

/**
 * KAN-73's main handler for CH.claudeState: resolve the Claude session id the
 * hook reported to the pty it belongs to, and broadcast. Returns whether
 * anything was delivered, so the caller can tell "reported for a live tab" from
 * "reported for a session we do not have" without knowing what a ptyId is.
 *
 * Both halves are here rather than in mcp.ts because both are pty facts: `mgr`
 * owns the session -> pty map, and this file already owns the window seam that
 * pty:data and pty:exit are sent down. mcp.ts stays the http layer.
 *
 * An unknown session id is DROPPED HERE, in main. That is the containment for
 * an authenticated caller reporting states for sessions it does not own: it can
 * only ever name a session this app actually spawned and is still running, and
 * the renderer never sees an id main does not have. (A caller holding the token
 * can already call close_tab, so this is not the boundary that matters — the
 * bearer check in mcp.ts is. It is the reason the renderer needs no validation
 * of its own.)
 */
export function deliverClaudeState(sessionId: string, state: ClaudeState): boolean {
  const ptyId = mgr.ptyForSession(sessionId);
  if (!ptyId) return false;
  window()?.webContents.send(CH.claudeState, ptyId, state);
  return true;
}

export function registerPtyHandlers(getWindow: () => BrowserWindow | null) {
  window = getWindow;
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
