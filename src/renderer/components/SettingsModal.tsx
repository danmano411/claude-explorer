import { useEffect, useState } from 'react'
import { AGENT_FREE_SESSION_CHOICES, DEFAULT_AGENT_FREE_SESSIONS } from '../../shared/types'
import {
  DEFAULT_SPACE_KEYBINDS, findSpaceBindingConflict, knownAppShortcut, resolveSpaceKeybinds,
  type KeyBinding, type Mods, type SpaceAction, type SpaceKeybinds,
} from '../keys'

const ACTION_LABEL: Record<SpaceAction, string> = {
  switchUnpinned: 'Switch to space',
  switchPinned: 'Switch to pinned space',
  cycleNext: 'Next space',
  cyclePrev: 'Previous space',
}

const CYCLE_ACTIONS: SpaceAction[] = ['cycleNext', 'cyclePrev']

const formatMods = (m: Mods): string =>
  [m.ctrl && 'Ctrl', m.shift && 'Shift', m.alt && 'Alt', m.meta && 'Meta'].filter(Boolean).join('+')

/** `e.key` for a letter is already lower-case unless Shift was held; upper-
 *  casing single characters here (not multi-char names like "Tab") keeps the
 *  displayed label readable either way without storing a second copy of it. */
const formatKey = (key: string): string => (key.length === 1 ? key.toUpperCase() : key)

