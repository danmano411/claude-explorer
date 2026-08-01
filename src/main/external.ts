import { spawn } from 'node:child_process';
import { dialog } from 'electron';

// ponytail: assumes `claude` is on PATH in the spawned shell; add a config override if not.
export function openExternalTerminal(path: string): void {
  if (process.platform === 'win32') return openWindows(path);
  if (process.platform === 'darwin') return openMac(path);
  return openLinux(path);
}

// --- Windows: unchanged from 0.9.0, deliberately. ------------------------------

function openWindows(path: string): void {
  // Windows Terminal: -d sets the start dir; run claude in a persistent PowerShell.
  try {
    const wt = spawn('wt.exe', ['-d', path, 'powershell', '-NoExit', '-Command', 'claude'], {
      detached: true, stdio: 'ignore',
    });
    wt.on('error', () => fallback(path));
    wt.unref();
  } catch {
    fallback(path);
  }
}

function fallback(path: string): void {
  const ps = spawn('powershell', ['-NoExit', '-Command', `Set-Location -LiteralPath '${path.replace(/'/g, "''")}'; claude`], {
    detached: true, stdio: 'ignore', shell: false,
  });
  ps.unref();
}

// --- macOS --------------------------------------------------------------------

/**
 * A folder name is user data, and here it has to survive TWO parsers: AppleScript
 * (which is reading a string literal) and then the shell Terminal.app hands the
 * result to. Each layer gets the escape it actually needs, and neither is
 * home-rolled quoting:
 *
 *  - shell: AppleScript's own `quoted form of`, which exists precisely for this
 *    and is what `osascript` documentation points at. A folder named
 *    `; rm -rf ~` comes out as one literal argument.
 *  - AppleScript literal: backslash and double-quote, the only two characters
 *    that can end a literal early. Both are legal in a macOS filename.
 *
 * Escaped in that order — backslashes first, or the backslashes this function
 * itself introduces would be escaped a second time.
 */
export function appleScriptLiteral(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function openMac(path: string): void {
  // Terminal.app ships with every macOS, so there is no chain to walk here.
  // `do script` in a fresh window, then activate so it comes forward.
  const script = [
    'tell application "Terminal"',
    `  do script "cd " & quoted form of ${appleScriptLiteral(path)} & " && claude"`,
    '  activate',
    'end tell',
  ].join('\n');
  try {
    const p = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' });
    p.on('error', (err) => explain(`Could not open Terminal: ${err.message}`));
    p.unref();
  } catch (err) {
    explain(`Could not open Terminal: ${(err as Error).message}`);
  }
}

// --- Linux --------------------------------------------------------------------

/**
 * There is no `wt.exe` on Linux and no interface that names the user's terminal,
 * so the only thing left is to try the ones that exist. Ordered by desktop
 * share; the first that does not fail to launch wins.
 *
 * The working directory is passed BOTH as the emulator's own flag and as the
 * child's cwd, which is not belt-and-braces: gnome-terminal is a thin client to
 * an already-running gnome-terminal-server, so the new window inherits the
 * SERVER's cwd and only --working-directory actually places it. xterm has no
 * such flag and is placed by cwd alone.
 *
 * Nothing from `path` reaches a shell: it is one argv entry, and the command is
 * the constant below. That is the whole reason this does not need the quoting
 * dance the Windows fallback does.
 *
 * ponytail: four hard-coded emulators, not a `x-terminal-emulator` /
 * $TERMINAL / .desktop lookup. These four cover GNOME, KDE, XFCE and bare X;
 * a user on kitty or alacritty gets the explained failure below and can open a
 * terminal themselves. Add a setting the day someone asks.
 */
const RUN = 'claude; exec bash'; // exec bash == PowerShell's -NoExit: the window stays

const LINUX_TERMINALS: { cmd: string; args: (path: string) => string[] }[] = [
  { cmd: 'gnome-terminal', args: (p) => [`--working-directory=${p}`, '--', 'bash', '-c', RUN] },
  { cmd: 'konsole', args: (p) => ['--workdir', p, '-e', 'bash', '-c', RUN] },
  { cmd: 'xfce4-terminal', args: (p) => [`--working-directory=${p}`, '-x', 'bash', '-c', RUN] },
  { cmd: 'xterm', args: () => ['-e', 'bash', '-c', RUN] },
];

function openLinux(path: string, i = 0): void {
  const t = LINUX_TERMINALS[i];
  if (!t) {
    return explain(
      'No supported terminal emulator was found. Claude Explorer looks for ' +
        LINUX_TERMINALS.map((x) => x.cmd).join(', ') +
        '. Install one of them, or open a terminal yourself and run: claude',
    );
  }
  try {
    const p = spawn(t.cmd, t.args(path), { cwd: path, detached: true, stdio: 'ignore' });
    // ENOENT for "not installed" arrives here, asynchronously — so the chain is
    // walked by the error handler rather than by probing PATH first.
    p.on('error', () => openLinux(path, i + 1));
    p.unref();
  } catch {
    openLinux(path, i + 1);
  }
}

// --- Failure ------------------------------------------------------------------

/** The POSIX arms can genuinely have nowhere to go, and the button silently
 *  doing nothing is the worst possible version of that. showMessageBox, NOT
 *  showErrorBox/showMessageBoxSync: the sync spellings pump a nested message
 *  loop that stops main's event loop dead, which is the freeze KAN-70 fixed. */
function explain(message: string): void {
  console.error('[external]', message);
  void dialog
    .showMessageBox({ type: 'error', title: 'Open in Terminal', message })
    .catch(() => {});
}
