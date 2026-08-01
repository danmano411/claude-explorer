import { app, nativeImage, type BrowserWindow, type NativeImage } from 'electron'

/**
 * KAN-78. Turns "does anything need attention right now" (one boolean, from
 * the renderer's `attentionNeeded()` — src/renderer/attention.ts) into the OS
 * call, per platform.
 *
 * NOT `app.setBadgeCount()` on Windows: verified a no-op there — Electron's
 * own docs tag it Linux/macOS only, so building on it would silently do
 * nothing on the one platform this app ships on today. NOT
 * `win.setProgressBar()` either: it renders as a stuck download and means the
 * wrong thing entirely.
 *
 * Every branch is reached only through the `process.platform` switch below,
 * which is the "no-op fallback" the ticket asks for — darwin/linux are the
 * per-platform table from KAN-78's research, wired now so nothing crashes
 * when M9 adds those platforms for real, but unverified on real hardware
 * (this machine is Windows).
 */
export function applyAttention(win: BrowserWindow, needsAttention: boolean): void {
  if (win.isDestroyed()) return
  switch (process.platform) {
    case 'win32':
      win.setOverlayIcon(
        needsAttention ? badgeIcon() : null,
        needsAttention ? 'A Claude session needs your input' : '',
      )
      // Reserved for the genuinely-blocked case by construction: this
      // function only ever gets called with `true` when attentionNeeded()
      // found an 'awaiting-input' session, never an 'idle' one — see that
      // function's doc for why idle is excluded up front rather than
      // filtered back out here.
      win.flashFrame(needsAttention)
      break
    case 'darwin':
      // setOverlayIcon is a no-op on macOS (the inverse of the win32 case
      // above), so the badge lives on the dock/app icon instead.
      app.setBadgeCount(needsAttention ? 1 : 0)
      if (needsAttention) app.dock?.bounce('critical') // returns -1 and no-ops if already focused; expected, not a bug
      break
    default:
      // Linux: setBadgeCount is Unity-Launcher-only and does nothing on a
      // plain GNOME Shell. Best-effort, and there is no urgency mechanism
      // worth calling here.
      app.setBadgeCount(needsAttention ? 1 : 0)
  }
}

/**
 * The overlay icon: a 16x16 filled circle in the Retro Claude clay accent
 * (`--clay`, index.css), generated rather than shipped as a binary asset —
 * one procedural buffer is less to carry around than a PNG round-tripped
 * through a design tool for a single solid circle.
 *
 * `nativeImage.createFromBuffer` over `createFromDataURL`: the latter decodes
 * PNG/JPEG, which would mean hand-rolling a PNG encoder for one shape; a raw
 * bitmap buffer needs no codec at all. Built once and cached — the bitmap
 * never changes, so there is nothing to gain from rebuilding it on every
 * `setAttention(true)`.
 */
let cachedIcon: NativeImage | null = null

const SIZE = 16
const CLAY_R = 0xc1
const CLAY_G = 0x5f
const CLAY_B = 0x3c

function badgeIcon(): NativeImage {
  if (cachedIcon) return cachedIcon
  const buf = Buffer.alloc(SIZE * SIZE * 4) // zeroed = fully transparent
  const c = (SIZE - 1) / 2 // 7.5: the center of a 16px square
  const r2 = c * c // radius that just touches all four edges
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if ((x - c) ** 2 + (y - c) ** 2 > r2) continue // outside the circle: stays transparent
      const i = (y * SIZE + x) * 4
      // BGRA byte order — nativeImage's raw-bitmap format on the
      // little-endian Windows/x86 this app ships on (the only platform this
      // branch of badgeIcon() is ever called from; see applyAttention above).
      buf[i] = CLAY_B; buf[i + 1] = CLAY_G; buf[i + 2] = CLAY_R; buf[i + 3] = 0xff
    }
  }
  cachedIcon = nativeImage.createFromBuffer(buf, { width: SIZE, height: SIZE })
  return cachedIcon
}