const formatBinding = (action: SpaceAction, binds: SpaceKeybinds): string =>
  CYCLE_ACTIONS.includes(action)
    ? `${formatMods((binds[action] as KeyBinding).mods)}+${formatKey((binds[action] as KeyBinding).key)}`
    : `${formatMods(binds[action] as Mods)}+1..9`

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [ideCommand, setIdeCommand] = useState('')
  const [groupWithSource, setGroupWithSource] = useState(true)
  const [agentControl, setAgentControl] = useState(true)
  const [agentFreeSessions, setAgentFreeSessions] = useState<number>(DEFAULT_AGENT_FREE_SESSIONS)
  const [keybinds, setKeybinds] = useState<SpaceKeybinds>(DEFAULT_SPACE_KEYBINDS)
  // KAN-83. Which of the four space actions is mid-capture, or `null` — the
  // "capture a keystroke" input the ticket asks for instead of a free-text
  // field that invites five spellings of "Ctrl+Shift+1". `keybindMsg` is the
  // one inline banner both the REFUSE path (duplicate — acceptance #5) and
  // the WARN-but-allow path (known app shortcut) share; only the refuse path
  // also stops recording without saving.
  const [recording, setRecording] = useState<SpaceAction | null>(null)
  const [keybindMsg, setKeybindMsg] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    window.api.settingsGet().then((s) => {
      setIdeCommand(s.ideCommand)
      setGroupWithSource(s.groupWithSource)
      setAgentControl(s.agentControl)
      setAgentFreeSessions(s.agentFreeSessions)
      setKeybinds(resolveSpaceKeybinds(s.spaceKeybinds))
      setLoaded(true)
    })
  }, [])

  // The capture listener itself. CAPTURE phase and window-level (not a local
  // onKeyDown) for the same reason App.tsx's grid-picker shortcut is: this
  // modal is not the only thing on `window` with a keydown listener, and
  // capturing first is what stops, say, a half-typed Ctrl+W rebind from also
  // closing the tab underneath the modal. Only live while `recording` is set,
  // so it costs nothing the rest of the time and is gone entirely once the
  // modal closes.
  useEffect(() => {
    if (!recording) return
    const h = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') { setRecording(null); return }
      // Modifier keys pressed alone (still building the chord) are not a
      // completed capture — wait for the real key.
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return
      const hasModifier = e.ctrlKey || e.shiftKey || e.altKey || e.metaKey
      if (!hasModifier) {
        // No `isTypingTarget`/`isTextBox` guard on the space-action window
        // listeners this feeds (KAN-59 deliberately takes Ctrl+1..9 even over
        // a terminal) — an unmodified key would therefore fire on ordinary
        // typing everywhere, not just pick an unusual chord. Refused here,
        // not just normalized quietly, so the user sees why nothing happened.
        setKeybindMsg('Hold at least one modifier key (Ctrl, Shift, or Alt) as well.')
        return
      }
      // Sparse — only the modifiers actually held — matching every other
      // `Mods` value in this codebase (`DEFAULT_SPACE_KEYBINDS`'s `{ ctrl:
      // true }`, never `{ ctrl: true, shift: false, alt: false, meta: false
      // }`). `modsMatch`/`modsEqual` treat absent the same as `false` either
      // way, so this is a storage-shape nicety, not a correctness fix.
      const mods: Mods = {}
      if (e.ctrlKey) mods.ctrl = true
      if (e.shiftKey) mods.shift = true
      if (e.altKey) mods.alt = true
      if (e.metaKey) mods.meta = true
      const isCycle = CYCLE_ACTIONS.includes(recording)
      if (!isCycle && !/^Digit[1-9]$/.test(e.code)) {
        setKeybindMsg('Press a number key (1-9) together with your modifier — the digit itself always picks the space.')
        return
      }
      const candidate: Mods | KeyBinding = isCycle ? { mods, key: e.key } : mods
      const conflict = findSpaceBindingConflict(recording, candidate, keybinds)
      if (conflict) {
        // REFUSE (acceptance #5): unlike the known-shortcut warning below,
        // this one does not save — two space actions firing on the same
        // press is not "the user may genuinely want it", it is ambiguous.
        setKeybindMsg(`That combination is already "${ACTION_LABEL[conflict]}". Choose another.`)
        setRecording(null)
        return
      }
      const known = isCycle ? knownAppShortcut(candidate as KeyBinding) : null
      setKeybinds((k) => ({ ...k, [recording]: candidate }))
      // WARN but allow: saved regardless, because the user may genuinely
      // want the collision (ticket's words) — a switch action's digit can
      // never reach here, since it can never coincide with a letter shortcut.
      setKeybindMsg(known ? `Heads up: that combination is also ${known}.` : null)
      setRecording(null)
    }
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [recording, keybinds])

  const resetBinding = (action: SpaceAction) => {
    setKeybinds((k) => ({ ...k, [action]: DEFAULT_SPACE_KEYBINDS[action] }))
    setKeybindMsg(null)
    setRecording(null)
  }

  const save = async () => {
    await window.api.settingsSet({
      ideCommand: ideCommand.trim() || 'code',
      groupWithSource,
      agentControl,
      agentFreeSessions,
      spaceKeybinds: keybinds,
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
        {/* KAN-83. The first sectioned area in this file — previously a flat
            field list — so KAN-77's Notifications section has a pattern to
            follow: an <h3 class="settings-section"> heading, then ordinary
            .settings-field rows underneath. Nothing fancier than that. */}
        <h3 className="settings-section">Keybinds</h3>
        {(Object.keys(ACTION_LABEL) as SpaceAction[]).map((action) => (
          <div className="settings-field" key={action} data-keybind={action}>
            <span>{ACTION_LABEL[action]}</span>
            <div className="keybind-row">
              <code className="keybind-value">{formatBinding(action, keybinds)}</code>
              <button
                type="button"
                className={recording === action ? 'recording' : undefined}
                disabled={!loaded}
                onClick={() => { setKeybindMsg(null); setRecording(action) }}
              >
                {recording === action ? 'Press keys…' : 'Change'}
              </button>
              <button type="button" disabled={!loaded} onClick={() => resetBinding(action)}>Reset</button>
            </div>
          </div>
        ))}
        <p className="settings-hint">
          Click Change, then press the new combination. Switching spaces always keeps its number
          key (1-9); only the modifiers rebind. Esc cancels without changing anything.
        </p>
        {keybindMsg && <p className="settings-hint keybind-warning">{keybindMsg}</p>}
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
