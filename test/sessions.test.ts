import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, appendFileSync, statSync } from 'node:fs';
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
  // requires the exact `<fullPath>:<size>:<mtimeMs>` key to already be in the map.
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

  it('does NOT cap by default — sessions:list is the --resume oracle, not just a display list', async () => {
    const dir = projectDir();
    const base = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 25; i++) writeSession(dir, i, base);

    const out = await listSessions(FOLDER);

    // ipcMain's sessions:list handler calls listSessions(path) with no cap,
    // and App.tsx's spawnFor() uses the result as an existence oracle: does a
    // restored tab's sessionId already have a transcript, i.e. --resume vs
    // --session-id (see pty.ts). A default cap here would silently make every
    // session past it unresumable. Only the menu (buildMenu, capped at 20) is
    // allowed to cap — see the doc comment on listSessions in sessions.ts.
    expect(out).toHaveLength(25);
    expect(io.reads).toHaveLength(25);
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

  it('re-reads a file that GREW but kept an identical mtime (the same-clock-tick append)', async () => {
    const dir = projectDir();
    const base = Date.UTC(2026, 0, 1);
    const id = writeSession(dir, 0, base);
    const file = join(dir, `${id}.jsonl`);

    const first = await listSessions(FOLDER);
    expect(io.reads).toHaveLength(1);
    expect(first[0].updated).toBe(base);

    // A live Claude tab appends to its jsonl continuously. On Windows the
    // system clock ticks at ~15.6ms and NTFS mtimes follow it, so an append
    // landing in the same tick as the previous write leaves mtimeMs BIT-FOR-BIT
    // unchanged — 111 of 200 measured back-to-back write+append pairs did
    // exactly that. Reproduce it by appending and then forcing mtime back to
    // the value the first read already memoized against.
    const frozen = new Date(base);
    const { mtimeMs: mtimeBefore, size: sizeBefore } = statSync(file);
    appendFileSync(file, JSON.stringify({
      type: 'assistant', timestamp: new Date(base + 60_000).toISOString(),
      message: { role: 'assistant', content: 'a later turn' },
    }) + '\n');
    utimesSync(file, frozen, frozen);
    // Fixture guard: if utimesSync did not round-trip exactly, the key would
    // differ on mtime alone and the assertions below would pass for the wrong
    // reason — i.e. without proving anything about the size component.
    expect(statSync(file).mtimeMs).toBe(mtimeBefore);
    expect(statSync(file).size).toBeGreaterThan(sizeBefore);

    const second = await listSessions(FOLDER);
    // The defect: with a `<path>:<mtimeMs>` key this is a cache HIT, so the
    // appended turn is invisible for the life of the process and the session
    // keeps reporting the pre-append `updated` forever. Only `size` in the key
    // can tell these two file states apart.
    expect(second[0].updated).toBe(base + 60_000);
    expect(io.reads).toHaveLength(2);
  });

  it('sorts the final result by in-file `updated`, not by the mtime used to rank/cap (CH-1)', async () => {
    const dir = projectDir();
    const base = Date.UTC(2026, 0, 1);

    // writeSession() ties content-timestamp and mtime together by construction
    // (see its comment above), so it can't produce this case — write these two
    // files directly with mtime order and updated order DELIBERATELY reversed.
    // mtime rank: 'stale-mtime' oldest, 'fresh-mtime' newest.
    // updated rank (the in-file timestamp): the opposite way round.
    const write = (id: string, contentMs: number) => {
      const file = join(dir, `${id}.jsonl`);
      writeFileSync(file, JSON.stringify({
        type: 'user', timestamp: new Date(contentMs).toISOString(),
        message: { role: 'user', content: id },
      }) + '\n');
      return file;
    };
    const staleFile = write('stale-mtime', base + 60_000); // oldest mtime, NEWEST updated
    utimesSync(staleFile, new Date(base), new Date(base));
    const freshFile = write('fresh-mtime', base - 60_000); // newest mtime, OLDEST updated
    utimesSync(freshFile, new Date(base + 60_000), new Date(base + 60_000));

    const out = await listSessions(FOLDER);

    // Ranking by mtime (used only to pick the newest `cap` before parsing)
    // would order these ['fresh-mtime', 'stale-mtime']. Only a sort on the
    // parsed `updated` field afterward can produce this, the opposite order.
    expect(out.map((s) => s.id)).toEqual(['stale-mtime', 'fresh-mtime']);
  });

  // Deliberately LAST in this describe: it leaves the module-level memo at its
  // 2000-key ceiling, and it counts the entries evicted, so tests added after
  // it would be measuring a map this one already filled.
  //
  // KAN-88: explicit 30 s timeout, not the 5 s default. This test writes 2001
  // real files, and CLAUDE.md already listed it as a known load-sensitive flake
  // locally (it goes red under a concurrent build in another worktree). On a
  // GitHub runner that is not an occasional flake, it is the normal case — the
  // first CI run timed out here at exactly 5000 ms.
  //
  // The timeout is not what this test asserts. It measures WHICH keys survive
  // eviction, and that assertion is untouched: a slower disk changes how long
  // 2001 writes take and nothing about which entries the memo keeps. Making a
  // required status check flaky is worse than not having one, because a red
  // that means nothing trains people to ignore a red that does.
  it('overflowing the memo evicts the oldest keys, it does not drop the whole map', { timeout: 30_000 }, async () => {
    const dir = projectDir();
    // One more file than the memo holds, so the last insert must evict. Written
    // flat (no per-file utimes/timestamp spread) because nothing here depends on
    // order — only on crossing the threshold — and 2001 files is the slow part.
    const line = JSON.stringify({
      type: 'user', timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'p' },
    }) + '\n';
    for (let i = 0; i < 2001; i++) writeFileSync(join(dir, `s${i}.jsonl`), line);

    await listSessions(FOLDER);
    expect(io.reads).toHaveLength(2001);

    io.reads = [];
    await listSessions(FOLDER);

    // Fixture guard: some entries MUST have been evicted, or the memo never
    // overflowed and the assertion below would hold vacuously (e.g. if the
    // ceiling were raised above 2001 — then raise this fixture with it).
    expect(io.reads.length).toBeGreaterThan(0);
    // The defect: `parsed.clear()` on overflow threw the whole map away, so the
    // very next rebuild re-parsed nearly every file (1961 of 2001 here). Evicting
    // oldest-first costs only the handful actually over the line (~40).
    expect(io.reads.length).toBeLessThan(200);
  });
});
