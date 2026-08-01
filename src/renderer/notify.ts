import type { ClaudeState, Settings } from '../shared/types'

/**
 * KAN-77/79. Everything here is pure and framework-free EXCEPT `playChime`
 * (touches `AudioContext`) and `showToast` (touches `Notification`) — the two
 * genuinely untestable leaves, kept as small and as separated from the
 * decision logic as possible so a test never has to construct either to prove
 * the RULES: when to fire, when to stay silent, when to coalesce. Do not
 * assert an `AudioContext`/`Notification` was constructed anywhere that tests
 * this file — that is the implementation, never the behaviour (CLAUDE.md).
 */

/**
 * True exactly when this is a fresh transition INTO 'awaiting-input' — the
 * only moment either the chime or the toast may fire. Absence (never
 * reported, per claudestate.ts's own "unknown" contract) counts as "not
 * awaiting-input", so a session's FIRST ever report of 'awaiting-input' also
 * counts as entering it.
 */
export function enteredAwaitingInput(prev: ClaudeState | undefined, next: ClaudeState): boolean {
  return next === 'awaiting-input' && prev !== 'awaiting-input'
}

const CHIME_COOLDOWN_MS = 400

/**
 * The coalescing rule (KAN-77 acceptance #4), as a pure gate over two
 * timestamps instead of a real timer — several sessions blocking within one
 * cooldown window must produce ONE chime, not overlapping ones, and this is
 * provable with plain numbers, no clock, no AudioContext.
 */
export function chimeAllowed(now: number, lastChimeAt: number, cooldownMs = CHIME_COOLDOWN_MS): boolean {
  return now - lastChimeAt >= cooldownMs
}

let lastChimeAt = -Infinity

/**
 * The real audio path. `now` is a parameter (not a captured `Date.now()`) so
 * the cooldown check above is exactly `chimeAllowed` — this function adds
 * nothing but the WebAudio synth and the mutable timestamp.
 *
 * A short two-note chime, synthesized rather than a bundled asset (KAN-77's
 * own ask): zero bytes shipped, no dependency, no asset-licence question.
 */
export function playChime(now: number = Date.now()): void {
  if (!chimeAllowed(now, lastChimeAt)) return
  lastChimeAt = now
  try {
    const ctx = new AudioContext()
    const gain = ctx.createGain()
    gain.connect(ctx.destination)
    gain.gain.setValueAtTime(0.0001, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.26)
    for (const [freq, startOffset] of [[880, 0], [1320, 0.09]] as const) {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = freq
      osc.connect(gain)
      const t0 = ctx.currentTime + startOffset
      osc.start(t0)
      osc.stop(t0 + 0.12)
    }
    setTimeout(() => void ctx.close(), 300)
  } catch {
    // Best-effort: a session needing input is not itself a failure worth
    // surfacing just because this machine's audio stack refused a chime.
  }
}

/**
 * The decision layer for KAN-77: call on every reported (prev, next) pair.
 * No-ops unless unmuted AND this is a fresh entry into 'awaiting-input'.
 * `chime` is injected (defaults to the real `playChime`) purely so a test can
 * assert it WAS or WAS NOT invoked for a given transition/mute combination —
 * "assert on whether the audio path is invoked", per the ticket — without
 * needing a real AudioContext.
 */
export function notifyIfEnteredAwaitingInput(
  prev: ClaudeState | undefined,
  next: ClaudeState,
  muted: boolean,
  chime: () => void = playChime,
): void {
  if (muted) return
  if (!enteredAwaitingInput(prev, next)) return
  chime()
}

/**
 * KAN-79's one suppression rule, as pure logic: no toast when desktop
 * notifications are off (acceptance #3, "declining means no toast ever fires,
 * on any path"), and no toast when the app is already focused AND the blocked
 * tab is already visible (the other acceptance rule) — surfacing a toast for
 * something already on screen would be the "ambush" this ticket explicitly
 * rejects.
 */
export function shouldToast(opts: {
  notifyDesktop: boolean
  appFocused: boolean
  tabVisible: boolean
}): boolean {
  if (!opts.notifyDesktop) return false
  return !(opts.appFocused && opts.tabVisible)
}

/**
 * The real toast. Silent by default: `notifySound` above already owns the
 * sound question, and an OS toast's own default ding would double up with it
 * whenever both switches are on. `setAppUserModelId` (main/index.ts) is what
 * makes the name/icon on this correct in a PACKAGED build — see that file's
 * comment; unpackaged, Windows shows "Electron" regardless, so this function
 * cannot be verified from a dev run.
 */
export function showToast(opts: { spaceName: string; folder: string; onClick: () => void }): void {
  const n = new Notification('Claude needs your input', {
    body: `${opts.spaceName} — ${opts.folder}`,
    silent: true,
  })
  n.onclick = () => opts.onClick()
}

/**
 * KAN-79 show-once rule, as pure logic: "never asked" — the absence of the
 * `notifSetupSeen` key — is the trigger, not the absence of settings.json
 * itself (see that field's doc comment in shared/types.ts for why an
 * upgrading user's file naturally satisfies this the same way a fresh install
 * does).
 */
export function needsNotifSetup(settings: Pick<Settings, 'notifSetupSeen'>): boolean {
  return !settings.notifSetupSeen
}
