# Claude Explorer v0.0.3 Implementation Plan — Releases & Auto-Update

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks are LINEAR (each builds on the previous) — no parallel fan-out this release.

**Goal:** Ship releases through GitHub Releases and make the installed app detect a new release, download it in the background, and prompt the user to restart-and-update — no trip back to the repo.

**Architecture:** electron-builder already emits the update feed (`latest.yml` + `.blockmap`) next to the installer; we add a GitHub `publish` provider so `--publish always` uploads all three to a GitHub Release. In the app, `electron-updater` (runtime dep, made by the electron-builder team) checks that feed on launch, auto-downloads, and we show one native dialog on `update-downloaded` → `quitAndInstall()`. Everything is guarded behind `app.isPackaged` so `npm run dev` is untouched.

**Tech Stack:** electron-updater · electron-builder GitHub publish provider · GitHub Releases + `GH_TOKEN`.

## Update cadence decision (answering "every 0.0.X or every 0.X.0?")

**Prompt on every published release — including every 0.0.X.** Rationale:

- `electron-updater` compares plain semver against whatever `latest.yml` is on the newest GitHub Release. It has no notion of "minor vs patch" tiers — you'd have to build skip-logic to NOT prompt on patches, which is extra code to deliver a worse outcome (users stuck on known bugs).
- Downloads are differential (`.blockmap`), so a small patch release is a small download. Prompting is cheap.
- The real knob is **which versions you publish as a GitHub Release**. Tag/publish every version you want users on. If you ever cut an experimental build you *don't* want pushed to everyone, just don't publish a Release for it (or mark it "pre-release" on GitHub — electron-updater ignores pre-releases by default).
- Use `0.X.0` purely as a human signal ("notable feature batch"), not as an update-mechanics boundary.

## Global Constraints

- **Windows-only.** NSIS target; `autoUpdater.quitAndInstall()` runs the NSIS updater.
- **`app.isPackaged` guard.** No update checks in dev — `electron-updater` throws without `app-update.yml`, which only exists in a packaged build.
- **One new runtime dependency: `electron-updater`.** Justified: it is THE standard updater for electron-builder apps and cannot be replicated with stdlib. No other new deps.
- **Fail silent on update errors.** Offline / rate-limited / no releases yet → log and carry on. Never show an error dialog for a failed background check.
- **Unsigned builds are OK.** SmartScreen may warn on first install; auto-updates still work. Code signing is explicitly out of scope for 0.0.3 (revisit if the app gets real distribution).
- **Frozen IPC contract untouched.** This release needs zero renderer changes and zero new IPC channels — the prompt is a native `dialog` from the main process.
- **Version bump** `package.json` → `0.0.3` in the final task.

---

## File Map

- Modify: `package.json` — `electron-updater` dep, `publish` config block, `release` script, version bump.
- Create: `src/main/updater.ts` — check/download/prompt logic.
- Modify: `src/main/index.ts` — call `initUpdater()` after window creation.
- Modify: `README.md` — rewrite the "Updating" section (auto-update is now real).
- Modify: `.private/release-and-updates.md` — replace the "future v0.0.3 candidate" section with the actual release runbook.

---

## Task 1: Publish config + dependency

**Model:** haiku (transcription)

**Files:**
- Modify: `package.json`

**Interfaces produced:** `npm run release` = build + upload to a draft GitHub Release. `electron-updater` importable from main.

- [ ] **Step 1:** `npm install electron-updater` (goes in `dependencies` — it ships in the app).

- [ ] **Step 2:** In `package.json` `build` block, add:

```json
"publish": [
  { "provider": "github", "owner": "danmano411", "repo": "claude-explorer" }
]
```

