import { useState } from 'react'
import { CONFIRM_WORD, type ConfirmRequest } from '../opresult'

/**
 * THE confirm dialog — the file-policy round-trip, a tab close and a space
 * delete all render this one (KAN-57). Props are unchanged; everything that
 * differs between them rides on the `ConfirmRequest`.
 */
export function ConfirmDialog({
  request,
  onClose,
}: {
  request: ConfirmRequest
  onClose(): void
}) {
  const [typed, setTyped] = useState('')
  const ready = !request.typed || typed === CONFIRM_WORD
  // `confirm` may be sync (a renderer-only action) or async (the policy retry);
  // Promise.resolve flattens both, so the dialog closes when the work settles
  // rather than before it has started.
  const go = () => { if (ready) void Promise.resolve(request.confirm(typed)).finally(onClose) }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        // On the modal, not on the typed input: without a type-to-confirm field
        // there was no input to carry the handler, so Escape did nothing at all
        // — which is the shortcut a keyboard user reaches for first. Keydown
        // bubbles, so the input's Enter handler still gets its own turn.
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }}
      >
        <p>{request.reason}</p>
        {request.typed && (
          <label className="settings-field">
            <span>Type {CONFIRM_WORD} to continue</span>
            <input
              autoFocus
              value={typed}
              placeholder={CONFIRM_WORD}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); go() } }}
            />
          </label>
        )}
        <div className="modal-actions">
          {/* Focus lands on CANCEL, never on the danger button: a stray Enter
              or Space arriving at a dialog that appeared under the pointer must
              not be the thing that kills a session. It also puts focus inside
              the modal, which is what makes Escape above reachable. */}
          <button autoFocus={!request.typed} onClick={onClose}>Cancel</button>
          <button className="danger" disabled={!ready} onClick={go}>
            {request.confirmLabel ?? 'Continue'}
          </button>
        </div>
      </div>
    </div>
  )
}
