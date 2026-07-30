import { useEffect, useMemo, useRef, useState } from 'react';
import {
  newFilesTab, newTerminalTab, toPersisted, fromPersisted, needsSpawn,
  closeTabList, openViewerTabList, type Tab,
} from './tabs';
import {
  closePane as closePaneIn, compact, neighbour, occupy, placeAtSeam, placeBeside,
  reflow, showIn, single, split as splitLayout, type Side,
} from './gridlayout';
import {
  dividerId, dropZone, gridPlacement, zoneId,
  type Box, type DropZone, type PaneBox, type SeamBox,
} from './splitgrid';
import { SplitDividers } from './components/SplitDividers';
import { GridPicker } from './components/GridPicker';
import {
  addToGroup, deleteGroup, moveGroupRun, newGroup, recolorGroup, removeFromGroup,
  renameGroup, reorderWithGroups, setCollapsed, setPinned,
} from '../shared/groups';
import {
  addTabToSpace, createSpace, deleteSpace, removeTabFromSpace, renameSpace,
  reorderInSpace, setActiveTab, switchSpace,
} from './spaces';
import type { GridLayout, Space, TabGroup } from '../shared/types';
import { isTextBox, isTypingTarget } from './keys';
import { usePtyStatus } from './ptystatus';
import { FileBrowser } from './components/FileBrowser';
import { Terminal } from './components/Terminal';
import { Viewer } from './components/Viewer';
import { DiffView } from './components/DiffView';
import { SettingsModal } from './components/SettingsModal';
import { SpaceMenu } from './components/SpaceMenu';
import { PLACED_MIME, TAB_MIME, TabBar, type GroupActions, type SplitActions } from './TabBar';

const basename = (p: string) => p.split(/[\\/]/).pop() || p;

/** How far the pointer must travel before an Alt+press on a pane becomes a
 *  drag rather than the click-to-focus it would otherwise have been. */
