import { useEffect, useState } from 'react'

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [ideCommand, setIdeCommand] = useState('')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    window.api.settingsGet().then((s) => { setIdeCommand(s.ideCommand); setLoaded(true) })
  }, [])

  const save = async () => {
    await window.api.settingsSet({ ideCommand: ideCommand.trim() || 'code' })
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <label className="settings-field">
          <span>IDE command</span>
          <input
            value={ideCommand}
            placeholder="code"
            disabled={!loaded}
            autoFocus
            onChange={(e) => setIdeCommand(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onClose() }}
          />
        </label>
        <p className="settings-hint">
          Launched as <code>&lt;command&gt; &lt;folder&gt;</code>. Examples: <code>code</code> (VS Code),{' '}
          <code>cursor</code>, <code>idea</code>, <code>subl</code>.
        </p>
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  )
}
