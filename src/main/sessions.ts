import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ClaudeSession } from '../shared/types';

export function slugForPath(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-');
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const t = content.find((b: any) => b?.type === 'text');
    return t?.text ?? '';
  }
  return '';
}

export function parseSession(id: string, folderPath: string, jsonl: string, mtime: number): ClaudeSession {
  let title = '';
  let updated = 0;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
    if (!Number.isNaN(ts)) updated = Math.max(updated, ts);
    if (!title && obj.type === 'user' && obj.message?.role === 'user') {
      const t = textOf(obj.message.content).trim();
      if (t && !t.startsWith('<')) title = t.slice(0, 80);
    }
  }
  return { id, folderPath, title: title || '(untitled)', updated: updated || mtime };
}

export async function listSessions(folderPath: string): Promise<ClaudeSession[]> {
  const dir = join(homedir(), '.claude', 'projects', slugForPath(folderPath));
  let files: string[];
  try { files = (await readdir(dir)).filter(f => f.endsWith('.jsonl')); }
  catch { return []; }
  const out = await Promise.all(files.map(async (f) => {
    const full = join(dir, f);
    const [jsonl, st] = await Promise.all([readFile(full, 'utf8').catch(() => ''), stat(full)]);
    return parseSession(f.replace(/\.jsonl$/, ''), folderPath, jsonl, st.mtimeMs);
  }));
  return out.sort((a, b) => b.updated - a.updated);
}
