import { useEffect, useRef, useState } from 'react';
import {
  newFilesTab, newTerminalTab, toPersisted, fromPersisted, needsSpawn,
  closeTabList, openViewerTabList, type Tab,
} from './tabs';
import {
  addToGroup, deleteGroup, newGroup, recolorGroup, removeFromGroup,
  renameGroup, reorderWithGroups, setCollapsed,
} from '../shared/groups';
import {
  addTabToSpace, createSpace, deleteSpace, removeTabFromSpace, renameSpace,
  reorderInSpace, setActiveTab, switchSpace,
} from './spaces';
import type { Space, TabGroup } from '../shared/types';
import { isTypingTarget } from './keys';
import { usePtyStatus } from './ptystatus';
import { FileBrowser } from './components/FileBrowser';
import { Terminal } from './components/Terminal';
import { Viewer } from './components/Viewer';
import { DiffView } from './components/DiffView';
import { RecentMenu } from './components/RecentMenu';
import { SettingsModal } from './components/SettingsModal';
import { SpaceMenu } from './components/SpaceMenu';
import { TabBar, type GroupActions } from './TabBar';

const basename = (p: string) => p.split(/[\\/]/).pop() || p;

/** A space's ordered tab records: `tabIds` (the order) resolved against the tab
 *  store (the records). An id with no record is dropped rather than rendered as
 *  a blank — sanitize() will prune it from `tabIds` on the next write. */
const sliceOf = (tabIds: readonly string[], records: readonly Tab[]): Tab[] => {
  const m = new Map(records.map((t) => [t.id, t] as const));
  return tabIds.map((id) => m.get(id)).filter((t): t is Tab => t !== undefined);
};