- [ ] **Step 3:** In `scripts`, add (mirrors the `package` script's ESM flag):

```json
"release": "electron-vite build && set \"NODE_OPTIONS=--experimental-require-module\" && electron-builder --win --publish always"
```

- [ ] **Step 4:** Verify config parses: run `npm run package` once; confirm `dist/latest.yml` and `dist/*.blockmap` exist next to the `.exe` (they should already — publish config doesn't change local output).

- [ ] **Step 5:** Commit: `chore(updater): add electron-updater dep + GitHub publish config + release script`

## Task 2: Main-process updater

**Model:** sonnet

**Files:**
- Create: `src/main/updater.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Produces: `initUpdater(): void` — call once after `createWindow()`.

- [ ] **Step 1:** Create `src/main/updater.ts`:

```ts
import { app, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'

// Checks GitHub Releases on launch, downloads in the background, and asks
// the user to restart once the update is ready. Packaged builds only.
export function initUpdater(): void {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true

  // ponytail: silent failure — offline, rate limit, or no releases yet are
  // all fine; surface errors only if users report stuck versions.
  autoUpdater.on('error', (err) => console.error('[updater]', err.message))

  autoUpdater.on('update-downloaded', (info) => {
    const choice = dialog.showMessageBoxSync({
      type: 'info',
      title: 'Update ready',
      message: `Claude Explorer ${info.version} has been downloaded.`,
      detail: 'Restart now to apply the update, or it will install the next time you quit.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    })
    if (choice === 0) autoUpdater.quitAndInstall()
    // "Later": electron-updater installs automatically on the next quit.
  })

  autoUpdater.checkForUpdates().catch(() => {}) // errors already logged above
}
```

- [ ] **Step 2:** In `src/main/index.ts`, add `import { initUpdater } from './updater'` and call `initUpdater()` immediately after `createWindow()` inside `app.whenReady().then(...)`.

- [ ] **Step 3:** Verify: `npx tsc --noEmit` clean; `npm run dev` launches with no updater activity (isPackaged guard); `npm run package` builds and `dist/win-unpacked/resources/app-update.yml` exists (proves the publish config reached the build).

- [ ] **Step 4:** Commit: `feat(updater): check GitHub Releases on launch, prompt to restart when downloaded`

## Task 3: Docs — README "Updating" rewrite + release runbook

**Model:** haiku

**Files:**
- Modify: `README.md`
- Modify: `.private/release-and-updates.md`

- [ ] **Step 1:** In `README.md`, replace the entire `## Updating` section body with:

```markdown
## Updating

**Installed from a release:** Claude Explorer checks GitHub Releases when it starts. When a new version is available it downloads in the background and asks you to restart — click **Restart now** and you're updated. (Choosing **Later** applies it the next time you quit.) No manual downloads needed.

**Built from source:** auto-update is disabled for local builds (they aren't tied to the release feed). To update:

```bash
git pull
npm install
npm run package
```

Then run the freshly built installer in `dist/` — it upgrades in place.
```

  Also delete the now-false blockquote at the end of the old section ("Auto-update (electron-updater) isn't wired up yet…").

- [ ] **Step 2:** In `.private/release-and-updates.md`, replace the "Auto-update logic for real users (future — v0.0.3 candidate)" section with the actual runbook:

```markdown
## Cutting a release (the runbook)

1. Bump `version` in `package.json` (e.g. `0.0.4`), commit, push to main.
2. Set a GitHub token with `repo` scope: `set GH_TOKEN=<token>` (or `$env:GH_TOKEN='<token>'` in PowerShell).
3. `npm run release` — builds and uploads `.exe` + `latest.yml` + `.blockmap` to a **draft** GitHub Release named `v<version>`.
4. Go to the repo's Releases page, add notes, click **Publish release**.
5. Installed apps pick it up on next launch and prompt to restart.

Cadence: publish a Release for every version users should have — every 0.0.X.
To ship a build WITHOUT pushing it to users, mark the GitHub Release as
"pre-release" (electron-updater skips those) or don't publish one.
Unsigned: SmartScreen warns on first install only; auto-updates still apply.
```

- [ ] **Step 3:** Commit: `docs: auto-update instructions in README; release runbook in .private`

## Task FINAL: Version bump + release dry run

**Model:** sonnet

**Files:**
- Modify: `package.json` (`version` → `0.0.3`)

- [ ] **Step 1:** Bump `version` to `0.0.3`. Run `npm test` and `npx tsc --noEmit` — both clean.

- [ ] **Step 2:** Commit `chore: v0.0.3`, merge/push to main.

- [ ] **Step 3 (human, not agent):** Create a `GH_TOKEN`, run `npm run release`, publish the draft Release `v0.0.3` on GitHub. This is the FIRST release — it seeds the feed. (The 0.0.3 app itself can't have been auto-updated *into*; auto-update proves out when 0.0.4 ships.)

- [ ] **Step 4 (human):** Install `dist/Claude Explorer Setup 0.0.3.exe` locally. Later, when 0.0.4 is published, the installed 0.0.3 should prompt on launch — that's the end-to-end test.

---

## Out of scope (deliberate)

- **Code signing** — unsigned works; add Azure Trusted Signing if SmartScreen complaints matter.
- **"Check for updates" menu item** — launch-time check covers it; add to the Settings menu if users ask.
- **Update channel / skip-this-version UI** — YAGNI at this user count.
- **CI-built releases (GitHub Actions)** — local `npm run release` is fine for one maintainer; move to Actions when contributors cut releases.
