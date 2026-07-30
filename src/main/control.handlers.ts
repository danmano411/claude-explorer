import { ipcMain, BrowserWindow } from 'electron'
import { CH } from '../shared/ipc'
import { ControlError, createControlChannel } from './control'
import type { ControlOp, ControlReply, ControlResult } from '../shared/types'

/**
 * KAN-39 electron glue for the control channel. Everything that can be tested
 * without a window lives in ./control — this file is only the two IPC edges:
 * `control:request` out via webContents, `control:reply` back in via ipcMain.
 *
 * It has no ops switch and must not grow one; the renderer owns what an op
 * means. It also has no external caller yet — the MCP server is KAN-40.
 */

let getWin: () => BrowserWindow | null = () => null

const channel = createControlChannel({
  send: (req) => {
    const win = getWin()
    // isDestroyed() as well as null: the window can go away between a caller's
    // decision to ask and this send, and a send on a dead webContents throws.
    if (!win || win.isDestroyed()) throw new ControlError('no-window', 'control: no window')
    win.webContents.send(CH.controlRequest, req)
  },
})

export function registerControlHandlers(getWindow: () => BrowserWindow | null): void {
  getWin = getWindow
  ipcMain.on(CH.controlReply, (_e, reply: ControlReply) => channel.settle(reply))
}

/**
 * Ask the renderer to run one op. Rejects with a ControlError (`no-window` |
 * `timeout` | `renderer`) rather than hanging or resolving null.
 *
 * This is the seam KAN-40 builds on: an MCP tool call becomes exactly one
 * `control({ op, args })`. It deliberately does NOT ride `menu:command` —
 * argv can reach that channel through sendPendingCli, and `openClaudeSession`
 * spawns. See the no-spawn-from-argv note in main/cli.ts and App.tsx applyCli.
 */
export function control(op: ControlOp): Promise<ControlResult> {
  return channel.request(op)
}
