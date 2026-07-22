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
