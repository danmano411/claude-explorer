import { describe, it, expect, vi } from 'vitest'

/**
 * KAN-92. The macOS build ships unsigned, and electron-updater cannot install a
 * macOS update without a Developer ID signature — Squirrel.Mac checks it. Left
 * enabled, initUpdater() would download ~100 MB on every mac launch and fail at
 * install time. The ticket's acceptance criterion is that it be "explicitly
 * disabled rather than silently broken", so the assertion is behavioural: on
 * darwin, initUpdater() must not reach the network at all.
 *
 * initUpdater() reads process.platform at CALL time (same reasoning as
 * resolveRg() in search.ts), so the platform is moved around the call and no
 * module reload is needed.
 */

const box = vi.hoisted(() => ({ isPackaged: true, checks: 0, handlers: [] as string[] }))

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return box.isPackaged
    },
  },
  dialog: { showMessageBoxSync: () => 1 },
}))

vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false,
    on(event: string) {
      box.handlers.push(event)
    },
    checkForUpdates() {
      box.checks++
      return Promise.resolve(null)
    },
    quitAndInstall() {},
  },
}))

const { initUpdater } = await import('../src/main/updater')

/** Run initUpdater() as `platform` would, and report what it did. */
function run(platform: string, packaged = true): { checks: number; handlers: string[] } {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  box.isPackaged = packaged
  box.checks = 0
  box.handlers = []
  try {
    initUpdater()
    return { checks: box.checks, handlers: box.handlers }
  } finally {
    Object.defineProperty(process, 'platform', real)
    box.isPackaged = true
  }
}

describe('macOS auto-update is explicitly disabled', () => {
  it('darwin never checks for updates', () => {
    expect(run('darwin').checks).toBe(0)
  })

  it('darwin registers no listeners either — nothing is armed to fire later', () => {
    // Not decoration: `update-downloaded` is what shows the "Restart now"
    // dialog. Bailing out AFTER wiring it would leave a mac user a restart
    // prompt for an update that can never install.
    expect(run('darwin').handlers).toEqual([])
  })
})

describe('the platforms that can update still do', () => {
  it('win32 checks for updates', () => {
    expect(run('win32').checks).toBe(1)
  })

  it('linux checks for updates — the AppImage feed is real', () => {
    expect(run('linux').checks).toBe(1)
  })

  it('and both wire up the update-downloaded prompt', () => {
    expect(run('win32').handlers).toContain('update-downloaded')
    expect(run('linux').handlers).toContain('update-downloaded')
  })
})

describe('unpackaged runs are untouched', () => {
  it('no platform checks for updates from a dev build', () => {
    for (const p of ['win32', 'darwin', 'linux']) {
      expect(run(p, false).checks).toBe(0)
    }
  })
})
