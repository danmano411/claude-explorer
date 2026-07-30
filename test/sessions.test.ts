import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// listSessions resolves its directory from homedir() (node:os) and its cap +
// memo behaviour turns on whether readFile actually ran — so both need a
// double: a fake home directory to point into a disposable temp dir, and a
// counting wrapper around the real readFile so a test can prove a call did
// or didn't happen, not just that the returned data looks right.
const io = vi.hoisted(() => ({ home: '', reads: [] as string[] }));

vi.mock('node:os', async (orig) => {
  const real = await orig<typeof import('node:os')>();
  return { ...real, default: real, homedir: () => io.home };
});

vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>();
  return {
    ...real,
    default: real,
    readFile: async (path: string, ...rest: unknown[]) => {
      io.reads.push(String(path));
      return (real.readFile as (...a: unknown[]) => Promise<string>)(path, ...rest);
    },
  };
});

const { slugForPath, parseSession, listSessions } = await import('../src/main/sessions');

describe('slugForPath', () => {
  it('replaces every non-alphanumeric char with a dash', () => {
    expect(slugForPath('C:\\Users\\danma\\Documents\\Dan\\Projects\\Claude Explorer'))
      .toBe('C--Users-danma-Documents-Dan-Projects-Claude-Explorer');
  });
});

describe('parseSession', () => {
  it('extracts first user prompt as title and newest timestamp', () => {
    const lines = [
      JSON.stringify({ type: 'user', timestamp: '2026-07-20T10:00:00.000Z', message: { role: 'user', content: 'Fix the login bug' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-07-20T10:01:00.000Z', message: { role: 'assistant', content: 'ok' } }),
    ].join('\n');
    const s = parseSession('abc-123', 'C:\\proj', lines, 0);
    expect(s.id).toBe('abc-123');
    expect(s.title).toBe('Fix the login bug');
    expect(s.updated).toBe(Date.parse('2026-07-20T10:01:00.000Z'));
  });

  it('falls back to (untitled) and mtime when no user text present', () => {
    const s = parseSession('x', 'C:\\p', '', 5000);
    expect(s.title).toBe('(untitled)');
    expect(s.updated).toBe(5000);
  });
});

describe('listSessions', () => {
  const FOLDER = 'C:\\some\\project';

  // Every test gets its own fake home (and therefore its own project
  // directory and its own set of full paths), so the module-level memo cache
  // in sessions.ts can never leak a hit from one test into another — a hit
  // requires the exact `<fullPath>:<mtimeMs>` key to already be in the map.
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ce-sessions-'));
    io.home = home;
    io.reads = [];
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function projectDir(): string {
    const dir = join(home, '.claude', 'projects', slugForPath(FOLDER));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  // Deliberately spaced 1 minute apart (well past filesystem mtime
  // resolution) so mtime order is unambiguous: index 0 is oldest, index
  // (count-1) is newest.
  function writeSession(dir: string, index: number, baseMs: number) {
    const id = `s${String(index).padStart(3, '0')}`;
    const file = join(dir, `${id}.jsonl`);
    const ms = baseMs + index * 60_000;
    writeFileSync(file, JSON.stringify({
      // Content timestamp tracks mtime (both increase with index) so the
      // final by-`updated` sort inside listSessions can't tie-break on
      // equal values — every ordering assertion below is unambiguous.
      type: 'user', timestamp: new Date(ms).toISOString(),
      message: { role: 'user', content: `prompt ${index}` },
    }) + '\n');
    const mtime = new Date(ms);
    utimesSync(file, mtime, mtime);
    return id;
  }

  it('returns [] without reading anything when the project directory does not exist', async () => {
    // No projectDir() call — the directory is never created.
    const out = await listSessions(FOLDER);
    expect(out).toEqual([]);
    expect(io.reads).toHaveLength(0);
  });

  it('stats every file but only reads the newest `cap` of them (stat-then-slice-then-parse)', async () => {
    const dir = projectDir();
    const base = Date.UTC(2026, 0, 1);
    const ids = Array.from({ length: 25 }, (_, i) => writeSession(dir, i, base));

    const out = await listSessions(FOLDER, 5);

    // The defect this guards against: reading every file (the pre-KAN-55
    // shape) before ranking, which this would still "pass" on if the
    // assertion only checked out.length — so assert the read COUNT too.
    expect(io.reads).toHaveLength(5);
    expect(out).toHaveLength(5);
    // Newest 5 of 25 are s024..s020 (index 24 has the largest mtime); the
    // 20 oldest files must never have been opened at all.
    const newestFive = ids.slice(20, 25).reverse();
    expect(out.map((s) => s.id)).toEqual(newestFive);
    for (const stale of ids.slice(0, 20)) {
      expect(io.reads.some((p) => p.endsWith(`${stale}.jsonl`))).toBe(false);
    }
  });

  it('defaults the cap to 20 when the caller passes none', async () => {
    const dir = projectDir();
    const base = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 25; i++) writeSession(dir, i, base);

    const out = await listSessions(FOLDER);

    // A regression that dropped the default (or changed it) would show up
    // here as a length other than 20 with no cap argument supplied.
    expect(out).toHaveLength(20);
    expect(io.reads).toHaveLength(20);
  });

  it('does not re-read an unchanged file on a second call (memoized by path+mtime)', async () => {
    const dir = projectDir();
    const base = Date.UTC(2026, 0, 1);
    writeSession(dir, 0, base);
    writeSession(dir, 1, base);

    const first = await listSessions(FOLDER);
    expect(io.reads).toHaveLength(2);

    const second = await listSessions(FOLDER);
    // The regression this catches: removing the memo map (or keying it
    // wrong) makes every rebuild re-read every survivor, so this count would
    // climb to 4 instead of staying at 2.
    expect(io.reads).toHaveLength(2);
    // Same cached object, not just equal content — proves the hit short-
    // circuited parseSession rather than happening to reparse identically.
    expect(second.find((s) => s.title === 'prompt 1')).toBe(first.find((s) => s.title === 'prompt 1'));
  });

  it('re-reads and invalidates a session whose file changed (new mtime, new content)', async () => {
    const dir = projectDir();
    const base = Date.UTC(2026, 0, 1);
    const changedId = writeSession(dir, 0, base);
    writeSession(dir, 1, base);

    const first = await listSessions(FOLDER);
    expect(io.reads).toHaveLength(2);
    expect(first.find((s) => s.id === changedId)!.title).toBe('prompt 0');

    // Rewrite the same id with new content and a strictly newer mtime.
    const file = join(dir, `${changedId}.jsonl`);
    writeFileSync(file, JSON.stringify({
      type: 'user', timestamp: new Date(base + 5000).toISOString(),
      message: { role: 'user', content: 'edited prompt' },
    }) + '\n');
    const newMtime = new Date(base + 10 * 60_000);
    utimesSync(file, newMtime, newMtime);

    const second = await listSessions(FOLDER);
    // Exactly one new read (the changed file) — the OTHER survivor must
    // still come from cache, so this also re-covers the no-over-invalidation
    // half of the memo in the same assertion.
    expect(io.reads).toHaveLength(3);
    // And the stale-cache failure mode: without invalidation this would
    // still read 'prompt 0' from the old cached entry.
    expect(second.find((s) => s.id === changedId)!.title).toBe('edited prompt');
  });
});
