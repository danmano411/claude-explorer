// KAN-68: does the file-safety gate still freeze the window on an unreachable
// UNC path?
//   npm run build && node test/harness/gate.mjs
//
// policy.ts's gate() is the chokepoint every file operation goes through, and it
// canonicalizes each path before classifying it. Spelt with realpathSync.native
// that cost ~21 SECONDS of pinned main process per unreachable SMB host — no
// IPC, no pty:data, no paint — for any user who typed or dropped such a path.
// KAN-41 and KAN-65 moved the MCP and CLI resolvers off the sync spelling and
// left this one; this harness is the proof that it moved too.
//
// The probe is a REAL filesystem round-trip (fs:list — a readdir plus a stat per
// row, in main) and NOT an event-loop ping. That distinction is the whole point:
// `await` moves the stall off the event loop but not off libuv's four-thread
// pool, so timers keep firing and a ping reports a perfectly healthy app while
// every fs call in it is parked.
//
// Timed from HERE with the wall clock, not inside the renderer. Playwright
// reaches the page through the browser (main) process's CDP endpoint, so a
// frozen main blocks the evaluate itself: an in-page clock never starts and
// honestly reports a few ms for a call this process waited 21 seconds for.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { launchApp } from './app.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// PID-suffixed: the single-instance lock is keyed on userData, and this repo is
// worked on from several worktrees at once — a fixed name makes a concurrent run
// silently forward into this run's window.
const PROFILE = path.join(os.tmpdir(), `claude-explorer-gate-harness-${process.pid}`);
fs.rmSync(PROFILE, { recursive: true, force: true });

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// Random octets, and two DIFFERENT ones. Windows negative-caches an SMB host
// that never answers, so a hardcoded number would be served from cache on a
// re-run minutes later: nothing would stall and this file would pass for the
// wrong reason — vacuous, which is worse than absent. The witness gets its own
// host so resolving it here cannot warm the one the app is handed.
const octet = 30 + Math.floor(Math.random() * 100);
const dead = (n) => `\\\\10.255.255.${n}\\s`;
// git.ts gets its own /24 as well as its own octet: gate() resolves 10.255.255.x
// with realpath, and Windows negative-caches per HOST, so a host this file has
// already made the app resolve would answer from cache and prove nothing.
const deadGit = `\\\\10.255.254.${30 + Math.floor(Math.random() * 100)}\\s`;

console.log(`\ngate() on ${dead(octet)} — a drive root the SMB stack never answers`);

const { win, close } = await launchApp({ userDataDir: PROFILE });
await win.waitForSelector('.tab:not(.add)');
await win.waitForTimeout(1_500);

// A real filesystem request, round-tripped through main, timed on the wall
// clock. The race is what stops a truly wedged main from hanging the harness;
// the evaluate is left to settle on its own, hence the bare catch.
const probe = async () => {
  const t = Date.now();
  const p = win.evaluate((dir) => window.api.fsList(dir).then(() => true, () => true), ROOT);
  p.catch(() => {});
  const ok = await Promise.race([p, new Promise((r) => setTimeout(() => r(false), 40_000))]);
  return [Date.now() - t, ok === true];
};

const [idleMs, idleOk] = await probe();
check('baseline: the window serves a folder listing while idle', idleOk && idleMs < 3_000,
  `${idleMs}ms`);

// A gated file operation whose path resolves instantly — `C:\` is a drive root,
// so gate() DENIES it after one local realpath and the handler never touches
// disk. This is the BEFORE number for the queue check at the bottom: the same
// call, issued while nothing else holds gateOne.
const gatedIdle = async (tag) => {
  const t = Date.now();
  const p = win.evaluate((d) => window.api.fsDelete([d]).then((r) => r, (e) => ({ err: String(e) })),
    'C:\\');
  p.catch(() => {});
  const r = await Promise.race([p, new Promise((res) => setTimeout(() => res(null), 40_000))]);
  return [Date.now() - t, r, tag];
};
const [gatedIdleMs, gatedIdleR] = await gatedIdle();
check('baseline: a gated operation on a local drive root is denied immediately',
  gatedIdleR?.code === 'DENIED' && gatedIdleMs < 3_000,
  `fs:delete C:\\ answered in ${gatedIdleMs}ms with ${gatedIdleR?.code ?? gatedIdleR?.err}`);

