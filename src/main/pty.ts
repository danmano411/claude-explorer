import * as pty from 'node-pty';
import { randomUUID } from 'node:crypto';

type Handle = { proc: pty.IPty };

export class PtyManager {
  private handles = new Map<string, Handle>();

  spawn(opts: { path: string; resumeId?: string }, onData: (id: string, d: string) => void, onExit: (id: string, code: number) => void): string {
    const id = randomUUID();
    // claude launched directly (no shell wrapper) so exit closes the tab cleanly.
    const args = opts.resumeId ? ['--resume', opts.resumeId] : [];
    const proc = pty.spawn('claude', args, {
      name: 'xterm-color',
      cwd: opts.path,
      cols: 80,
      rows: 24,
      env: process.env as Record<string, string>,
    });
    proc.onData((d) => onData(id, d));
    proc.onExit(({ exitCode }) => { onExit(id, exitCode); this.handles.delete(id); });
    this.handles.set(id, { proc });
    return id;
  }

  write(id: string, data: string) { this.handles.get(id)?.proc.write(data); }
  resize(id: string, cols: number, rows: number) { this.handles.get(id)?.proc.resize(cols, rows); }
  kill(id: string) { this.handles.get(id)?.proc.kill(); this.handles.delete(id); }
}
