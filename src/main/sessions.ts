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

/**
 * Parsed sessions, keyed by `<fullPath>:<mtimeMs>` — an edit bumps the mtime and
 * therefore the key, so a hit is always current and there is nothing to
 * invalidate. Exists because KAN-55 moved Open Recent into the NATIVE menu,
 * whose whole tree is built ahead of the click (Electron menus are static
 * templates): every rebuild would otherwise re-read and re-parse every jsonl of
 * every recent folder.
 *
 * ponytail: unbounded but for the size check below — dropping the whole map at
 * 500 entries is a cache flush, not a leak, and 500 is ~25 folders' worth of
 * capped sessions. Reach for an LRU when a profile shows the re-parse mattering.
 */
const parsed = new Map<string, ClaudeSession>();

/**
 * Newest-first sessions for a folder, capped.
 *
 * Order of work is load-bearing: readdir + stat FIRST, sort by mtime, slice,
 * and only then read/parse the survivors. A long-lived repo has hundreds of
 * jsonl files and the old shape read every one of them to display twenty.
 *
 * mtime is the proxy for `updated` while ranking (the real value is inside the
 * file we haven't read yet). They agree except when something touches a jsonl
 * without appending a newer timestamp, which is not a case worth a second pass.
 *
 * ponytail: 20 rows. The ceiling is the MENU, not the data — past a screenful a
 * menu is the wrong control. If anyone needs the 300th session, give Open
 * Recent a search field rather than raising this number.
 */
export async function listSessions(folderPath: string, cap = 20): Promise<ClaudeSession[]> {
  const dir = join(homedir(), '.claude', 'projects', slugForPath(folderPath));
  let files: string[];
  try { files = (await readdir(dir)).filter(f => f.endsWith('.jsonl')); }
  catch { return []; }
  const stats = await Promise.all(files.map(async (f) => {
    const full = join(dir, f);
    // Raced against a delete, or unreadable: skip it rather than fail the list.
    try { return { f, full, mtimeMs: (await stat(full)).mtimeMs }; } catch { return null; }
  }));
  const top = stats
    .filter((s): s is { f: string; full: string; mtimeMs: number } => s !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, cap);
  const out = await Promise.all(top.map(async ({ f, full, mtimeMs }) => {
    const key = `${full}:${mtimeMs}`;
    const hit = parsed.get(key);
    if (hit) return hit;
    const jsonl = await readFile(full, 'utf8').catch(() => '');
    const session = parseSession(f.replace(/\.jsonl$/, ''), folderPath, jsonl, mtimeMs);
    if (parsed.size >= 500) parsed.clear();
    parsed.set(key, session);
    return session;
  }));
  return out.sort((a, b) => b.updated - a.updated);
}