const PANE_DRAG_PX = 4;

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
  /** The Ctrl+Shift+G arrangement picker (KAN-56). Just open/closed — it stages
   *  nothing, which is what makes Escape inert. */
  const [picker, setPicker] = useState(false);
  const status = usePtyStatus();
  // The pane container. SplitDividers' handles are grid items ON this element's
  // grid, so they must be its children, and the drag converts pixels to
  // fractions against its box.
  const contentRef = useRef<HTMLDivElement>(null);
  // --- direct manipulation (KAN-56) ---------------------------------------
  /** The always-mounted drop indicator. Written to directly, never through
   *  React — see `paint` below. */
  const indicatorRef = useRef<HTMLDivElement>(null);
  /** `zoneId` of what the indicator is currently showing, so a pointer move
   *  that stays inside one zone touches the DOM zero times. */
  const lastZone = useRef('none');
  /** Pane and seam rectangles, measured ONCE per drag (they cannot move while
   *  one is in flight) and container-relative, which is the coordinate space
   *  `dropZone` and the indicator both speak. */
  const dropGeom = useRef<{ panes: PaneBox[]; seams: SeamBox[]; origin: DOMRect } | null>(null);
  /** An Alt+drag of a pane BODY, below or above the movement threshold. */
  const paneDrag = useRef<
    { tabId: string; x: number; y: number; moved: boolean; pointerId: number } | null
  >(null);
  const lastActivated = useRef<Map<string, number>>(new Map());
  const spawning = useRef<Set<string>>(new Set());
  // An argv/Explorer open is APPENDED to whatever restore produces, never
  // merged into it and never allowed to lose to it: the restore effect below
  // ends in a *replacing* setTabs(restored), so a tab added before it resolves
  // would be silently destroyed. Held here until restore has committed.
  const restoreDone = useRef(false);
  const pendingCli = useRef<[string, string] | null>(null); // [cmd, path]
  // Same race, separate queue (KAN-55): the native File > Open Recent menu's
  // `menu:session` rows also append a tab before restore may have committed,
  // but they carry a resumeId that pendingCli's [cmd, path] shape has no room
  // for and applyCli must never grow a spawning arm to hold. See the flush
  // next to pendingCli's below, and the onMenuSession subscription further down.
  const pendingSession = useRef<[string, string | undefined] | null>(null);

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

  // --- split view (KAN-46) -------------------------------------------------
  //
  // HOW PLACEMENT COMPOSES WITH THE FLAT PANE LIST. Split view does not own the
  // panes and never re-parents one. `.content` keeps being the single flat
  // container it has always been, holding one absolutely positioned `.pane` per
  // renderable tab; all `gridPlacement()` does is turn it into a CSS Grid and
  // hand each pane a `grid-area`. An absolutely positioned child WITH a grid
  // position takes that cell as its containing block, so `inset: 0` fills the
  // cell exactly — the panes tile without one node moving in the tree. That is
  // the KAN-23 constraint made structural: an xterm that changes parent is an
  // xterm that loses alt-screen mode and its scrollback, so the only thing a
  // split is allowed to change about a pane is its `style`.
  //
  // `layout: null` therefore needs no special case: `gridPlacement` returns an
  // empty container style and no pane styles, which leaves `.content` exactly
  // the block box it is today with one visible `inset: 0` pane in it.

  /**
   * The layout as it may actually be RENDERED.
   *
   * A cell naming a tab this space no longer owns (closed, or moved to another
   * space) would otherwise reserve a grid area with no element in it — a hole
   * in the tiling. Repaired here rather than on each of the paths a tab can
   * leave a space by, because this is where the obligation actually is and
   * because it also covers a `workspace.json` that predates the pruning. The
   * persisted copy self-heals through `sanitize()`, which drops the same cells
   * on the next write.
   */
  const layout = useMemo(() => {
    const l = activeSpace?.layout;
    if (!l) return null;
    const live = new Set(sliceOf(activeSpace!.tabIds, tabs).map((t) => t.id));
    const cells = l.cells.filter((c) => live.has(c.tabId));
    if (!cells.length) return null;
    return cells.length === l.cells.length ? l : compact({ ...l, cells });
  }, [activeSpace, tabs]);

  const placement = useMemo(
    () => gridPlacement(layout, activeSpace?.colFractions, activeSpace?.rowFractions),
    [layout, activeSpace?.colFractions, activeSpace?.rowFractions],
  );

  const activeTab = spaceTabs.find((t) => t.id === active);

  /** The tabs with a pane on screen. Without a split that is just the active
   *  tab, which is what makes the single-pane path literally unchanged. */
  const visible = placement.split
    ? spaceTabs.filter((t) => placement.panes[t.id])
    : activeTab ? [activeTab] : [];
  const visibleIds = new Set(visible.map((t) => t.id));

  /** The active space through `fn`, everything else untouched. */
  const mapActiveSpace = (fn: (s: Space) => Space) =>
    setSpaces((ss) => ss.map((s) => (s.id === activeSpaceIdRef.current ? fn(s) : s)));

  // `active` is the tab with focus right now; `space.activeTabId` is the memory
  // of it, so coming back to a space lands where you left it (KAN-43 persists
  // that field). setActiveTab refuses a tab the space does not own, so the
  // membership update always has to be queued before this.
  //
  // KAN-46: the strip stays global and single while a split is up, so clicking
  // a tab has to say WHICH pane it lands in. It lands in the focused one —
  // `showIn` swaps it for the tab that was there, which keeps its place on the
  // strip and simply stops being visible. Clicking a tab that already has a
  // pane is a plain focus move (showIn no-ops), which is also what a click
  // inside a pane produces via `onPointerDownCapture` below. With no layout
  // there is nothing to retarget and this is byte-for-byte what it always was.
  const selectTab = (id: string) => {
    const from = active;
    lastActivated.current.set(id, Date.now());
    setActive(id);
    setSpaces((ss) => {
      // Same reference when nothing moved — `setActiveTab` is careful about
      // that too, and the debounced persist keys off `spaces` identity.
      const i = ss.findIndex((s) => s.id === activeSpaceIdRef.current);
      const l = i === -1 ? null : ss[i].layout;
      const next = l && showIn(l, from, id);
      const retargeted =
        next && next !== l ? ss.map((s, k) => (k === i ? { ...s, layout: next } : s)) : ss;
      return setActiveTab(retargeted, activeSpaceIdRef.current, id);
    });
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
      const ps = pendingSession.current;
      pendingSession.current = null;
      if (ps) openClaudeNewTab(ps[0], ps[1]);
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
  //
  // KAN-46: "on first activation" means every tab that is ON SCREEN, not just
  // the focused one. A restored split shows several terminals at once, and a
  // pane whose tab never spawned renders nothing — the grid area is reserved
  // and empty, which is a hole in the tiling that looks like the app lost a
  // pane. `spawning` keeps this idempotent across the extra renders `placement`
  // adds to the dependency list.
  useEffect(() => {
    for (const t of tabs) {
      if (!visibleIds.has(t.id) || !needsSpawn(t) || spawning.current.has(t.id)) continue;
      spawn(t);
    }
  }, [active, tabs, placement]);

  const spawn = (t: Tab) => {
    spawning.current.add(t.id);
    spawnFor(t)
      .then((ptyId) => {
        // The tab (or its whole space) can have been closed while the spawn
        // was in flight — a Claude spawn is the slowest thing this app does,
        // easily ~2 minutes (resume.mjs's own comment). `update` no-ops on a
        // missing id, which used to leak the process: no ptyId is ever
        // recorded anywhere, so nothing can find it to kill it (KAN-45
        // integration review #1). Checked against the list React is about to
        // commit, not this closure's `tabs`, for the same KAN-37 reason every
        // other functional updater here is.
        setTabs((ts) => {
          if (!ts.some((x) => x.id === t.id)) { window.api.ptyKill(ptyId); return ts; }
          return ts.map((x) => (x.id === t.id ? { ...x, ptyId } : x));
        });
      })
      .finally(() => spawning.current.delete(t.id));
  };

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

  // Native File > Open Recent rows (KAN-55) ride `menu:session`, a SEPARATE
  // channel from `menu:command` sent only from src/main/menu.ts — not because
  // this needs its own plumbing for its own sake, but because a resumeId is a
  // spawn instruction, and menu:command/applyCli must stay something an
  // unauthenticated CLI caller could also send (see the comment above
  // applyCli). Same mount-once + ref-to-latest-closure shape as onMenuCommand,
  // and the same restore race applies: openClaudeNewTab appends to `tabs`,
  // but the restore effect above ends in a REPLACING setTabs(restored), so a
  // session opened before that commits would be wiped out a moment later.
  // Queued in `pendingSession` and flushed right where pendingCli is.
  const sessionHandler = useRef<(path: string, resumeId?: string) => void>(() => {});
  sessionHandler.current = (path, resumeId) => {
    if (!restoreDone.current) { pendingSession.current = [path, resumeId]; return; }
    openClaudeNewTab(path, resumeId);
  };
  useEffect(() => window.api.onMenuSession((path, resumeId) => sessionHandler.current(path, resumeId)), []);

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
  // KAN-45 integration review #3: the dedupe is scoped to the ACTIVE space's
  // membership, not the whole store — re-opening a file a background space
  // already has open makes a second viewer tab here instead of stealing that
  // space's tab. The alternative (move it here, `expand` its groupId too) was
  // rejected: a moved tab would still be tagged with a group the receiving
  // space never showed a chip for, reproducing finding #2's cross-space split
  // through a second door. Viewer tabs own no process, so a duplicate costs
  // nothing to close. `activeSpace` is read from this render's closure, same
  // as `applyToSlice` — menu/click-driven, one call per user action.
  const openViewerTab = async (filePath: string, mode: 'file' | 'diff' = 'file', sourceId?: string) => {
    const link = sourceId !== undefined && (await window.api.settingsGet()).groupWithSource;
    const scope = new Set(activeSpace?.tabIds ?? []);
    setTabs((ts) => {
      const groupId = link ? ts.find((t) => t.id === sourceId)?.groupId : undefined;
      if (groupId !== undefined) expand(groupId);
      const { tabs: next, id } = openViewerTabList(ts, filePath, mode, groupId, scope);
      placeInSpace(id, groupId, next);
      selectTab(id);
      return next;
    });
  };

  const closeTab = (id: string) => {
    const t = tabs.find((x) => x.id === id);
    if (t?.ptyId) window.api.ptyKill(t.ptyId);
    lastActivated.current.delete(id);
    // Route the space's layout through closePaneIn too, exactly like the "Close
    // pane" menu item — not just membership. Without this the render-time
    // `layout` memo only ever `compact`s dead cells away, which can only drop a
    // track that is empty on EVERY row/col; a hole whose track is still occupied
    // by a neighbour (an L-shaped or T-shaped tiling) stays a hole forever
    // (KAN-46 review #2). `closePaneIn` no-ops when `id` has no cell.
    setSpaces((ss) => {
      const removed = removeTabFromSpace(ss, activeSpaceIdRef.current, id);
      if (removed === ss) return ss;
      return removed.map((s) =>
        s.id === activeSpaceIdRef.current && s.layout
          ? { ...s, layout: closePaneIn(s.layout, id) }
          : s);
    });
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
        // Prefer a PLACED survivor (one with a pane) when a split is up. MRU
        // alone can pick a tab with no cell — after a restore `lastActivated` is
        // empty, every survivor ties at 0, and `reduce` takes the first one in
        // `remaining`'s (tab-store) order, which is not necessarily one anyone
        // can currently see. Reproduced with a 3-pane split where the strip's
        // first tab is a member evicted from its cell by `showIn` (KAN-46 review
        // #3): re-picking it left the active tab highlighted on the strip with
        // no visible pane, and clicking it was a no-op (`showIn` treats
        // `tabId === focusedTabId` as already-shown). With no split `layout` is
        // null, `placedIds` is empty, and this falls through to plain MRU —
        // byte-for-byte the old behaviour.
        const placedIds = new Set(layout?.cells.map((c) => c.tabId) ?? []);
        const pool = survivors.some((x) => placedIds.has(x.id))
          ? survivors.filter((x) => placedIds.has(x.id))
          : survivors;
        // Most-recently-activated survivor; '' only when the space is now empty.
        setActive(pool.length
          ? pool.reduce((a, b) =>
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
    // Where the tab ACTUALLY landed, not where the drag asked it to: KAN-53
    // makes reorderWithGroups clamp `insert` into the dragged tab's own region
    // (pinned tabs are held left of every unpinned one), and reorderInSpace
    // holds ids only, so it cannot re-derive that. Reading the landing index
    // back off the result keeps the two in step by construction rather than by
    // two clamp formulas being kept identical.
    const landed = next.findIndex((t) => t.id === moved.id);
    setSpaces((ss) => reorderInSpace(ss, activeSpaceIdRef.current, from, landed));
    if (newGroupId === moved.groupId) return;
    // Only the tag changes in the store; the position lives in `tabIds`.
    setTabs((ts) => ts.map((t) => (t.id === moved.id ? next.find((x) => x.id === moved.id)! : t)));
    if (newGroupId !== undefined) expand(newGroupId);
  };

  // Drag-by-head (KAN-52). `applyToSlice` already does exactly the right thing:
  // moveGroupRun is a permutation of the slice that changes no record, so only
  // the space's `tabIds` actually moves. Nothing to expand — a collapsed run
  // drags as the one thing it looks like.
  const reorderGroup = (groupId: string, insert: number) =>
    applyToSlice((sl) => moveGroupRun(sl, groupId, insert));

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

  /**
   * Pin / unpin (KAN-53). Same shape as the three group membership ops and for
   * the same reason: pinning MOVES the tab (to the seam between the pinned and
   * unpinned regions), and the strip is the active space's slice — so the new
   * order has to go back into that space's `tabIds`, not just the tab record.
   * `setPinned` also drops the groupId, which `applyToSlice` writes through
   * because it replaces whole records.
   */
  const togglePin = (id: string) =>
    applyToSlice((sl) => setPinned(sl, id, !sl.find((t) => t.id === id)?.pinned));

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

  // Feature 1: File ▸ Open Recent ▸ a project ▸ a session launches Claude in a
  // NEW tab (never overrides current), resuming that session.
  // KAN-47: the File menu is tab-bar-global, not scoped to any tab — no source
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

  // KAN-45 integration review #5: `spaces` (this render's closure) is used
  // only to mint the new space's fixed id up front — `createSpace` calls
  // `crypto.randomUUID()`, so it cannot be re-run against a fresher list
  // without producing a SECOND id that `goToSpace` below would never match.
  // The actual write is the functional form appending that one already-built
  // object, which composes correctly no matter what else lands in `spaces`
  // first: two `onCreateSpace` calls in one tick used to fight over the same
  // stale snapshot and the loser's space vanished (`setSpaces(next)` on a
  // closure read); appending by reference can't lose a sibling append.
  const onCreateSpace = (name: string) => {
    const { spaces: withNew, id } = createSpace(spaces, name);
    const created = withNew[withNew.length - 1];
    setSpaces((ss) => [...ss, created]);
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
    // The actual persisted array is recomputed against the list React is
    // about to commit, not the `r` above (KAN-45 integration review #5) — `r`
    // exists only to drive the synchronous side effects (which PTYs die,
    // which space to land on), all of which are decided by `id` and this
    // space's own membership and so hold regardless of what else is queued.
    // `deleteSpace` refusing (LAST_SPACE) against a fresher list it can't
    // currently reach is a real possibility under composition; falling back
    // to `ss` unchanged is exactly its own no-op convention.
    setSpaces((ss) => {
      const rr = deleteSpace(ss, activeSpaceIdRef.current, id);
      return rr.ok ? rr.spaces : ss;
    });
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

  /**
   * Everything a `.pane` element needs. The focus ring and the click-to-focus
   * handler are both split-only: with one pane there is nothing to disambiguate,
   * and attaching a `selectTab` to the whole content area would make a click on
   * a file row a state write it is not today.
   *
   * Capture phase, deliberately: xterm stops propagation on its own container,
   * so a bubbling handler never sees a click inside a terminal — exactly the
   * pane you most need to be able to focus by clicking it.
   */
  const paneProps = (t: Tab) => ({
    className: placement.split && t.id === active ? 'pane pane-focused' : 'pane',
    style: placement.panes[t.id],
    'data-pane': t.id,
    ...(placement.split ? { onPointerDownCapture: () => selectTab(t.id) } : {}),
  });

  // Track sizes are per-space state, so a divider drag survives a space switch
  // and a restart. Fired once per drag (on pointerup), never per pointermove —
  // mid-drag SplitDividers writes the template straight to the DOM.
  const persistFractions = (cols: number[], rows: number[]) =>
    mapActiveSpace((s) => ({ ...s, colFractions: cols, rowFractions: rows }));

  /**
   * A layout write, with the fraction rule in ONE place (KAN-56).
   *
   * Fractions describe TRACKS, not panes, so they survive an operation exactly
   * when that axis's track count survives it — which is also
   * `normalizeFractions`'s own fallback condition, so the two can never
   * disagree. Cleared per AXIS, not per operation: a column split has no
   * opinion about row heights, and the old "clear both on every split and every
   * close" threw away heights the user had dragged.
   *
   * Never keep an array whose length disagrees with the count. Clearing on a
   * count change is what stops a stale array resurrecting later, when the count
   * happens to wander back to the length it was written for.
   */
  const withLayout = (s: Space, prev: GridLayout | null, next: GridLayout | null): Space => ({
    ...s,
    layout: next,
    colFractions: prev && next && next.cols === prev.cols ? s.colFractions : undefined,
    rowFractions: prev && next && next.rows === prev.rows ? s.rowFractions : undefined,
  });

  /**
   * Split the FOCUSED pane and show `tabId` in the half that appears.
   *
   * With no layout yet the focused pane is the whole content area, so the split
   * starts from `single(active)`. `splitLayout` returns its input unchanged
   * when it cannot do anything (nothing focused, or `tabId` already has a
   * pane), and that no-op is what keeps a pointless menu click from
   * materialising a 1x1 grid where `layout: null` was.
   *
   * Fractions go through `withLayout`, which drops only the axis whose track
   * count actually changed — a "Split right" keeps the row heights you dragged.
   *
   * Bases off the RENDERED `layout` memo, not `s.layout` — a layout whose cells
   * all belonged to since-closed tabs is a corpse (`{cells: []}` before
   * sanitize's KAN-46 review #1 fix, and a pre-fix workspace.json can still hand
   * one to a fresh session): falling back to `s.layout` finds cells but no
   * `focusedTabId` among them, `splitLayout` no-ops, and split view is dead for
   * the rest of the space's life. `layout` has already had exactly that case
   * pruned to `null`, which is what lets the `single(active)` fallback fire.
   */
  const splitPane = (tabId: string, axis: 'col' | 'row') => {
    mapActiveSpace((s) => {
      const base = layout ?? (active ? single(active) : null);
      if (!base) return s;
      const next = splitLayout(base, active, tabId, axis);
      if (next === base) return s;
      return withLayout(s, base, next);
    });
    selectTab(tabId); // queued after the split, so `showIn` finds it placed and no-ops
  };

  /** Removes a pane. The tab stays on the strip — panes are placement, the strip
   *  is reachability. The last pane going away restores `layout: null`. */
  const closePane = (tabId: string) => {
    const survivor = layout?.cells.find((c) => c.tabId !== tabId)?.tabId;
    mapActiveSpace((s) => {
      // Same reasoning as `splitPane`: base off the pruned `layout` memo, not
      // `s.layout`, or a corpse layout (all cells dead) leaves this a no-op too.
      if (!layout) return s;
      return withLayout(s, layout, closePaneIn(layout, tabId));
    });
    // Closing the pane you were in leaves focus on a tab with nothing on screen.
    if (tabId === active && survivor) selectTab(survivor);
  };

  // --- direct manipulation (KAN-56) ----------------------------------------
  //
  // Two gestures, one drop model. Dragging a tab off the STRIP into the pane
  // area and Alt+dragging a pane BODY both end in `applyDrop` with a zone from
  // `dropZone`: an edge quarter splits the pane under the pointer, a centre
  // replaces or swaps its occupant, a divider inserts a full-run track.
  //
  // Nothing here re-parents a pane. Every operation is a pure
  // GridLayout -> GridLayout transform, so `gridPlacement` still emits the same
  // {container, panes} shape and the panes stay the flat, always-mounted list
  // `.content` has always held — which is KAN-23 made structural, not a rule
  // anyone has to remember (see the render comments below).

  const paneEl = (tabId: string) =>
    contentRef.current?.querySelector<HTMLElement>(`[data-pane="${CSS.escape(tabId)}"]`) ?? null;

  /**
   * Freeze the rectangles CSS Grid produced, container-relative — the
   * coordinate space `dropZone` and the indicator both speak.
   *
   * ONCE per drag, not per move: nothing can resize a pane while one is in
   * flight, and re-measuring 60x/second is exactly the cost this path exists to
   * avoid. `placed` (the dragged thing already has a cell) suppresses the seam
   * zones, because `placeAtSeam` refuses a placed tab — offering a zone the
   * model will reject is worse than not offering it at all.
   */
  const measureDrop = (placed: boolean) => {
    const node = contentRef.current;
    if (!node) return null;
    const origin = node.getBoundingClientRect();
    const rel = (r: DOMRect): Box =>
      ({ left: r.left - origin.left, top: r.top - origin.top, width: r.width, height: r.height });
    // With no split there is exactly one pane — the active tab's, filling the
    // whole content box. That is the case the first-split gesture starts from,
    // which is why this is not gated on `placement.split`.
    const ids = placement.split ? placement.cells.map((c) => c.tabId) : active ? [active] : [];
    const panes: PaneBox[] = [];
    for (const tabId of ids) {
      const el = paneEl(tabId);
      if (el) panes.push({ tabId, ...rel(el.getBoundingClientRect()) });
    }
    const seams: SeamBox[] = [];
    if (!placed)
      for (const d of placement.dividers) {
        const el = node.querySelector<HTMLElement>(`[data-divider="${dividerId(d)}"]`);
        if (el) seams.push({ ...d, ...rel(el.getBoundingClientRect()) });
      }
    const g = { panes, seams, origin };
    dropGeom.current = g;
    return g;
  };

  /**
   * The drop indicator, written STRAIGHT to the DOM — the same precedent
   * `SplitDividers` sets for a divider drag, and for the same reason: a
   * setState per pointermove re-renders the whole app ~60x/second.
   *
   * A move that stays inside one zone costs nothing at all (the `zoneId`
   * compare returns early); one that crosses a boundary costs exactly two
   * attribute writes. `cssText` in one assignment rather than five property
   * sets, which would be five separate mutation records for no gain.
   */
  const paint = (z: DropZone) => {
    const el = indicatorRef.current;
    const id = zoneId(z);
    if (!el || id === lastZone.current) return;
    lastZone.current = id;
    el.dataset.zone = z.kind === 'none' ? '' : id;
    el.style.cssText = z.kind === 'none'
      ? ''
      : `display:block;left:${z.box.left}px;top:${z.box.top}px;`
        + `width:${z.box.width}px;height:${z.box.height}px`;
  };

  /** Every way a drag can stop mattering. Ref- and DOM-only on purpose, so the
   *  mount-once listeners below can hold the first render's copy without ever
   *  going stale. */
  const endDrop = () => { dropGeom.current = null; paint({ kind: 'none' }); };

  const endPaneDrag = () => {
    const node = contentRef.current;
    node?.classList.remove('dragging-pane');
    node?.querySelector('.pane-dragging')?.classList.remove('pane-dragging');
    endDrop();
  };

  /**
   * Land `tabId` in zone `z`.
   *
   * ORDERING RULE: the layout is written first and `selectTab` second, or
   * `selectTab`'s own `showIn` retargets the focused pane instead — the exact
   * hazard `splitPane` documents. And focus only moves when the layout really
   * changed, because a refused drop must not have a side effect either.
   */
  const applyDrop = (tabId: string, z: DropZone) => {
    if (!tabId || z.kind === 'none') return;
    // A centre drop with no grid up is just "show this tab". Materialising a
    // 1x1 layout would turn `.content` into a grid for nothing visible, which
    // is the same care `splitPane` takes about a pointless split.
    if (z.kind === 'centre' && !layout) { selectTab(tabId); return; }
    // An EDGE drop with no grid is the headline gesture — it is what creates
    // the first split — so that one does start from `single(active)`.
    const base = layout ?? (z.kind === 'edge' && active ? single(active) : null);
    if (!base) return;
    const next =
      z.kind === 'centre' ? occupy(base, tabId, z.tabId)
        : z.kind === 'edge' ? placeBeside(base, tabId, z.tabId, z.side)
          : placeAtSeam(base, tabId, z.axis, z.index, z.start, z.end);
    if (next === base) return; // refused
    mapActiveSpace((s) => withLayout(s, layout, next));
    selectTab(tabId);
  };

  const zoneAt = (
    g: NonNullable<typeof dropGeom.current>, clientX: number, clientY: number,
  ) => dropZone(g.panes, g.seams, clientX - g.origin.left, clientY - g.origin.top);

  // A tab dragged off the strip.
  //
  // CAPTURE phase, and that is not cosmetic: FileBrowser's directory rows
  // `stopPropagation()` on `drop` for ANY drag (`onDrop` there is gated on
  // `e.isDirectory`, not on `app.drag`), so a bubbling handler here never sees
  // a tab dropped onto a folder row — the single most likely place to drop one,
  // since a file pane is mostly folder rows. Capture runs root->target, before
  // that stop.
  //
  // Both handlers return untouched unless the drag carries TAB_MIME, so a FILE
  // drag reaches FileBrowser's own handlers byte-for-byte as it does today.
  // Inside that gate the tab drop DOES stop propagating: `dropInto` would only
  // no-op on it, and letting it through would leave a row's drop-target
  // highlight behind.
  const contentDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes(TAB_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const g = dropGeom.current ?? measureDrop(e.dataTransfer.types.includes(PLACED_MIME));
    if (g) paint(zoneAt(g, e.clientX, e.clientY));
  };

  const contentDrop = (e: React.DragEvent<HTMLDivElement>) => {
    const g = dropGeom.current;
    if (!e.dataTransfer.types.includes(TAB_MIME) || !g) return;
    e.preventDefault();
    e.stopPropagation();
    const z = zoneAt(g, e.clientX, e.clientY);
    endDrop();
    applyDrop(e.dataTransfer.getData(TAB_MIME), z);
  };

  /**
   * Alt + primary drag on a pane BODY rearranges panes.
   *
   * CAPTURE phase on `.content`, and the same reasoning as `paneProps`'
   * click-to-focus: xterm stops propagation on its own container, so a bubbling
   * handler never sees a press inside a terminal. Stopping the synthetic event
   * here — while the browser is still at the root — means it never reaches
   * xterm or FileBrowser at all, and `preventDefault()` suppresses the
   * compatibility `mousedown` that would otherwise start an xterm text
   * selection or an HTML5 file drag on a FileBrowser row.
   *
   * WITHOUT Alt none of that happens: the event is not intercepted, so plain
   * drags reach xterm and FileBrowser byte-for-byte as they do today. Alt is
   * the only modifier this app has not already spent (Ctrl = copy /
   * toggle-select, Shift = move / range-select), and Alt+drag-to-move is the
   * tiling-WM idiom a split-pane user already knows.
   */
  const onPaneDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!placement.split || !e.altKey || e.button !== 0) return;
    const tabId = (e.target as Element).closest?.('[data-pane]')?.getAttribute('data-pane');
    if (!tabId || !placement.panes[tabId]) return;
    e.preventDefault();
    e.stopPropagation();
    paneDrag.current = { tabId, x: e.clientX, y: e.clientY, moved: false, pointerId: e.pointerId };
    // Same trick SplitDividers uses on its 9px handles: a drag that outruns the
    // pane keeps delivering moves, with no window listeners to forget to remove.
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPaneMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = paneDrag.current;
    if (!g) return;
    if (!g.moved) {
      if (Math.abs(e.clientX - g.x) < PANE_DRAG_PX && Math.abs(e.clientY - g.y) < PANE_DRAG_PX) return;
      g.moved = true;
      measureDrop(true);
      contentRef.current?.classList.add('dragging-pane');
      // opacity + outline, NEVER a transform: a transformed ancestor changes an
      // xterm's containing block and its getBoundingClientRect, which breaks
      // fit and selection maths, and creates a stacking context that can hide
      // the divider handles.
      paneEl(g.tabId)?.classList.add('pane-dragging');
    }
    const geom = dropGeom.current;
    if (geom) paint(zoneAt(geom, e.clientX, e.clientY));
  };

  const onPaneUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = paneDrag.current;
    const geom = dropGeom.current;
    paneDrag.current = null;
    if (!g) return;
    endPaneDrag();
    // Below the threshold this was a click, and a click on a pane is the focus
    // move `paneProps` would have made had the capture handler not swallowed it.
    if (!g.moved) { selectTab(g.tabId); return; }
    if (e.type === 'pointercancel' || !geom) return;
    applyDrop(g.tabId, zoneAt(geom, e.clientX, e.clientY));
  };

  // Escape aborts a pane drag with no state change; `dragend` clears an
  // indicator left over from a drag that ended somewhere else.
  //
  // Alt keyup must not pop the native menu bar out from under a drag.
  // ponytail: Chromium already cancels menu activation once a mouse press
  // intervenes, so this is only the belt. If some Windows build still flashes
  // the menu, gate the drag on Alt at pointerdown only and drop the guard on
  // the first pointermove.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!paneDrag.current) return;
      if (e.type === 'keyup') { if (e.key === 'Alt') e.preventDefault(); return; }
      if (e.key !== 'Escape') return;
      e.preventDefault();
      paneDrag.current = null;
      endPaneDrag();
    };
    const done = () => endDrop();
    window.addEventListener('keydown', key, true);
    window.addEventListener('keyup', key, true);
    window.addEventListener('dragend', done, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('keyup', key, true);
      window.removeEventListener('dragend', done, true);
    };
  }, []);

  /** Tab ids with a pane, in STRIP order — the order `reflow` tiles them in, so
   *  a picked arrangement reads left-to-right like the strip does. */
  const placedInStripOrder = spaceTabs
    .filter((t) => (placement.split ? placement.panes[t.id] : t.id === active))
    .map((t) => t.id);

  const applyReflow = (cols: number, rows: number) => {
    setPicker(false);
    // Nothing to rearrange without a split, and `reflow([one], 1, 1)` would only
    // materialise the pointless 1x1 that `layout: null` already means.
    if (!layout) return;
    const next = reflow(placedInStripOrder, cols, rows);
    if (!next) return;
    mapActiveSpace((s) => withLayout(s, layout, next));
  };

  /** Ctrl+Arrow inside the picker: swap the focused pane with its neighbour.
   *  Committed per press, exactly like SplitDividers' arrow-key resize, and
   *  therefore explicitly NOT part of what Escape reverts. */
  const movePane = (dir: Side) => {
    if (!layout || !active) return;
    const n = neighbour(layout, active, dir);
    if (!n) return;
    const next = occupy(layout, active, n);
    if (next === layout) return;
    mapActiveSpace((s) => withLayout(s, layout, next));
  };

  // Ctrl+Shift+G — the grid picker. Registered in the CAPTURE phase at window
  // and, unlike Ctrl+1..9 above, NOT gated by `isTypingTarget`.
  //
  // Ctrl+Shift+<letter> is not a distinct control code: xterm sends the same ^G
  // for Ctrl+G and Ctrl+Shift+G, which is precisely why every terminal emulator
  // reserves the Ctrl+Shift row for itself. A plain Ctrl+1 must reach the shell;
  // this must not. Capture at window is the first thing in the event path, so
  // xterm's own textarea listener never runs and no ^G reaches the pty —
  // preventDefault alone would be too late.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
      if (e.key.toLowerCase() !== 'g') return;
      if (isTextBox(e.target)) return; // rename / address / search boxes only
      e.preventDefault();
      e.stopPropagation();
      setPicker((p) => !p);
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, []);

  const splitActions: SplitActions = {
    placed: placement.split ? Object.keys(placement.panes) : active ? [active] : [],
    split: placement.split,
    onSplit: splitPane,
    onClosePane: closePane,
  };

  return (
    <div className="app">
      <TabBar
        tabs={spaceTabs}
        groups={groups}
        groupActions={groupActions}
        splitActions={splitActions}
        activeId={active}
        status={status}
        onSelect={selectTab}
        onClose={closeTab}
        onAdd={addTab}
        onReorder={reorderTabs}
        onReorderGroup={reorderGroup}
        onTogglePin={togglePin}
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
      />
      <div
        className="content"
        ref={contentRef}
        style={placement.container}
        // KAN-56. The drag handlers govern TAB drags only, so a file drag
        // reaches FileBrowser exactly as before; the pointer handlers do
        // nothing at all without Alt held. Capture phase — see contentDrop.
        onDragOverCapture={contentDragOver}
        onDropCapture={contentDrop}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) endDrop();
        }}
        onPointerDownCapture={onPaneDown}
        onPointerMove={onPaneMove}
        onPointerUp={onPaneUp}
        onPointerCancel={onPaneUp}
      >
        {/* Files and viewer panes are mounted only while visible, exactly as
            they were before split view — a FileBrowser has no alt-screen mode
            and no scrollback to lose, so there is nothing to keep alive off
            screen. The only change is the `.pane` wrapper they now share with
            the terminals, which is what gives them a grid area to sit in.
            `.filebrowser`/`.viewer` are height:100%, and `.pane` is
            `inset: 0` on a positioned container either way, so the box they
            get is the same one they got as a direct child of `.content`. */}
        {visible.map((t) => (t.view === 'terminal' ? null : (
          <div key={t.id} {...paneProps(t)}>
            {t.view === 'files' && (
              <FileBrowser
                cwd={t.cwd}
                tabId={t.id}
                onNavigate={(p) =>
                  update(t.id, { cwd: p, ...(t.renamed ? {} : { title: basename(p) }) })
                }
                onOpenClaude={(p) => openClaude(t.id, p)}
                onOpenExternal={(p) => window.api.externalOpen(p)}
                onOpenFile={(p, m) => openViewerTab(p, m, t.id)}
              />
            )}
            {t.view === 'viewer' && t.filePath && (
              t.viewerMode === 'diff'
                ? <DiffView filePath={t.filePath} />
                : <Viewer filePath={t.filePath} />
            )}
          </div>
        )))}
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
            Keyed off `visibleIds` rather than `active` so a focus id that
            somehow names a tab outside this space hides everything instead of
            showing a terminal with no tab on the strip — and so a split shows
            every terminal that has a cell, not just the focused one. */}
        {tabs.map((t) =>
          t.view === 'terminal' && t.ptyId ? (
            <div key={t.id} {...paneProps(t)} hidden={!visibleIds.has(t.id)}>
              <Terminal ptyId={t.ptyId} />
            </div>
          ) : null,
        )}
        {/* Handles only — no pane is a child of this component. Last, so a
            handle sits above the panes in paint order as well as in z-index. */}
        <SplitDividers
          placement={placement}
          containerRef={contentRef}
          onResize={persistFractions}
        />
        {/* The drop indicator (KAN-56). A SIBLING of the panes, never a
            wrapper, and permanently mounted — conditional rendering would be a
            React state change per drag, and the first-split gesture needs it
            up before any split exists. Absolutely positioned with no grid
            placement, so it takes `.content`'s padding box and does NOT become
            a grid item; `pointer-events: none` guarantees it cannot eat a
            dragover. Everything about it is written by `paint`. */}
        <div className="drop-indicator" data-zone="" aria-hidden ref={indicatorRef} />
      </div>
      {/* Rendered as a child of `.app`, NOT of `.content`, and that placement is
          load-bearing: any in-flow child of a grid container is auto-placed into
          the first free cell, so a popover inside `.content` would silently
          claim a pane's rectangle (splitgrid.ts's container contract). */}
      {picker && (
        <GridPicker
          // 0 with no split up: there is no arrangement to pick, so `canReflow`
          // refuses every cell and the picker says so instead of offering a
          // 1x1 that would only materialise the grid `layout: null` already is.
          count={placement.split ? placedInStripOrder.length : 0}
          anchor={contentRef.current?.getBoundingClientRect() ?? null}
          onApply={applyReflow}
          onMovePane={movePane}
          onClose={() => setPicker(false)}
        />
      )}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}
