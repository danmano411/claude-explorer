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
import pw from 'playwright-core';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Launch the built app. Returns { app, win, close } — `win` is the renderer
 * Page, so everything Playwright can do to a web page works on it.
 *
 * `userDataDir` points the app at a throwaway profile. Pass it for anything that
 * asserts on persisted state: the app now restores the previous workspace, so a
 * test sharing the real profile both accumulates other runs' tabs (a stale tab
 * gets measured instead of the fresh one) and does not start at home. Leaving it
 * unset keeps the real profile, which is what an inspection run wants.
 */
export async function launchApp({ timeout = 30_000, userDataDir } = {}) {
  const app = await pw._electron.launch({
    executablePath: require('electron'), // outside Electron this export IS the exe path
    args: [
      ...(userDataDir ? [`--user-data-dir=${userDataDir}`] : []),
      path.join(root, 'out/main/index.js'),
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
  const { win, close } = await launchApp();
  // The file list renders after an async fsHome() round-trip; wait for a row.
  await win.waitForSelector('.entry', { timeout: 15_000 }).catch(() => {});
  await win.screenshot({ path: out });
  console.log('screenshot:', out);
  await close();
  process.exit(0); // playwright-core's driver keeps the loop alive past close
}