export function App() {
  // `tabs` is an UNORDERED STORE KEYED BY ID. It says what a tab *is* (cwd,
  // view, groupId) and nothing about where it appears; `spaces[i].tabIds` is
  // authoritative for both order and membership. That is a decided rule, not an
  // accident of this file — the full reasoning is the module doc in
  // src/renderer/spaces.ts. Do not re-derive strip order from `tabs`, and do not
  // reorder `tabs` expecting the strip to follow it.
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [groups, setGroups] = useState<TabGroup[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [activeSpaceId, setActiveSpaceId] = useState<string>('');
  const [active, setActive] = useState<string>('');
  const [showSettings, setShowSettings] = useState(false);
  const status = usePtyStatus();
  const lastActivated = useRef<Map<string, number>>(new Map());
  const spawning = useRef<Set<string>>(new Set());
  // An argv/Explorer open is APPENDED to whatever restore produces, never
  // merged into it and never allowed to lose to it: the restore effect below
  // ends in a *replacing* setTabs(restored), so a tab added before it resolves
  // would be silently destroyed. Held here until restore has committed.
  const restoreDone = useRef(false);
  const pendingCli = useRef<[string, string] | null>(null); // [cmd, path]

  /**
   * `activeSpaceId` as of RIGHT NOW, for callbacks that write `spaces`.
   *
   * They can run before the `setActiveSpaceId` they were queued alongside has
   * committed, and the sharp case is the restore effect: it resolves the space
   * and then, in the SAME tick, flushes a queued CLI/Explorer open — from a
   * closure belonging to the very first render, where `activeSpaceId` is still
   * ''. A closure read there hands `addTabToSpace` an id naming no space, it
   * no-ops, and the tab ends up owned by NO space: unreachable, because no strip
   * can show it and nothing can close it. Written by `goToSpace` only, never
   * during render, or it would just track the stale value again.
   */
  const activeSpaceIdRef = useRef('');
  const goToSpace = (id: string) => { activeSpaceIdRef.current = id; setActiveSpaceId(id); };

  // The tab strip renders ONE space, so this slice — not `tabs` — is what the
  // strip, `segments()` and every drag index are about. A group is one
  // contiguous run *inside a space*, which is why the group-aware helpers below
  // compose over `spaceTabs` and write the resulting id order back to `tabIds`.
  const activeSpace = spaces.find((s) => s.id === activeSpaceId);
  const spaceTabs = sliceOf(activeSpace?.tabIds ?? [], tabs);

  // `active` is the tab with focus right now; `space.activeTabId` is the memory
  // of it, so coming back to a space lands where you left it (KAN-43 persists
  // that field). setActiveTab refuses a tab the space does not own, so the
  // membership update always has to be queued before this.
  const selectTab = (id: string) => {
    lastActivated.current.set(id, Date.now());
    setActive(id);
    setSpaces((ss) => setActiveTab(ss, activeSpaceIdRef.current, id));
  };

  /** Every open path lands the new tab in the space you are looking at. */
  const addToActiveSpace = (id: string) =>
    setSpaces((ss) => addTabToSpace(ss, activeSpaceIdRef.current, id));

  /**
   * Run a groups.ts membership op on the ACTIVE SPACE's slice, writing the
   * changed tab records back to the global store and the resulting id order back
   * to that space's `tabIds`.
   *
   * Group ops REORDER — `addToGroup` pulls a tab to its group's right edge,
   * `removeFromGroup` pushes it just past the run — and the strip is the slice.
   * Running them on the global array alone would tag the tab correctly and leave
   * the strip drawing a shredded group, because `tabIds` (which is the order)
   * never moved. The order written is a permutation of the slice, so membership
   * and the exactly-one-owner rule are untouched by construction.
   *
   * Menu-driven, one user click per call, so reading `spaceTabs` from this
   * render's closure is safe (KAN-37's composition hazard is about several
   * updates issued before a single commit, which a context menu cannot do).
   */
  const applyToSlice = (fn: (slice: Tab[]) => Tab[]) => {
    const after = fn(spaceTabs);
    if (after === spaceTabs) return;
    const patched = new Map(after.map((t) => [t.id, t] as const));
    setTabs((ts) => ts.map((t) => patched.get(t.id) ?? t));
    setSpaces((ss) =>
      ss.map((s) => (s.id === activeSpaceIdRef.current ? { ...s, tabIds: after.map((t) => t.id) } : s)));
  };

  /**
   * The open-a-tab twin of `applyToSlice`: membership via `addTabToSpace` (which
   * also evicts the id from any other space, so exactly-one-owner survives a
   * dedupe hit on a tab another space had), then position.
   *
   * Separate from `applyToSlice` because the auto-link paths resolve `groupId`
   * INSIDE setTabs's updater, against the list React is about to commit rather
   * than this render's closure (KAN-47: the await before them is a pty spawn,
   * long enough for an ungroup to land) — so this takes those fresh `records`
   * instead of reading `spaceTabs`. `tabIds` carries no groupId, which is why
   * the placement has to be derived from records at all.
   */
  const placeInSpace = (id: string, groupId: string | undefined, records: Tab[]) => {
    addToActiveSpace(id);
    if (groupId === undefined) return;
    setSpaces((ss) =>
      ss.map((s) =>
        s.id === activeSpaceIdRef.current
          ? { ...s, tabIds: addToGroup(sliceOf(s.tabIds, records), id, groupId).map((t) => t.id) }
          : s));
  };

  /** Which tab a space should focus when you arrive at it. */
  const focusOf = (s: Space | undefined): string =>
    (s?.activeTabId && s.tabIds.includes(s.activeTabId) ? s.activeTabId : s?.tabIds[0]) ?? '';

  useEffect(() => {
    (async () => {
      const w = await window.api.workspaceGet();
      const restored = w.tabs.map(fromPersisted).filter((t): t is Tab => t !== null);
      // sanitize() already ran normalize() over w.tabs AND over each space's
      // member slice, so every surviving groupId names a real group and every
      // group is one contiguous run inside its space — exactly what segments()
      // renders against. It also guarantees at least one space and that
      // activeSpaceId names one of them. Nothing to repair here; a second
      // normalizer in the renderer is exactly what KAN-45 refused to ship.
      setGroups(w.groups);
      const space = w.spaces.find((s) => s.id === w.activeSpaceId) ?? w.spaces[0];
      goToSpace(space.id);
      if (restored.length) {
        // Land on the tab you left, not tab 1 — and only on one THIS space owns
        // and that was actually renderable (fromPersisted can still drop it).
        const live = new Set(restored.map((t) => t.id));
        const mine = space.tabIds.filter((id) => live.has(id));
        const focus = (space.activeTabId && live.has(space.activeTabId) ? space.activeTabId : mine[0]) ?? '';
        setSpaces(w.spaces);
        setTabs(restored);
        // NOT selectTab: `activeSpaceId` has not committed yet inside this async
        // closure, so setActiveTab would be handed '' and no-op. The space's
        // remembered activeTabId is already on disk and needs no rewrite.
        if (focus) lastActivated.current.set(focus, Date.now());
        setActive(focus);
      } else {
        const home = await window.api.fsHome();
        const t = newFilesTab(home);
        setTabs([t]);
        setSpaces(addTabToSpace(w.spaces, space.id, t.id)); // also sets its activeTabId
        lastActivated.current.set(t.id, Date.now());
        setActive(t.id);
      }
      // Both branches end in a replacing setTabs, so the gate is flushed here —
      // after restore has committed — on either path.
      restoreDone.current = true;
      const p = pendingCli.current;
      pendingCli.current = null;
      if (p) applyCli(p[0], p[1]);
    })();
  }, []);

  // Give a restored terminal tab its process. Whether the conversation can be
  // resumed depends on something only the disk knows: `--resume` needs a
  // transcript, and a tab closed before its first message has an id but no
  // file, which claude rejects. Passing the same id as `--session-id` instead
  // means the tab keeps its identity either way, so the *next* restart resumes
  // it properly.
  const spawnFor = async (t: Tab): Promise<string> => {
    if (t.terminalKind === 'shell') return window.api.ptySpawn({ path: t.cwd, shell: true });
    const known = t.sessionId
      ? (await window.api.sessionsList(t.cwd)).some((s) => s.id === t.sessionId)
      : false;
    return window.api.ptySpawn({
      path: t.cwd,
      resumeId: known ? t.sessionId : undefined,
      sessionId: known ? undefined : t.sessionId,
    });
  };

  // Restored terminal tabs are spawned on first activation, not all at once at
  // launch — coming back to six Claude sessions should not mean six CLIs racing
  // for the CPU before the window is usable. A failed spawn paints its own error
  // inside the pane (see PtyManager), so a folder that has since been deleted
  // explains itself rather than silently doing nothing.
  useEffect(() => {
    const t = tabs.find((x) => x.id === active);
    if (!t || !needsSpawn(t) || spawning.current.has(t.id)) return;
    spawning.current.add(t.id);
    spawnFor(t)
      .then((ptyId) => update(t.id, { ptyId }))
      .finally(() => spawning.current.delete(t.id));
  }, [active, tabs]);

  // The workspace document IS this component's state, so it is written whole
  // rather than read-modify-written. The old spread-what-is-on-disk shape had
  // to be dropped anyway: it re-persisted whichever copy of `spaces`/`groups`
  // it had just read back, which silently lost edits (that is why `groups` was
  // already being overwritten explicitly), and it keyed everything off
  // `spaces[0]` because there was only ever one space.
  //
  // No `if (!tabs.length) return` guard either. `spaces` is half the document
  // and a brand-new space is legally EMPTY — bailing on "no tabs" is exactly
  // how a space you just created disappears on restart (spaces.ts, "Caller
  // obligation 2"). `restoreDone` is the real guard: writing before restore has
  // committed would flush the initial empty state over the file.
  const persist = () =>
    window.api.workspaceSet({
      version: 1, groups, tabs: tabs.map(toPersisted), spaces, activeSpaceId,
    });

  // Persist which tab is focused IMMEDIATELY, not debounced. A tab click is
  // user-paced, not keystroke-fast, so there is no churn to batch away — and
  // there is no other flush that would catch it: will-quit only flushes the
  // trash, there is no beforeunload write, so a click-then-quit inside a
  // debounce window used to lose the selection outright (KAN-43 review D-1).
  //
  // `tabs`/`spaces` are this render's closure values, not dependencies, so this
  // still only *fires* on an `active` change — React batches the setTabs +
  // selectTab pair that creates a new tab into one render, so the closure
  // already has both. It has to write them: sanitize() rejects an activeTabId
  // that isn't in that write's own membership, so writing the focus alone
  // against a tab the (separately debounced) effect below hasn't flushed yet
  // gets silently dropped back to undefined.
  useEffect(() => {
    if (!restoreDone.current) return;
    persist();
  }, [active]);

  // Persist the rest so a restart puts you back where you were. Debounced:
  // navigating a folder retitles its tab, and writing the whole document on
  // every keystroke-fast state change is pointless churn. `active` is NOT a
  // dependency here — it has its own immediate effect above.
  useEffect(() => {
    if (!restoreDone.current) return;
    const timer = setTimeout(persist, 400);
    return () => clearTimeout(timer);
  }, [tabs, groups, spaces, activeSpaceId]);

  // Application menu (File/Settings) posts commands; dispatch through a ref so
  // the subscription (mounted once) always calls the latest closures.
  // The CLI / Explorer context menu rides the same fire-and-forget channel the
  // app menu uses (main/index.ts sendPendingCli), with the path in arg 2.
  // There is deliberately NO arm that spawns Claude: an unauthenticated OS
  // caller can only ever reach openFolderTab / openViewerTab from here. See
  // main/cli.ts for the full reasoning — do not add a 'new-session' arm.
  //
  // ponytail: always appends + focuses, never dedupes against an identical
  // restored tab. Two tabs on the same folder is the price; match on cwd and
  // focus the existing one when someone complains.
  // KAN-47: BOTH arms are sourceless on purpose. An OS shell-open is not
  // "opened from" any tab, so neither one inherits a group — `openViewerTab`
  // without a `sourceId` is exactly today's far-right append.
  const applyCli = (cmd: string, path: string) => {
    if (cmd === 'open-path') openFolderTab(path);
    else if (cmd === 'open-file') openViewerTab(path);
  };

  const menuHandler = useRef<(cmd: string, arg?: string) => void>(() => {});
  menuHandler.current = (cmd, arg) => {
    if (cmd === 'new-tab') addTab();
    else if (cmd === 'close-tab') { if (active) closeTab(active); }
    else if (cmd === 'open-settings') setShowSettings(true);
    else if (arg && (cmd === 'open-path' || cmd === 'open-file')) {
      // Before restore commits, queue: setTabs(restored) would wipe this tab.
      if (!restoreDone.current) { pendingCli.current = [cmd, arg]; return; }
      applyCli(cmd, arg);
    }
  };
  useEffect(() => window.api.onMenuCommand((cmd, arg) => menuHandler.current(cmd, arg)), []);

  const update = (id: string, patch: Partial<Tab>) =>
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  // A tab that joins a COLLAPSED group is rendered by nothing at all — TabBar
  // draws no members of a collapsed group — so it reads as the tab vanishing
  // rather than as "it joined a group" (KAN-44 review #2). Every path that
  // puts a tab into a group it wasn't in has to expand it; no-op (same
  // reference) when the group is already open or gone.
  const expand = (groupId: string) =>
    setGroups((gs) => (gs.find((g) => g.id === groupId)?.collapsed ? setCollapsed(gs, groupId, false) : gs));

  // KAN-47: `+` / Ctrl+T has no source tab — it's the global "new tab" action,
  // same as Chrome's own new-tab button never joining a group. Stays far-right.
  const addTab = async () => {
    const home = await window.api.fsHome();
    const t = newFilesTab(home);
    setTabs((ts) => [...ts, t]); addToActiveSpace(t.id); selectTab(t.id);
  };

  // KAN-47: called from the CLI/Explorer-context-menu 'open-path' arm and from
  // the (tab-bar-global, not per-tab) Recent Menu — neither has a source tab
  // to inherit from. Stays far-right, same as today.
  const openFolderTab = (p: string) => {
    const t = newFilesTab(p);
    setTabs((ts) => [...ts, t]); addToActiveSpace(t.id); selectTab(t.id);
  };

  // Opening a file gets its own first-class tab (never a split pane — a split
  // could not live inside a future tab group). Re-opening the same file focuses
  // the tab that already has it instead of piling up duplicates.
  //
  // KAN-47: `sourceId` is the tab this viewer was opened FROM, passed in
  // explicitly by the caller rather than inferred from `active` — an OS
  // shell-open (applyCli's 'open-file' arm) is not "opened from" any tab and
  // must stay far-right, which sourceless means literally here. Its groupId is
  // resolved INSIDE the updater, not from this render's closure: settingsGet
  // is an await, and an ungroup during it would otherwise tag the new tab with
  // a group its source has already left.
  //
  // ponytail: the dedupe scans EVERY tab, not just this space's, so re-opening a
  // file that a background space already has open moves that tab here rather
  // than making a second one — addTabToSpace evicts it from the other space, so
  // the exactly-one-owner rule holds either way. Viewer tabs own no process, so
  // nothing dies; scope the `find` in openViewerTabList to the active space's
  // membership if someone would rather have one viewer per space.
  const openViewerTab = async (filePath: string, mode: 'file' | 'diff' = 'file', sourceId?: string) => {
    const link = sourceId !== undefined && (await window.api.settingsGet()).groupWithSource;
    setTabs((ts) => {
      const groupId = link ? ts.find((t) => t.id === sourceId)?.groupId : undefined;
      if (groupId !== undefined) expand(groupId);
      const { tabs: next, id } = openViewerTabList(ts, filePath, mode, groupId);
      placeInSpace(id, groupId, next);
      selectTab(id);
      return next;
    });
  };

  const closeTab = (id: string) => {
    const t = tabs.find((x) => x.id === id);
    if (t?.ptyId) window.api.ptyKill(t.ptyId);
    lastActivated.current.delete(id);
    setSpaces((ss) => removeTabFromSpace(ss, activeSpaceIdRef.current, id));
    setTabs((ts) => {
      const remaining = closeTabList(ts, id);
      if (id === active) {
        // Re-pick from THIS SPACE's survivors: a tab another space owns is not
        // on this strip, and focusing it would leave the window showing a pane
        // with no tab. `mine` is this render's membership — a superset as a
        // closeTabs loop shrinks it — intersected with `remaining`, which DOES
        // shrink across composed updaters, so KAN-44's "close the focused
        // member last" fix still lands on a real survivor.
        const mine = new Set(activeSpace?.tabIds ?? []);
        const survivors = remaining.filter((x) => mine.has(x.id));
        // Most-recently-activated survivor; '' only when the space is now empty.
        setActive(survivors.length
          ? survivors.reduce((a, b) =>
            (lastActivated.current.get(b.id) ?? 0) > (lastActivated.current.get(a.id) ?? 0) ? b : a).id
          : '');
      }
      return remaining;
    });
  };

  // Group-aware: the same positional move, plus "did it land inside a group's
  // span?" — the join/leave rule lives in groups.ts, not here.
  //
  // SPACE-relative: the strip renders one space, so `from`/`insert` index that
  // space's slice. reorderWithGroups decides the moved tab's groupId from where
  // it landed *within the space*, and the id order goes back through
  // reorderInSpace — which clamps `insert` exactly the same way, so the two
  // agree on the resulting order by construction.
  //
  // If that landing spot's group happens to be collapsed, `expand` it: a tab
  // dropped beside a collapsed group joins it per groups.ts's inclusive edge
  // rule and would then simply not be rendered (KAN-44 review #2).
  const reorderTabs = (from: number, insert: number) => {
    const moved = spaceTabs[from];
    if (!moved) return;
    const next = reorderWithGroups(spaceTabs, from, insert);
    const newGroupId = next.find((t) => t.id === moved.id)?.groupId;
    setSpaces((ss) => reorderInSpace(ss, activeSpaceIdRef.current, from, insert));
    if (newGroupId === moved.groupId) return;
    // Only the tag changes in the store; the position lives in `tabIds`.
    setTabs((ts) => ts.map((t) => (t.id === moved.id ? next.find((x) => x.id === moved.id)! : t)));
    if (newGroupId !== undefined) expand(newGroupId);
  };

  // A group with no members left is invisible (segments() only emits runs of
  // real tabs) but would still clutter the "Add to …" menu forever. Prune it
  // where every close path converges, rather than in each of them.
  useEffect(() => {
    setGroups((gs) => {
      const live = new Set(tabs.map((t) => t.groupId));
      return gs.every((g) => live.has(g.id)) ? gs : gs.filter((g) => live.has(g.id));
    });
  }, [tabs]);

  // Menu-driven, so one user click per call: reading `tabs`/`groups` from this
  // render's closure is safe here (KAN-37's composition hazard is about several
  // updates issued before a single commit, which a context menu cannot do).
  //
  // The three membership ops go through `applyToSlice` because they MOVE the tab
  // in the strip, and the strip is the active space's slice — see its doc.
  const groupActions: GroupActions = {
    create: (tabId) => {
      const g = newGroup('Group', groups);
      setGroups([...groups, g]);
      applyToSlice((sl) => addToGroup(sl, tabId, g.id));
    },
    add: (tabId, groupId) => applyToSlice((sl) => addToGroup(sl, tabId, groupId)),
    remove: (tabId) => applyToSlice((sl) => removeFromGroup(sl, tabId)),
    rename: (groupId, name) => setGroups((gs) => renameGroup(gs, groupId, name.trim() || 'Group')),
    recolor: (groupId, color) => setGroups((gs) => recolorGroup(gs, groupId, color)),
    toggleCollapsed: (groupId) =>
      setGroups((gs) => setCollapsed(gs, groupId, !gs.find((g) => g.id === groupId)?.collapsed)),
    ungroup: (groupId) => {
      // deleteGroup returns BOTH halves precisely because un-grouping must not
      // close anything — the tabs come back untagged, not removed.
      const next = deleteGroup(groups, tabs, groupId);
      setGroups(next.groups);
      setTabs(next.tabs);
    },
    closeTabs: (groupId) => {
      // closeTab already kills the pty and re-picks focus; it uses setTabs's
      // functional form, so several calls in this loop compose (KAN-37). The
      // empty-group prune above then drops the group itself.
      //
      // closeTab's re-pick, though, reads `active` from ITS OWN render
      // closure — so only the FIRST call in this loop can win that race, and
      // it picks from `remaining`, which still contains every other doomed
      // member. Closing the focused member last means the call that actually
      // sees `id === active` is the one running against the already-shrunk
      // list, so it picks a real survivor instead of stranding `active` on a
      // tab that no longer exists (KAN-44 review #1).
      // Scoped to the strip's slice: `closeTab` revokes membership from the
      // ACTIVE space, so it may only ever be handed tabs this space owns.
      const doomed = spaceTabs.filter((t) => t.groupId === groupId);
      [...doomed.filter((t) => t.id !== active), ...doomed.filter((t) => t.id === active)]
        .forEach((t) => closeTab(t.id));
    },
  };

  // A new conversation gets its id assigned here rather than discovered later:
  // reading back "whichever jsonl appeared in this folder" cannot tell two tabs
  // on the same repo apart, and getting that wrong would resume the wrong
  // conversation. Resuming an existing one keeps its id, since that is the
  // transcript it goes on writing to.
  const claudeSpawn = async (cwd: string, resumeId?: string) => {
    await window.api.recentsAdd(cwd);
    const sessionId = resumeId ?? crypto.randomUUID();
    const ptyId = await window.api.ptySpawn({
      path: cwd, resumeId, sessionId: resumeId ? undefined : sessionId,
    });
    return { ptyId, sessionId };
  };

  // Orange-arrow / in-place: converts the current files tab into a Claude terminal.
  const openClaude = async (id: string, cwd: string, resumeId?: string) => {
    const { ptyId, sessionId } = await claudeSpawn(cwd, resumeId);
    update(id, {
      view: 'terminal', cwd, ptyId, terminalKind: 'claude', sessionId, title: basename(cwd),
    });
  };

  // Feature 1: Open Recent launches Claude in a NEW tab (never overrides current).
  // KAN-47: Recent Menu is tab-bar-global, not scoped to any tab — no source
  // to inherit from. Stays far-right, same as today.
  const openClaudeNewTab = async (cwd: string, resumeId?: string) => {
    const { ptyId, sessionId } = await claudeSpawn(cwd, resumeId);
    const t = newTerminalTab(cwd, 'claude', ptyId, basename(cwd), sessionId);
    setTabs((ts) => [...ts, t]); addToActiveSpace(t.id); selectTab(t.id);
  };

  // Feature 5: open a plain shell terminal tab at a folder.
  //
  // KAN-47: `sourceId` is the tab whose context menu spawned this — the
  // right-clicked tab, which is not necessarily `active`. Its groupId is
  // resolved inside the updater, same reasoning as openViewerTab above; here
  // the await is a Windows pty spawn, which is far longer than an IPC.
  const openShellTab = async (cwd: string, sourceId?: string) => {
    const link = sourceId !== undefined && (await window.api.settingsGet()).groupWithSource;
    const ptyId = await window.api.ptySpawn({ path: cwd, shell: true });
    const t = newTerminalTab(cwd, 'shell', ptyId, 'Terminal');
    setTabs((ts) => {
      const groupId = link ? ts.find((x) => x.id === sourceId)?.groupId : undefined;
      if (groupId !== undefined) expand(groupId);
      const next = groupId === undefined ? [...ts, t] : addToGroup([...ts, t], t.id, groupId);
      // Inside the updater, not after it: `selectTab` must be queued AFTER the
      // membership write or setActiveTab refuses a tab the space does not own
      // yet, and the space would remember the wrong focus.
      placeInSpace(t.id, groupId, next);
      selectTab(t.id);
      return next;
    });
  };

  // Feature 4: tab context-menu actions (resolve the tab's cwd, then act).
  const cwdOf = (id: string) => tabs.find((t) => t.id === id)?.cwd;
  const onOpenExplorer = (id: string) => { const p = cwdOf(id); if (p) window.api.openPath(p); };
  const onOpenTerminal = (id: string) => { const p = cwdOf(id); if (p) openShellTab(p, id); };
  const onOpenIde = (id: string) => { const p = cwdOf(id); if (p) window.api.ideOpen(p); };
  const onRename = (id: string, title: string) =>
    update(id, { title: title.trim() || (cwdOf(id) ? basename(cwdOf(id)!) : 'Tab'), renamed: true });

  // --- spaces --------------------------------------------------------------
  //
  // Switching a space changes which tabs RENDER and nothing else. Every tab of
  // every space keeps its Tab record, its ptyId and — because the terminal panes
  // below are mounted for the whole `tabs` store and merely `hidden` — its live
  // xterm instance and scrollback. A Claude session in the space you just left
  // stays mid-response and is still mid-response when you come back. Nothing
  // here calls ptyKill; `onDeleteSpace` is the single operation that intends
  // process death, which is exactly why spaces.ts hands it `closedTabIds`.
  //
  // ponytail: that means N spaces of live sessions is N sets of live processes
  // AND N sets of xterm buffers resident at once — memory grows with total tabs,
  // not with what is on screen. Deliberate: unmounting a hidden pane is the
  // KAN-23 bug (a rebuilt xterm never sees the alt-screen/application-cursor
  // sequences it missed, so the TUI silently stops scrolling and the scrollback
  // is gone), so cheapness here costs correctness. If someone with a dozen heavy
  // spaces ever feels it, suspend a BACKGROUND space's ptys on switch — persist
  // its scrollback, kill the process, respawn + replay on return — rather than
  // unmounting panes.

  const switchToSpace = (id: string) => {
    const r = switchSpace(spaces, activeSpaceId, id);
    if (r.activeSpaceId === activeSpaceId) return;
    goToSpace(r.activeSpaceId);
    const focus = r.activeTabId ?? r.tabIds[0] ?? '';
    if (focus) lastActivated.current.set(focus, Date.now());
    setActive(focus);
  };

  const onCreateSpace = (name: string) => {
    const { spaces: next, id } = createSpace(spaces, name);
    setSpaces(next);
    goToSpace(id);
    setActive(''); // a new space is empty; `+` is how you fill it
  };

  const onDeleteSpace = (id: string) => {
    const r = deleteSpace(spaces, activeSpaceId, id);
    if (!r.ok) return; // LAST_SPACE / NO_SUCH_SPACE — SpaceMenu already hides it
    // The one place PTYs are supposed to die: these tabs are being closed, not
    // merely hidden. `closedTabIds` is the only list that may be killed.
    const doomed = new Set(r.closedTabIds);
    for (const t of tabs) if (doomed.has(t.id) && t.ptyId) window.api.ptyKill(t.ptyId);
    for (const tid of r.closedTabIds) lastActivated.current.delete(tid);
    setTabs((ts) => ts.filter((t) => !doomed.has(t.id)));
    setSpaces(r.spaces);
    goToSpace(r.activeSpaceId);
    setActive(focusOf(r.spaces.find((s) => s.id === r.activeSpaceId)));
  };

  // Ctrl+1..9 selects the nth space. Guarded by the SAME predicate FileBrowser's
  // shortcuts use (renderer/keys.ts) rather than a second mechanism: a terminal
  // must receive Ctrl+1 itself, and xterm's focus sink is a <textarea>, exactly
  // like the address bar / search box / rename inputs are <input>s.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      if (isTypingTarget(e.target)) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > 9) return;
      const target = spaces[n - 1];
      if (!target) return; // fewer than n spaces: leave the key alone
      e.preventDefault();
      switchToSpace(target.id);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [spaces, activeSpaceId]);

  const activeTab = spaceTabs.find((t) => t.id === active);

  return (
    <div className="app">
      <TabBar
        tabs={spaceTabs}
        groups={groups}
        groupActions={groupActions}
        activeId={active}
        status={status}
        onSelect={selectTab}
        onClose={closeTab}
        onAdd={addTab}
        onReorder={reorderTabs}
        onRename={onRename}
        onOpenExplorer={onOpenExplorer}
        onOpenTerminal={onOpenTerminal}
        onOpenIde={onOpenIde}
        spaceMenu={
          <SpaceMenu
            spaces={spaces}
            activeSpaceId={activeSpaceId}
            onSwitch={switchToSpace}
            onCreate={onCreateSpace}
            onRename={(id, name) => setSpaces((ss) => renameSpace(ss, id, name))}
            onDelete={onDeleteSpace}
          />
        }
        recentMenu={
          <RecentMenu
            onOpen={(p, resumeId) => openClaudeNewTab(p, resumeId)}
            onOpenFolder={openFolderTab}
          />
        }
      />
      <div className="content">
        {activeTab?.view === 'files' && (
          <FileBrowser
            cwd={activeTab.cwd}
            tabId={activeTab.id}
            onNavigate={(p) =>
              update(activeTab.id, {
                cwd: p,
                ...(activeTab.renamed ? {} : { title: basename(p) }),
              })
            }
            onOpenClaude={(p) => openClaude(activeTab.id, p)}
            onOpenExternal={(p) => window.api.externalOpen(p)}
            onOpenFile={(p, m) => openViewerTab(p, m, activeTab.id)}
          />
        )}
        {activeTab?.view === 'viewer' && activeTab.filePath && (
          activeTab.viewerMode === 'diff'
            ? <DiffView filePath={activeTab.filePath} />
            : <Viewer filePath={activeTab.filePath} />
        )}
        {/* Terminals stay mounted for every terminal tab and are merely hidden
            when inactive. Unmounting disposes the xterm, and a rebuilt instance
            only ever receives *new* pty bytes — it never sees the escape
            sequences that put the terminal in alt-screen / application-cursor
            mode. A Claude session then silently stops scrolling, because the
            wheel is no longer translated into anything its TUI understands.
            Scrollback is lost with it. KAN-23.

            KAN-45: this maps the WHOLE `tabs` store, not `spaceTabs` — the same
            discipline one level up. Switching a space must change which tabs
            render, not which processes exist, so a background space's terminals
            stay mounted and hidden exactly like a background tab's. Narrowing
            this to the active space would resurrect KAN-23 per space switch.
            Keyed off `activeTab?.id` rather than `active` so a focus id that
            somehow names a tab outside this space hides everything instead of
            showing a terminal with no tab on the strip. */}
        {tabs.map((t) =>
          t.view === 'terminal' && t.ptyId ? (
            <div key={t.id} className="pane" hidden={t.id !== activeTab?.id}>
              <Terminal ptyId={t.ptyId} />
            </div>
          ) : null,
        )}
      </div>
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}
