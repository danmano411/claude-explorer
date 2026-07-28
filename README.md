# Claude Explorer

## Quickstart

Two ways to run Claude Explorer as a desktop app on Windows. Either way you need [Claude Code](https://claude.com/claude-code) installed and on your `PATH` — Claude Explorer launches your existing `claude` CLI, it doesn't bundle one.

**Option A — Installer (from a Release)**
1. Download the latest `Claude Explorer Setup x.y.z.exe` from the [Releases page](https://github.com/danmano411/claude-explorer/releases).
2. Run it. It creates a Desktop shortcut and a Start Menu entry; right-click the app → **Pin to taskbar** to pin it.
3. Running a newer installer later upgrades in place — your recent folders and settings are kept.

**Option B — Build from source**
```bash
git clone https://github.com/danmano411/claude-explorer.git
cd claude-explorer
npm install
npm run package          # builds dist/Claude Explorer Setup x.y.z.exe
```
Then run the installer in `dist/`. (For live development instead of a packaged app, use `npm run dev`.)

---

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

## Safety

Claude Explorer has two modes, toggled from the status bar (the current mode is always visible there):

- **Explorer mode** (default) — behaves like File Explorer. Hidden files and Windows noise (`.git`, `$Recycle.Bin`, `System Volume Information`, …) stay out of the listing, and anything that would mutate a **system path** is refused outright with a plain-English reason.
- **Developer mode** — unlocks the risky half:
  - hidden files and dotfiles appear in the listing, dimmed;
  - mutating a system path is allowed, but only behind a **typed confirmation** — you have to type the word `CONFIRM`;
  - `Shift+Del` performs a **permanent delete** that skips the trash and cannot be undone with `Ctrl+Z` (also typed-confirmed). In Explorer mode this shortcut is refused.

**Protected by default.** `C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)`, `C:\ProgramData`, and drive roots (`C:\`, `D:\`, …) are system paths — the rule matches the folder *and everything beneath it*, so `C:\Windows\System32\drivers` is protected too. The app's own `.claude-explorer-trash` staging folder is off-limits in **both** modes, because changing it would break pending undo. Browsing is never restricted; only mutation is.

Every decision is made in the main process, not the UI, so no call site can forget to ask. This is a guardrail against mis-drags and mistaken deletes — yours or an AI's — not a security sandbox: the app runs a real shell for you on request.

## Updating

**Installed from a release:** Claude Explorer checks GitHub Releases when it starts. When a new version is available it downloads in the background and asks you to restart — click **Restart now** and you're updated. (Choosing **Later** applies it the next time you quit.) No manual downloads needed.

**Built from source:** auto-update is disabled for local builds (they aren't tied to the release feed). To update:

```bash
git pull
npm install
npm run package
```

Then run the freshly built installer in `dist/` — it upgrades in place.

## Tech stack

Electron + electron-vite · React + TypeScript · [node-pty](https://github.com/microsoft/node-pty) (embedded terminal) · [@xterm/xterm](https://xtermjs.org/) · Vitest. Packaged with electron-builder (NSIS).

## License

[Apache License 2.0](LICENSE) © Claude Explorer contributors.
