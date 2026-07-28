import type { FileMode } from '../../shared/types'

export function StatusBar({
  count,
  selected,
  mode,
  onToggleMode,
}: {
  count: number
  selected: number
  mode: FileMode
  onToggleMode(): void
}) {
  const dev = mode === 'developer'
  return (
    <div className="statusbar">
      <span>{count} items</span>
      {selected > 0 && <span>{selected} selected</span>}
      <button
        className={`mode-toggle${dev ? ' mode-toggle--dev' : ''}`}
        onClick={onToggleMode}
        title={
          dev
            ? 'Developer mode: hidden files shown, risky operations unlocked. Click to switch to Explorer mode.'
            : 'Explorer mode: hidden files and system paths protected. Click to switch to Developer mode.'
        }
      >
        {dev ? 'Developer' : 'Explorer'}
      </button>
    </div>
  )
}
