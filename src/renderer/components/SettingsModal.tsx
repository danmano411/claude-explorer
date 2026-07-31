import { useEffect, useState } from 'react'

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [ideCommand, setIdeCommand] = useState('')
  const [groupWithSource, setGroupWithSource] = useState(true)
  const [agentControl, setAgentControl] = useState(true)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    window.api.settingsGet().then((s) => {
      setIdeCommand(s.ideCommand)
      setGroupWithSource(s.groupWithSource)
      setAgentControl(s.agentControl)
      setLoaded(true)
    })
  }, [])

  const save = async () => {
    await window.api.settingsSet({
      ideCommand: ideCommand.trim() || 'code',
      groupWithSource,
      agentControl,
    })
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
        <label className="settings-checkbox">
          <input
            type="checkbox"
            data-setting="groupWithSource"
            checked={groupWithSource}
            disabled={!loaded}
            onChange={(e) => setGroupWithSource(e.target.checked)}
          />
          <span>Group new tabs with their source</span>
        </label>
        <label className="settings-checkbox">
          <input
            type="checkbox"
            data-setting="agentControl"
            checked={agentControl}
            disabled={!loaded}
            onChange={(e) => setAgentControl(e.target.checked)}
          />
          <span>Let Claude sessions control Claude Explorer</span>
        </label>
        {/* What KAN-41 actually shipped — the four tools, and the two things
            they are not. Do not soften "next time one starts": toggling off
            does not reach into a session that is already running. */}
        <p className="settings-hint">
          A Claude session in a tab can read the tab list, close tabs, open a git-diff tab, and
          start a new Claude session <em>after you approve that one</em>. It cannot read or change
          your files and cannot type into a terminal. Saving starts or stops the server at once;
          sessions get the change the next time one starts, so ones already running keep what they
          were launched with.
        </p>
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          {/* Saving before settingsGet resolves would write the initial state
              back over the real one — clobbering a custom ideCommand with
              'code' and re-enabling groupWithSource for anyone who turned it
              off. Enter-to-save is already safe (the input is disabled). */}
          <button className="primary" onClick={save} disabled={!loaded}>Save</button>
        </div>
      </div>
    </div>
  )
}
