import { app, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'

// Checks GitHub Releases on launch, downloads in the background, and asks
// the user to restart once the update is ready. Packaged builds only.
export function initUpdater(): void {
  if (!app.isPackaged) return

  // KAN-92: macOS auto-update is OFF, deliberately — not broken, not forgotten.
  //
  // The macOS build ships UNSIGNED: Dan decided against an Apple Developer
  // Program membership ($99/yr), so there is no `Developer ID Application`
  // certificate and no notarization. electron-updater's macOS path hands the
  // download to Squirrel.Mac, which verifies the update's code signature
  // against the running app's before swapping it in, and there is no
  // signature for it to verify — the CI log reads
  // "skipped macOS application code signing ... 0 identities found".
  //
  // Left enabled this would download ~100 MB on every launch and then fail at
  // install, which reads to a user as a broken app rather than as an app
  // without a feature. Mac users update by downloading the next DMG; the
  // README's Platform support section says so.
  //
  // Read at call time, not module scope, to match resolveRg() in search.ts —
  // it keeps the branch reachable from a test without a module reload.
  //
  // When a Developer ID certificate exists: delete this branch, add `zip` to
  // build.mac.target, and publish latest-mac.yml with the release. The update
  // feed needs the zip, not the DMG.
  if (process.platform === 'darwin') return

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