// Independent of the app entirely, in this process, started before the app is
// asked to do anything: if an unreachable UNC host stops costing ~21 s on this
// machine (different network, an SMB stack that fails fast), every number below
// proves nothing — so say so and FAIL rather than pass for free.
const witnessAt = Date.now();
const witness = promisify(fs.realpath.native)(dead(octet + 100))
  .then(() => Date.now() - witnessAt, () => Date.now() - witnessAt);

// Kick the file operation off and DO NOT await the evaluate. fs:delete gates its
// paths, so main is now resolving a host that will never answer. A drive root
// specifically, because gate() then DENIES it — the handler returns on the
// verdict and never touches disk again, so the only slow thing in flight is the
// canonicalisation this ticket is about.
//
// Not awaited, and that is load-bearing rather than tidy. The evaluate's RESULT
// comes back through main's CDP endpoint, so against a frozen build `await` on
// it does not return until main is free again — i.e. it swallows the entire
// freeze, and every sample below is then taken of a perfectly healthy app. That
// spelling scored 4/4 against the unmodified build. Fire it, start the clock,
// and sample while it is in flight.
//
// The op is timed in the renderer, which is a different process and never the
// one that freezes, so its clock is honest about how long main took to answer.
const startedAt = Date.now();
const kicked = win.evaluate((p) => {
  window.__gate = { done: false };
  const t0 = performance.now();
  window.api.fsDelete([p]).then(
    (r) => { window.__gate = { done: true, ms: performance.now() - t0, r }; },
    (e) => { window.__gate = { done: true, ms: performance.now() - t0, err: String(e) }; },
  );
}, dead(octet));
kicked.catch(() => {});

// The SECOND gated operation, and the only thing in this file that can see
// gateOne. Everything above passes just as well with no queue at all — one
// in-flight resolution cannot tell a queue of one from no queue — so deleting
// gateOne and letting gate() call resolveReal directly left the whole suite
// green, which made "the window's file operations ride their own queue" a
// convention again rather than a property. This is the assertion that hurts.
//
// `C:\` resolves in ~1 ms (measured above, gatedIdleMs) and is denied for the
// same reason the dead host is, so the ONLY thing that can make it slow is
// waiting its turn behind a resolution that is still in flight. Serialised, it
// answers when the dead host finally does; unserialised, it answers instantly
// while holding a second libuv worker — which is the state this queue exists to
// prevent, and the state the window would be in on a `Promise.all` over a
// multi-select drop.
//
// 300 ms so the ordering is not a race: main takes the two invokes in the order
// the renderer sent them, and this only has to be inside the ~21 s stall.
await win.waitForTimeout(300);
const second = win.evaluate(() => {
  window.__gate2 = { done: false };
  const t0 = performance.now();
  window.api.fsDelete(['C:\\']).then(
    (r) => { window.__gate2 = { done: true, ms: performance.now() - t0, r }; },
    (e) => { window.__gate2 = { done: true, ms: performance.now() - t0, err: String(e) }; },
  );
});
second.catch(() => {});

// Sampled across the whole resolution window rather than once: the worst sample
// is the one that counts. A single probe would race the invoke — CDP delivers
// the kick-off first, but main may still answer a readdir before it picks the
// invoke up — and would then pass against the very build this exists to fail.
// A fixed window rather than "until the op settles", because reading the op's
// state is itself an evaluate, and a stall absorbed by an UNMEASURED round trip
// is a stall this file never sees.
let worstMs = 0;
let served = true;
while (Date.now() - startedAt < 30_000) {
  const [ms, ok] = await probe();
  worstMs = Math.max(worstMs, ms);
  if (!ok) { served = false; break; }
  await win.waitForTimeout(200);
}
const gate = await win.evaluate(() => window.__gate ?? { done: false });
const gate2 = await win.evaluate(() => window.__gate2 ?? { done: false });
const witnessMs = await witness;

