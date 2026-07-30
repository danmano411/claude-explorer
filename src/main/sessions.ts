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
 * Parsed sessions, keyed by `<fullPath>:<size>:<mtimeMs>`. Exists because
 * KAN-55 moved Open Recent into the NATIVE menu, whose whole tree is built
 * ahead of the click (Electron menus are static templates): every rebuild
 * would otherwise re-read and re-parse every jsonl of every recent folder.
 *
 * Size is in the key because mtime ALONE is not enough on Windows: the system
 * clock ticks at ~15.6ms and NTFS timestamps follow it, so an append landing in
 * the same tick as the previous write keeps an identical mtimeMs (measured
 * here: 111 of 200 back-to-back write+append pairs) and would be served stale
 * forever. A jsonl only ever grows, so an append always moves the size.
 *
 * What still slips through: an in-place edit that preserves the byte length AND
 * lands inside the same clock tick. Claude only appends, so that is not a shape
 * this cache sees.
 *
 * Bounded by evicting the OLDEST keys (a Map iterates in insertion order), not
 * by clearing. The ceiling is genuinely unbounded: the MENU contributes at most
 * recents (20 folders) x its own cap (20) = 400 keys, but sessions:list is
 * uncapped by design — it is the resume oracle (see listSessions below) — so a
 * single folder inserts one key per transcript it owns, 44 measured on this
 * repo, and transcripts only accumulate. 20 recents averaging 150 transcripts
 * is 3000 keys, past the limit. clear() made that a cliff: one overflow threw
 * away every entry and the next menu rebuild re-parsed every file of every
 * recent folder. Evicting the coldest few has no such edge.
 *
 * ponytail: FIFO, not LRU — a hit does not move a key back to the end. Every
 * rebuild touches the same keys in the same order, so insertion order and
 * recency largely agree here. Reach for a real LRU if a profile shows the
 * re-parse mattering.
 */
const parsed = new Map<string, ClaudeSession>();
const PARSED_MAX = 2000;

/**
 * Newest-first sessions for a folder; `cap` limits how many are parsed.
 *
 * Order of work is load-bearing: readdir + stat FIRST, sort by mtime, slice,
 * and only then read/parse the survivors. A long-lived repo has hundreds of
 * jsonl files and the old shape read every one of them to display twenty.
 *
 * mtime is the proxy for `updated` while ranking (the real value is inside the
 * file we haven't read yet). They agree except when something touches a jsonl
 * without appending a newer timestamp, which is not a case worth a second pass.
 *
 * The default is UNCAPPED, and must stay that way: sessions:list is not only a
 * display list, it is the resume ORACLE. App.tsx's spawnFor() asks whether a
 * restored tab's sessionId appears here and picks `--resume` vs `--session-id`
 * on the answer (claude rejects --session-id for an id that already has a
 * transcript, see pty.ts). A cap here silently makes every conversation outside
 * the newest N unresumable. Capping is a MENU concern — menu.ts passes its own.
 */
export async function listSessions(folderPath: string, cap = Infinity): Promise<ClaudeSession[]> {
  const dir = join(homedir(), '.claude', 'projects', slugForPath(folderPath));
  let files: string[];
  try { files = (await readdir(dir)).filter(f => f.endsWith('.jsonl')); }
  catch { return []; }
  const stats = await Promise.all(files.map(async (f) => {
    const full = join(dir, f);
    // Raced against a delete, or unreadable: skip it rather than fail the list.
    try { const st = await stat(full); return { f, full, mtimeMs: st.mtimeMs, size: st.size }; }
    catch { return null; }
  }));
  const top = stats
    .filter((s): s is { f: string; full: string; mtimeMs: number; size: number } => s !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, cap);
  const out = await Promise.all(top.map(async ({ f, full, mtimeMs, size }) => {
    const key = `${full}:${size}:${mtimeMs}`;
    const hit = parsed.get(key);
    if (hit) return hit;
    const jsonl = await readFile(full, 'utf8').catch(() => '');
    const session = parseSession(f.replace(/\.jsonl$/, ''), folderPath, jsonl, mtimeMs);
    parsed.set(key, session);
    while (parsed.size > PARSED_MAX) parsed.delete(parsed.keys().next().value!);
    return session;
  }));
  return out.sort((a, b) => b.updated - a.updated);
}
