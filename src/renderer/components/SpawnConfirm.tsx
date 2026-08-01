import { useEffect } from 'react'
import type { SpawnConfirmRequest } from '../../shared/types'
import { isMac } from '../keys'

/**
 * KAN-41. The one prompt standing between a prompt-injected agent and Bash at
 * the user's own privilege in a folder the AGENT named. Everything here is
 * about making the user able to see WHAT they are approving:
 *
 *  - the path is shown IN FULL, verbatim, never truncated and never elided in
 *    the middle. `.spawn-path` wraps it instead (see index.css) — a path is
 *    dangerous precisely at the part an ellipsis eats, and
 *    `C:\Users\me\repo\...\node_modules\evil` reads as trustworthy.
 *  - nothing on this dialog is pre-answered: Deny holds initial focus, so a
 *    stray Enter into a window the user is not looking at refuses.
 *  - Escape and the backdrop are an explicit DENY, not a dismissal. The tool is
 *    blocked on the answer; silence would cost it the full expiry.
 *
 * No new modal shell: this reuses .modal-backdrop / .modal / .modal-actions,
 * the same three classes ConfirmDialog uses. No typed word — CONFIRM is the
 * gate for destructive file operations, and demanding it here would train the
 * user to type it at whatever asks.
 */
export function SpawnConfirm({
  request,
  onAnswer,
}: {
  request: SpawnConfirmRequest
  onAnswer(allow: boolean): void
}) {
  // Main forgets the token at `expiresAt`, so the prompt goes with it — an
  // answer sent after that is one nothing is listening for, and a dialog left
  // on screen would be inviting a click that silently does nothing.
  useEffect(() => {
    const ms = request.expiresAt - Date.now()
    if (ms <= 0) { onAnswer(false); return }
    const t = setTimeout(() => onAnswer(false), ms)
    return () => clearTimeout(t)
  }, [request.token])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onAnswer(false) }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [request.token])

  return (
    <div className="modal-backdrop" onClick={() => onAnswer(false)}>
      <div className="modal spawn-modal" onClick={(e) => e.stopPropagation()}>
        <p>An agent running in Claude Explorer wants to start a new <b>Claude Code</b> session in:</p>
        <code className="spawn-path">{request.path}</code>
        <p className="spawn-warn">
          It will run with your permissions and that folder's CLAUDE.md, hooks and settings —
          the same as launching Claude Code there yourself.
        </p>
        {/* KAN-64. This dialog is only shown once the free allowance is used
            up, and that number is the user's. Someone meeting it for the ninth
            time should not have to go looking for where it lives: name the menu
            path and the accelerator, and say which way it turns in both
            directions. `.settings-hint` is the existing small-print style —
            no second palette, no new class. */}
        <p className="settings-hint">
          You are being asked because Claude has reached the number of sessions it may open on its
          own. Change it in <b>Settings &rsaquo; Preferences…</b> ({isMac() ? '⌘,' : 'Ctrl+,'}): raise it to
          be asked less often, or set it to 0 to be asked every time.
        </p>
        <div className="modal-actions">
          <button autoFocus onClick={() => onAnswer(false)}>Deny</button>
          <button className="primary" onClick={() => onAnswer(true)}>Allow</button>
        </div>
      </div>
    </div>
  )
}