// The witness that the app really did the slow work, rather than the check above
// passing because nothing ever stalled: the delete's own round trip. It is slow
// in BOTH builds — the syscall costs what it costs — the fix only stops it being
// charged to everyone else. And its verdict is the file-safety assertion: an
// unreachable UNC drive root is still resolved, still classified, still DENIED.
const denied = gate.done && gate.r?.ok === false && gate.r?.code === 'DENIED';
check('the gated file operation really resolved the dead host, and still denied it',
  denied && gate.ms > 5_000,
  gate.done
    ? `fs:delete answered in ${Math.round(gate.ms)}ms with ${gate.r?.code ?? gate.err}`
      + (gate.ms > 5_000 ? '' : ' — NOT SLOW, so the check below proved nothing')
    : 'fs:delete never answered');

check('an unreachable UNC host really is slow to resolve on this machine',
  witnessMs > 5_000, `${dead(octet + 100)} took ${witnessMs}ms to resolve in this process`);

check('the window still serves a real filesystem request while a gated file operation resolves it',
  served && worstMs < 3_000,
  `folder listing: ${idleMs}ms idle -> worst ${worstMs}ms during the gate`
    + (served ? '' : ' (never completed)'));

// gateOne. Only meaningful because the two facts above hold — the first
// operation really did stall, and `C:\` really is instant when the queue is
// free — so this cannot pass by nothing having happened.
check('a second gated file operation waits its turn rather than taking a second libuv worker',
  gate2.done && gate2.r?.code === 'DENIED' && gate2.ms > 5_000,
  gate2.done
    ? `fs:delete C:\\ answered in ${Math.round(gate2.ms)}ms with ${gate2.r?.code ?? gate2.err}`
      + ` (${gatedIdleMs}ms when the queue was free)`
    : 'fs:delete C:\\ never answered');

// ---------------------------------------------------------------------------
// git.ts, the same freeze through a different door. gitStatus() opened with a
// SYNCHRONOUS existsSync on a renderer-supplied directory, and FileBrowser fires
// it from a `[dir]` effect — so merely NAVIGATING to an unreachable UNC path
// pinned main for ~21 s, with no file operation involved at all. Its own cold
// host, on a subnet nothing above has touched.
console.log(`\ngitStatus(${deadGit}) — the call FileBrowser makes on every navigation`);

const gitAt = Date.now();
const gitKicked = win.evaluate((d) => {
  window.__git = { done: false };
  const t0 = performance.now();
  window.api.gitStatus(d).then(
    (r) => { window.__git = { done: true, ms: performance.now() - t0, ok: r?.ok }; },
    (e) => { window.__git = { done: true, ms: performance.now() - t0, err: String(e) }; },
  );
}, deadGit);
gitKicked.catch(() => {});

let gitWorstMs = 0;
let gitServed = true;
while (Date.now() - gitAt < 30_000) {
  const [ms, ok] = await probe();
  gitWorstMs = Math.max(gitWorstMs, ms);
  if (!ok) { gitServed = false; break; }
  await win.waitForTimeout(200);
}
const git = await win.evaluate(() => window.__git ?? { done: false });

// Same shape as the delete's: the app really did the slow work, so the check
// below is not passing because this host happened to answer.
check('gitStatus really resolved the dead host',
  git.done && git.ms > 5_000,
  git.done ? `gitStatus answered in ${Math.round(git.ms)}ms` : 'gitStatus never answered');

check('the window still serves a real filesystem request while gitStatus resolves a dead host',
  gitServed && gitWorstMs < 3_000,
  `folder listing: ${idleMs}ms idle -> worst ${gitWorstMs}ms during gitStatus`
    + (gitServed ? '' : ' (never completed)'));

await close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log('failing:', failed.map((f) => f.name).join('; '));
process.exit(failed.length ? 1 : 0);
