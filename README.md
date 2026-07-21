# Claude Explorer

A Windows desktop file manager built for one thing: **launching [Claude Code](https://claude.com/claude-code) from any folder in a single click.** It works like File Explorer — browse, rename, copy, move, delete — but every folder has a shortcut straight into a Claude Code session running in an embedded terminal.

![Retro Claude aesthetic — warm paper, clay accents, serif chrome](img/icon.png)

## Why

If you live in Claude Code, you spend a lot of time `cd`-ing into project folders and typing `claude`. Claude Explorer collapses that into browsing to a folder and clicking an arrow. Sessions run *inside* the app, in tabs, so you can have several projects open at once and resume past conversations without touching a terminal.

## Features

- **One-click launch** — an orange arrow on every folder row opens Claude Code in that directory, in an embedded terminal (xterm + a real PTY).
- **Browser-style tabs** — each tab is independently a file view *or* a Claude terminal. Reorder them by dragging; closing a tab focuses the most recent one (never a blank screen).
- **Open Recent** — recent folders plus resumable Claude sessions, parsed straight from `~/.claude/projects`. Start fresh or resume an existing conversation; prune entries you don't want.
- **Full file management** — rename, copy, cut, paste, delete (to the Recycle Bin), new folder/file. Right-click menu, `Ctrl+C/X/V`, `F2`, `Del`, and full `Ctrl+Z` / `Ctrl+Y` undo/redo (delete included).
- **Drag and drop** — within a folder, into subfolders, and across tabs. Windows move/copy conventions (same drive = move, cross-drive = copy, `Ctrl` = copy, `Shift` = move, right-drag = menu). Multiselect with `Shift`/`Ctrl`.
- **Navigation** — back / forward / refresh and an editable address bar.
- **Retro Claude look** — warm paper, clay accents, serif chrome, mono data.

## Install (end users)

Grab the latest installer from the [Releases page](https://github.com/danmano411/claude-explorer/releases), run `Claude Explorer Setup x.y.z.exe`, and follow the prompts.

The installer creates a **Desktop shortcut** and a **Start Menu** entry. To pin it to the taskbar, right-click the running app (or its Start Menu entry) → **Pin to taskbar**.

**Prerequisite:** Claude Code must be installed and on your `PATH` (or at `~/.local/bin/claude`). Claude Explorer launches your existing `claude` CLI — it doesn't bundle one. Install it from [claude.com/claude-code](https://claude.com/claude-code).

## Build it yourself

```bash
git clone https://github.com/danmano411/claude-explorer.git
cd claude-explorer
npm install

npm run dev        # run in development
npm test           # run the unit suite
npm run package    # build the Windows installer -> dist/
```

`npm run package` runs `electron-vite build` then `electron-builder --win`, producing `dist/Claude Explorer Setup x.y.z.exe`.

## Updating

Claude Explorer does **not** auto-update. Updates are manual and in-place — a new installer upgrades an existing install without you having to uninstall first.

**If you installed from a release:** download the newer `Claude Explorer Setup x.y.z.exe` from [Releases](https://github.com/danmano411/claude-explorer/releases) and run it. Your existing shortcuts and taskbar pin keep working.

**If you build from source:**

```bash
git pull
npm install        # in case dependencies changed
npm run package
```

Then run the freshly built installer in `dist/`. The app version lives in `package.json` (`version`); bump it before packaging so the installer name and About reflect the new release.

> Auto-update (electron-updater) isn't wired up yet — it needs a release feed and code signing. Contributions welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Tech stack

Electron + electron-vite · React + TypeScript · [node-pty](https://github.com/microsoft/node-pty) (embedded terminal) · [@xterm/xterm](https://xtermjs.org/) · Vitest. Packaged with electron-builder (NSIS).

## License

[Apache License 2.0](LICENSE) © Claude Explorer contributors.
