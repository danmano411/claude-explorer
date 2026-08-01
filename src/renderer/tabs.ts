import { winBasename, winDirname } from '../shared/pathutil'
import { addToGroup } from '../shared/groups'
import type { ControlTab, PersistedTab, PtyStatus, TabView } from '../shared/types'

export interface Tab {
  id: string
  view: TabView
  cwd: string // folder the tab acts on; for a viewer tab, the file's parent dir
  ptyId?: string
  title: string
  terminalKind?: 'claude' | 'shell' // set when view === 'terminal'
  /**
   * The Claude conversation this tab owns, for `--resume` after a restart.
   * We generate it and hand it to the CLI via `--session-id` rather than
   * reading back whichever jsonl appeared afterwards, so two tabs on the same
   * folder can never be confused for one another. Set when terminalKind ===
   * 'claude'.
   */
  sessionId?: string
  filePath?: string // absolute file being viewed; set when view === 'viewer'
  viewerMode?: 'file' | 'diff' // 'file' -> fsRead, 'diff' -> gitDiff; set when view === 'viewer'
  renamed?: boolean // user set a custom title; suppress auto-title-on-navigate
  /** The tab folder this tab belongs to (TabGroup.id), or absent for a loose
   *  tab. Makes `Tab` satisfy groups.ts's `Grouped` structurally. */
  groupId?: string
  /** Chrome-style pinned: icon-only, held at the left end of the strip, and
   *  never a group member (KAN-53). The other half of `Grouped`. */
  pinned?: boolean
  /** KAN-41. This Claude session was started BY the MCP spawn tool, so it is a
   *  worker: main withholds the MCP config and token from it, and this flag is
   *  what re-tells main so on a restart-and-respawn. Never shown in the UI. */
  agentSpawned?: true
}

export function toPersisted(t: Tab): PersistedTab {
  return {
    id: t.id,
    view: t.view,
    cwd: t.cwd,
    title: t.title,
    renamed: t.renamed,
    groupId: t.groupId,
    pinned: t.pinned,
    terminalKind: t.terminalKind,
    resumeSessionId: t.sessionId,
    filePath: t.filePath,
    viewerMode: t.viewerMode,
    agentSpawned: t.agentSpawned,
  }
}

/**
 * One `listTabs` row (KAN-39). A projection beside `toPersisted`, not a second
 * tab model: `groupId`/`pinned` are dropped on purpose — the control channel
 * does not speak M5's grouping model — and `status` is joined in from
 * `usePtyStatus()`'s map, which is keyed by **ptyId**, not by tab id. A tab
 * with no process (files, viewer) therefore reports no status at all, and
 * neither does a terminal whose pty has not emitted yet.
 *
 * `agentSpawned` IS reported (KAN-64), unlike `groupId`/`pinned`: it is the
 * only way anything outside the renderer can tell a tab the spawn tool opened
 * from one the user opened, which is half the dead-vs-dormant test the reap in
 * mcp.ts makes before it closes anything. `status` is the other half.
 */
export function toControlTab(t: Tab, status: ReadonlyMap<string, PtyStatus>): ControlTab {
  return {
    id: t.id,
    ptyId: t.ptyId,
    view: t.view,
    cwd: t.cwd,
    title: t.title,
    terminalKind: t.terminalKind,
    status: t.ptyId ? status.get(t.ptyId) : undefined,
    agentSpawned: t.agentSpawned,
  }
}

/**
 * null when the tab cannot be brought back at all.
 *
 * A terminal tab comes back **without a ptyId**, which is the load-bearing
 * detail: the old pty died with the last run, and a Tab whose view is
 * 'terminal' but whose ptyId is absent means "this pane still needs a process".
 * App spawns it on first activation rather than all at once at launch — six
 * restored sessions should not mean six Claude processes competing for the CPU
 * before the window is even usable.
 */
export function fromPersisted(p: PersistedTab): Tab | null {
  if (p.view === 'terminal') {
    // A terminal tab with no cwd could only spawn somewhere arbitrary.
    if (!p.cwd) return null
    return {
      id: p.id,
      view: 'terminal',
      cwd: p.cwd,
      title: p.title,
      renamed: p.renamed,
      groupId: p.groupId,
      pinned: p.pinned,
      terminalKind: p.terminalKind ?? 'claude',
      sessionId: p.resumeSessionId,
      agentSpawned: p.agentSpawned,
    }
  }
  if (p.view === 'viewer' && !p.filePath) return null // nothing to show
  return {
    id: p.id,
    view: p.view,
    cwd: p.cwd,
    title: p.title,
    renamed: p.renamed,
    groupId: p.groupId,
    pinned: p.pinned,
    filePath: p.filePath,
    viewerMode: p.viewerMode,
  }
}

