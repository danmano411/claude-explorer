import { spawn } from 'node:child_process';

// ponytail: assumes `claude` is on PATH in the spawned shell; add a config override if not.
export function openExternalTerminal(path: string): void {
  // Windows Terminal: -d sets the start dir; run claude in a persistent PowerShell.
  try {
    const wt = spawn('wt.exe', ['-d', path, 'powershell', '-NoExit', '-Command', 'claude'], {
      detached: true, stdio: 'ignore',
    });
    wt.on('error', () => fallback(path));
    wt.unref();
  } catch {
    fallback(path);
  }
}

function fallback(path: string): void {
  const ps = spawn('powershell', ['-NoExit', '-Command', `Set-Location -LiteralPath '${path.replace(/'/g, "''")}'; claude`], {
    detached: true, stdio: 'ignore', shell: false,
  });
  ps.unref();
}
