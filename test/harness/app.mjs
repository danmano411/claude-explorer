// Drives the real app (out/) so a human — or Claude — can click it and look at
// it. Run `npm run build` first; this launches what's in out/.
//
//   node test/harness/app.mjs                  → screenshot the first window
//   node test/harness/app.mjs shot out.png     → screenshot to a path
//
// Or import launchApp() from an ad-hoc script for anything more involved.
//
// ponytail: no test-runner scaffolding. This is an inspection tool, not a suite.
// If scroll behaviour ever earns real assertions, add a vitest file that imports
// launchApp() — the harness doesn't need to change.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import pw from 'playwright-core';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Module level, evaluated once per node process — so two launchApp() calls in
// ONE script (workspace.mjs's restart round trip) share a profile, while a
// concurrent `npm run dev` or another harness run never collides with it.
const TMP_PROFILE = path.join(os.tmpdir(), `claude-explorer-harness-${process.pid}`);
fs.rmSync(TMP_PROFILE, { recursive: true, force: true });

/**
 * Launch the built app. Returns { app, win, close } — `win` is the renderer
 * Page, so everything Playwright can do to a web page works on it.
 *
 * `userDataDir` defaults to a throwaway per-run profile (TMP_PROFILE), because
 * the single-instance lock (KAN-4) is keyed on userData: sharing the real dev
 * profile while `npm run dev` is up makes this hang for `timeout` ms instead of
 * working — the second instance exits before it ever shows a window. A 30 s
 * silent timeout in a tool a single developer runs by hand is worse than a loud
 * failure, so the default is structurally incapable of colliding.
 *
 * Pass `realProfile: true` for an inspection run that wants to see your actual
 * tabs, or an explicit `userDataDir` to control the value (needed when a test
 * also spawns raw electron children with the same --user-data-dir).
 *
 * `extraArgs` are appended after the entry script, which is where Electron
 * leaves them for process.argv — that is how the CLI flags are exercised.
 */
export async function launchApp({
  timeout = 30_000, userDataDir = TMP_PROFILE, realProfile = false, extraArgs = [],
} = {}) {
  // A separate boolean rather than `userDataDir: null` on purpose: a
  // null/undefined distinction is the kind of subtlety that silently
  // reintroduces the bug this default exists to prevent.
  const profile = realProfile ? null : userDataDir;
  const app = await pw._electron.launch({
    executablePath: require('electron'), // outside Electron this export IS the exe path
    args: [
      ...(profile ? [`--user-data-dir=${profile}`] : []),
      path.join(root, 'out/main/index.js'),
      ...extraArgs,
    ],
    cwd: root,
    timeout,
  });
  const win = await app.firstWindow({ timeout });
  await win.waitForSelector('.app', { timeout });

  // NOT app.close(): that hangs forever against our `will-quit` preventDefault
  // (index.ts flushes staged deletes before exiting). Closing the window takes
  // the normal user path — window-all-closed → quit — and exits clean.
  const close = async () => {
    const proc = app.process();
    await win.close().catch(() => {});
    await new Promise((r) => {
      const t = setTimeout(() => { proc.kill(); r(); }, 5_000);
      proc.once('exit', () => { clearTimeout(t); r(); });
    });
  };

  return { app, win, close };
}

if (process.argv[1]?.endsWith('app.mjs')) {
  const out = process.argv[3] || path.join(root, 'test/harness/shot.png');
  // The only caller that genuinely wants the real profile: this is an
  // inspection screenshot of *your* app with *your* tabs.
  const { win, close } = await launchApp({ realProfile: true });
  // The file list renders after an async fsHome() round-trip; wait for a row.
  await win.waitForSelector('.entry', { timeout: 15_000 }).catch(() => {});
  await win.screenshot({ path: out });
  console.log('screenshot:', out);
  await close();
  process.exit(0); // playwright-core's driver keeps the loop alive past close
}