/** A restored terminal tab that has not been given a process yet. */
export function needsSpawn(t: Tab): boolean {
  return t.view === 'terminal' && !t.ptyId
}

export function newFilesTab(cwd: string): Tab {
  return { id: crypto.randomUUID(), view: 'files', cwd, title: winBasename(cwd) }
}

export function newTerminalTab(
  cwd: string, kind: 'claude' | 'shell', ptyId: string, title: string, sessionId?: string,
  agentSpawned?: true,
): Tab {
  return {
    id: crypto.randomUUID(), view: 'terminal', cwd, ptyId, terminalKind: kind, title, sessionId,
    agentSpawned,
  }
}

/** Read-only viewer tab. cwd is the containing folder so the tab context menu
 *  (Open in Explorer / Terminal / IDE) keeps working exactly as on a files tab. */
export function newViewerTab(filePath: string, mode: 'file' | 'diff' = 'file'): Tab {
  return {
    id: crypto.randomUUID(),
    view: 'viewer',
    cwd: winDirname(filePath),
    filePath,
    viewerMode: mode,
    title: winBasename(filePath),
  }
}

/**
 * Remove a tab by id. Exported (rather than inlined as `tabs.filter(...)` at
 * the call site) so App can pass it straight to setTabs's functional form:
 * `setTabs((ts) => closeTabList(ts, id))`. React threads functional updates
 * through each other's output, so several closeTab calls issued before a
 * commit compose correctly instead of each computing "remaining" from the
 * same stale snapshot (KAN-37).
 */
export function closeTabList(ts: Tab[], id: string): Tab[] {
  return ts.filter((t) => t.id !== id)
}

/**
 * Dedupe-or-append for opening a file viewer, plus which tab (existing or
 * new) should become active. Exported for the same reason as closeTabList:
 * the "is it already open" check has to run against the list React is about
 * to commit, not a stale closure snapshot, or two rapid opens of the same
 * file both miss each other and both append (KAN-37).
 *
 * `sourceGroupId`, when given, is the opening tab's groupId (KAN-47:
 * "opened from this tab" auto-link). Applied only on the fresh-tab path —
 * re-focusing an already-open viewer must never relocate it just because it
 * happened to be re-opened from a differently-grouped tab. `addToGroup`
 * already does exactly "tag + move to the group's right edge", appending the
 * new tab first (ungrouped, at the far end) makes that the tab it operates
 * on, so no separate insertion logic is needed here.
 *
 * `scopeIds`, when given, restricts the dedupe search to that set of ids
 * (KAN-45-integration review #3). Without it the "already open?" check scans
 * every tab in the store, so re-opening a file that a background SPACE
 * already has open relocates that tab into the caller's space instead of
 * making a second one — fine for exactly-one-owner, but if that tab's
 * groupId names a group that only exists in the other space, it arrives
 * pre-tagged with a groupId the receiving space never showed a chip for, and
 * a COLLAPSED source group hides it outright (no highlighted tab anywhere).
 * A caller that wants dedupe scoped to one space's membership (one open
 * viewer per space, matching that space's own groups) passes that space's
 * tab ids here; omitting it keeps the old whole-store behaviour.
 */
export function openViewerTabList(
  ts: Tab[], filePath: string, mode: 'file' | 'diff', sourceGroupId?: string, scopeIds?: ReadonlySet<string>,
): { tabs: Tab[]; id: string } {
  const open = ts.find(
    (t) => t.view === 'viewer' && t.filePath === filePath && t.viewerMode === mode &&
      (scopeIds === undefined || scopeIds.has(t.id)),
  )
  if (open) return { tabs: ts, id: open.id }
  const t = newViewerTab(filePath, mode)
  const tabs = sourceGroupId !== undefined ? addToGroup([...ts, t], t.id, sourceGroupId) : [...ts, t]
  return { tabs, id: t.id }
}
