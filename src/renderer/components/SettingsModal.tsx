import { useEffect, useState } from 'react'
import { AGENT_FREE_SESSION_CHOICES, DEFAULT_AGENT_FREE_SESSIONS } from '../../shared/types'

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [ideCommand, setIdeCommand] = useState('')
  const [groupWithSource, setGroupWithSource] = useState(true)
  const [agentControl, setAgentControl] = useState(true)
  const [agentFreeSessions, setAgentFreeSessions] = useState<number>(DEFAULT_AGENT_FREE_SESSIONS)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    window.api.settingsGet().then((s) => {
      setIdeCommand(s.ideCommand)
      setGroupWithSource(s.groupWithSource)
      setAgentControl(s.agentControl)
      setAgentFreeSessions(s.agentFreeSessions)
      setLoaded(true)
    })
  }, [])

  const save = async () => {
    await window.api.settingsSet({
      ideCommand: ideCommand.trim() || 'code',
      groupWithSource,
      agentControl,
      agentFreeSessions,
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
            does not reach into a session that is already running.

            The subject of the second sentence is THESE TOOLS, never "a Claude
            session": Claude Code in a tab obviously can read and change files —
            that is its job — so a sentence whose subject is the session and
            whose predicate is "cannot read or change your files" is false, and
            false in the direction that makes leaving this on look safer than it
            is. What this switch grants is the four tools and nothing else. */}
        <p className="settings-hint">
          A Claude session in a tab can read the tab list, close tabs (ending whatever is running
          in them), open a git-diff tab, and start a new Claude session{' '}
          <em>after you approve that one</em>. Those four are the whole list: none of them reads or
          changes a file, and none can type into a terminal. They are what this switch grants — a
          session&rsquo;s own tools are a separate matter. Saving starts or stops the server at
          once; sessions get the change the next time one starts, so ones already running keep what
          they were launched with.
        </p>
        {/* KAN-64. A select, not a number input: the decision is "ask every
            time / a few / the default / a lot", and a free text box invites a
            500 nobody meant. Disabled with the switch above rather than hidden
            — a control that vanishes reads as a bug, and this one genuinely
            does nothing while the whole surface is off. */}
        <label className="settings-field">
          <span>Sessions Claude may open without asking</span>
          <select
            data-setting="agentFreeSessions"
            value={agentFreeSessions}
            disabled={!loaded || !agentControl}
            onChange={(e) => setAgentFreeSessions(Number(e.target.value))}
          >
            {AGENT_FREE_SESSION_CHOICES.map((n) => (
              <option key={n} value={n}>{n === 0 ? '0 — ask every time' : n}</option>
            ))}
          </select>
        </label>
        <p className="settings-hint">
          Beyond this many, Claude Explorer asks you before each new session — it never refuses
          one, so you can keep approving. Tabs a session opened count until you close them, except
          that a tab whose Claude has already exited is closed for you when a new session needs the
          room.
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
