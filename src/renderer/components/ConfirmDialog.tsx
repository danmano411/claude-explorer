import { useState } from 'react'
import { CONFIRM_WORD, type ConfirmRequest } from '../opresult'

export function ConfirmDialog({
  request,
  onClose,
}: {
  request: ConfirmRequest
  onClose(): void
}) {
  const [typed, setTyped] = useState('')
  const ready = !request.typed || typed === CONFIRM_WORD
  const go = () => { if (ready) void request.retry(typed).finally(onClose) }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <p>{request.reason}</p>
        {request.typed && (
          <label className="settings-field">
            <span>Type {CONFIRM_WORD} to continue</span>
            <input
              autoFocus
              value={typed}
              placeholder={CONFIRM_WORD}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); go() }
                else if (e.key === 'Escape') { e.preventDefault(); onClose() }
              }}
            />
          </label>
        )}
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="danger" disabled={!ready} onClick={go}>Continue</button>
        </div>
      </div>
    </div>
  )
}
