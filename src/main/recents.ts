import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { app } from 'electron';
import type { RecentFolder } from '../shared/types';

export function computeRecents(prev: RecentFolder[], path: string, now: number): RecentFolder[] {
  const without = prev.filter(r => r.path !== path);
  return [{ path, name: basename(path), lastOpened: now }, ...without].slice(0, 20);
}

const file = () => join(app.getPath('userData'), 'recents.json');

export function listRecents(): RecentFolder[] {
  try { return existsSync(file()) ? JSON.parse(readFileSync(file(), 'utf8')) : []; }
  catch { return []; }
}

export function addRecent(path: string): void {
  const next = computeRecents(listRecents(), path, Date.now());
  writeFileSync(file(), JSON.stringify(next, null, 2));
}
