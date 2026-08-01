import { useState } from 'react'

/**
 * KAN-79. The ONE screen a user ever sees this feature introduced on — not a
 * bare "Allow notifications?" prompt. Dan's own framing: a naked yes/no
 * "teaches them nothing and they will decline it out of habit", so this card
 * states what the feature does (always-on, not a choice) before it asks
 * anything, then collects the three real choices with their stated defaults.
 *
 * Writes the SAME three `Settings` keys the Notifications section in
 * SettingsModal edits (`notifySound`, `notifyDesktop`, `autoSwitchOnInput`) —
 * this is a first-run VIEW of that section, not a second store for the same
 * three switches. `autoSwitchOnInput`'s actual auto-switch BEHAVIOUR belongs
 * to KAN-80; this card only collects the choice, same as the Settings section
 * does.
 *
 * Reuses the plain .modal shell (no fourth dialog chrome) but is deliberately
 * NOT backdrop-dismissible like SettingsModal/ConfirmDialog: this is the one
 * place the user learns the feature exists at all, so an accidental outside
 * click must not skip it unread. `notifyDesktop` starts CHECKED here
 * specifically — unlike the Settings section, which always mirrors whatever
 * is actually saved (default `false`) — because the ticket marks this row
 * "ask here" rather than "off" like the other two: the card is proposing an
 * answer to a question nobody has answered yet, not reporting one already on
 * disk. See the `notifyDesktop` doc comment in shared/types.ts.
 */
export function NotifSetupCard({
  onDone,
}: {
  onDone(choices: { notifySound: boolean; notifyDesktop: boolean; autoSwitchOnInput: boolean }): void
}) {
  const [notifySound, setNotifySound] = useState(false)
  const [notifyDesktop, setNotifyDesktop] = useState(true)
  const [autoSwitchOnInput, setAutoSwitchOnInput] = useState(false)

  return (
    <div className="modal-backdrop">
      <div className="modal notif-setup" onClick={(e) => e.stopPropagation()}>
        <h2>Session alerts</h2>
        <p>
          Claude Explorer watches every Claude session you have open, across every space. When one
          needs your permission or finishes and is waiting on you, it marks the tab, the space, and
          the spaces menu — so a session blocked in a space you are not looking at cannot sit there
          unnoticed.
        </p>
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={notifySound}
            onChange={(e) => setNotifySound(e.target.checked)}
          />
          <span>Play a sound — a short chime when a session needs you.</span>
        </label>
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={notifyDesktop}
            onChange={(e) => setNotifyDesktop(e.target.checked)}
          />
          <span>Desktop notifications — a Windows notification even when Claude Explorer is not the active window.</span>
        </label>
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={autoSwitchOnInput}
            onChange={(e) => setAutoSwitchOnInput(e.target.checked)}
          />
          <span>Jump to the session that needs input — changes what you are looking at. Off unless you want it.</span>
        </label>
        <p className="settings-hint">You can change all of this later in Settings &rsaquo; Notifications.</p>
        <div className="modal-actions">
          <button
            className="primary"
            autoFocus
            onClick={() => onDone({ notifySound, notifyDesktop, autoSwitchOnInput })}
          >
            Get started
          </button>
        </div>
      </div>
    </div>
  )
}
