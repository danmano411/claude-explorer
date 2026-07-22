import { spawn } from 'node:child_process'
import { getSettings } from './settings'

// Launches the configured IDE against a folder. shell:true resolves .cmd shims
// like VS Code's `code` on Windows. ponytail: assumes the command is on PATH;
// the settings modal is the knob to change it.
export function openInIde(folder: string): void {
  const cmd = getSettings().ideCommand || 'code'
  const child = spawn(cmd, [folder], { detached: true, stdio: 'ignore', shell: true })
  child.unref()
}
