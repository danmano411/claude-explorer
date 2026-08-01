import { useEffect, useMemo, useRef, useState } from 'react';
import {
  newFilesTab, newTerminalTab, toPersisted, toControlTab, fromPersisted, needsSpawn,
  closeTabList, openViewerTabList, type Tab,
} from './tabs';
import {
  cellAt, cellKey, cellOf, closeCell, compact, insertAtSeam, layoutTabIds, moveCellBeside,
  moveTab, neighbour, readingOrder, reflow, removeTab, setCellTabs, showTab, single, splitCell,
  swapCells, type CellKey, type Side,
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
  addTabToSpace, createSpace, deleteSpace, orderSpaces, removeTabFromSpace, renameSpace,
  reorderInSpace, setActiveTab, setSpacePinned, switchSpace,
} from './spaces';
import { closeReason, closeRisk, moveTabReason, type CloseRisk } from './closeguard';
import type { ConfirmRequest } from './opresult';
import type {
  ControlRequest, ControlResult, GridCell, GridLayout, Space, SpawnConfirmRequest, TabGroup,
} from '../shared/types';
import {
  DEFAULT_SPACE_KEYBINDS, isTextBox, pinnedSpaceIndex, resolveSpaceKeybinds, spaceCycle, spaceIndex,
  type SpaceKeybinds,
} from './keys';
import { usePtyStatus } from './ptystatus';
import { FileBrowser } from './components/FileBrowser';
import { Terminal } from './components/Terminal';
import { Viewer } from './components/Viewer';
import { DiffView } from './components/DiffView';
import { SettingsModal } from './components/SettingsModal';
import { ConfirmDialog } from './components/ConfirmDialog';
import { SpawnConfirm } from './components/SpawnConfirm';
import { SpaceMenu } from './components/SpaceMenu';
import { LONE_MIME, TAB_MIME, TabBar, type GroupActions, type SplitActions } from './TabBar';

const basename = (p: string) => p.split(/[\\/]/).pop() || p;

/** `tabId`'s pane, addressed the way every gridlayout op wants it. */
const keyOfTab = (layout: GridLayout, tabId: string | undefined | null): CellKey | null => {
  const c = tabId ? cellOf(layout, tabId) : null;
  return c ? cellKey(c) : null;
};

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
  // KAN-83. The resolved (all four fields present) space keybinds, cached here
  // rather than re-read per keystroke — `settingsGet` is async and a keydown
  // handler has to decide synchronously, before xterm's own capture-phase
  // handling runs (see Terminal.tsx). Fetched on mount and again whenever the
  // Settings modal closes (`refreshKeybinds` below), which is what makes a
  // rebind take effect with no restart (KAN-83 acceptance #1) — the modal
  // itself is the only writer, and `settingsSet` has already resolved by the
  // time `onClose` fires. Passed down to every `Terminal` as a prop so both
  // halves (this file's window listeners, Terminal.tsx's
  // `attachCustomKeyEventHandler`) read the SAME value; see that file for how
  // it stays live without re-running the effect that creates the xterm
  // instance.
  const [keybinds, setKeybinds] = useState<SpaceKeybinds>(DEFAULT_SPACE_KEYBINDS);
  const refreshKeybinds = () =>
    void window.api.settingsGet().then((s) => setKeybinds(resolveSpaceKeybinds(s.spaceKeybinds)));
  useEffect(() => { refreshKeybinds(); }, []);
  /** KAN-41: the outstanding "an agent wants to start Claude in <path>" prompt.
   *  A single nullable, not a queue — main allows exactly one outstanding
   *  confirmation app-wide, so a second one arriving is a bug in main, not a
   *  state this has to render. Nothing here is authority: the token was minted
   *  in main and only main can redeem it. */
  const [spawnAsk, setSpawnAsk] = useState<SpawnConfirmRequest | null>(null);
  /** The Ctrl+Shift+G arrangement picker (KAN-56). Just open/closed — it stages
   *  nothing, which is what makes Escape inert. */
  const [picker, setPicker] = useState(false);
  /** The close confirm (KAN-57), or null. State-driven like every other modal
   *  here rather than a promise-returning `confirm()` helper — a resolver
   *  parked in a ref dangles if the component unmounts. */
  const [pendingClose, setPendingClose] = useState<ConfirmRequest | null>(null);
  /** The move-to-another-space confirm (KAN-66), or null. Its OWN state rather
   *  than a second use of `pendingClose`: nothing is being closed, so sharing
   *  the field would put two unrelated questions behind one nullable and let a
   *  close confirm and a move confirm silently overwrite each other. */
  const [pendingMove, setPendingMove] = useState<ConfirmRequest | null>(null);
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
  /** A pane being moved — by its strip (the title-bar grab) or by Alt+its body
   *  — below or above the movement threshold. Addressed by CELL, because the
   *  thing being dragged is the pane and its whole tab set, not one tab. */
  const paneDrag = useRef<
    { key: CellKey; x: number; y: number; moved: boolean; pointerId: number } | null
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

  // --- split view (KAN-46 / KAN-56) ----------------------------------------
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
  // KAN-56 makes a pane a window with its OWN tab strip, and that structure is
  // exactly why the strips are FLAT SIBLINGS too — a `<Pane>` component owning
  // its strip and its children would re-parent every xterm in the window on
  // every cross-pane move and on every `layout: null <-> grid` transition. Each
  // cell instead gets a `.paneslot` (absolute, same grid-area, pointer-events
  // none) holding only its strip, and the tab's `.pane` gets `top: STRIP_PX`
  // from `gridPlacement`. Moving a tab between panes therefore changes exactly
  // one thing: the `gridArea`/`top` on a node React never unmounts.
  //
  // `layout: null` needs no special case: `gridPlacement` returns an empty
  // container style, no pane styles and no strips, which leaves `.content`
  // exactly the block box it is today with one visible `inset: 0` pane in it.

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
   *
   * KAN-56 adds the other half of the same obligation: a live member with NO
   * cell is unreachable, because no strip lists it. It is adopted by the
   * focused pane — the same rule `sanitize()` applies to a tab orphaned across
   * spaces, one doctrine rather than two.
   */
  const layout = useMemo(() => {
    const l = activeSpace?.layout;
    if (!l) return null;
    const members = sliceOf(activeSpace!.tabIds, tabs).map((t) => t.id);
    const live = new Set(members);
    const seen = new Set<string>();
    const cells: GridCell[] = [];
    for (const c of l.cells) {
      const ids = c.tabIds.filter((id) => live.has(id) && !seen.has(id));
      if (!ids.length) continue; // the whole pane died with its tabs
      ids.forEach((id) => seen.add(id));
      cells.push(
        ids.length === c.tabIds.length && ids.includes(c.activeTabId)
          ? c
          : { ...c, tabIds: ids, activeTabId: ids.includes(c.activeTabId) ? c.activeTabId : ids[0] },
      );
    }
    if (cells.length < 2) return null; // one pane is not a split
    const orphans = members.filter((id) => !seen.has(id));
    if (orphans.length) {
      const host = cells.find((c) => c.tabIds.includes(active)) ?? readingOrder({ ...l, cells })[0];
      cells[cells.indexOf(host)] = { ...host, tabIds: [...host.tabIds, ...orphans] };
    }
    const same = cells.length === l.cells.length && cells.every((c, i) => c === l.cells[i]);
    return same ? l : compact({ ...l, cells });
  }, [activeSpace, tabs, active]);

  const placement = useMemo(
    () => gridPlacement(layout, activeSpace?.colFractions, activeSpace?.rowFractions),
    [layout, activeSpace?.colFractions, activeSpace?.rowFractions],
  );

  const activeTab = spaceTabs.find((t) => t.id === active);

  /** The tabs with a pane on screen — one per cell, its `activeTabId`. Without
   *  a split that is just the active tab, which is what makes the single-pane
   *  path literally unchanged. */
  const visible = placement.split
    ? spaceTabs.filter((t) => placement.panes[t.id])
    : activeTab ? [activeTab] : [];
  const visibleIds = new Set(visible.map((t) => t.id));

  /**
   * THE FOCUSED PANE IS DERIVED, never stored: it is whichever cell holds
   * `active`. One focus truth, nothing extra to persist and nothing to keep in
   * sync — `cell.activeTabId` is per-pane memory ("what this window was
   * showing"), `active` is "which window has focus".
   */
  const focusedKey = layout && active ? keyOfTab(layout, active) : null;

  /** One strip's ordered records: a pane's own `tabIds`, or — with no split —
   *  the space's whole slice, which is the single global strip. */
  const sliceFor = (key: CellKey | null): Tab[] =>
    key !== null && layout ? sliceOf(cellAt(layout, key)?.tabIds ?? [], tabs) : spaceTabs;

  /** The active space through `fn`, everything else untouched. */
  const mapActiveSpace = (fn: (s: Space) => Space) =>
    setSpaces((ss) => ss.map((s) => (s.id === activeSpaceIdRef.current ? fn(s) : s)));

  // `active` is the tab with focus right now; `space.activeTabId` is the memory
  // of it, so coming back to a space lands where you left it (KAN-43 persists
  // that field). setActiveTab refuses a tab the space does not own, so the
  // membership update always has to be queued before this.
  //
  // KAN-56: a tab belongs to exactly one pane, so clicking it can only ever mean
  // "show it in ITS pane and give that pane focus". `showTab` does the first
  // half and setting `active` does the second, which is the whole of what makes
  // the focused pane derivable. It no-ops when the tab is already its pane's
  // active one, i.e. for a plain focus move between panes — which is also what
  // a click inside a pane body produces via `onPointerDownCapture` below. With
  // no layout there is nothing to retarget and this is byte-for-byte what it
  // always was.
  const selectTab = (id: string) => {
    lastActivated.current.set(id, Date.now());
    setActive(id);
    setSpaces((ss) => {
      // Same reference when nothing moved — `setActiveTab` is careful about
      // that too, and the debounced persist keys off `spaces` identity.
      const i = ss.findIndex((s) => s.id === activeSpaceIdRef.current);
      const l = i === -1 ? null : ss[i].layout;
      const next = l && showTab(l, id);
      const shown =
        next && next !== l ? ss.map((s, k) => (k === i ? withLayout(s, l, next) : s)) : ss;
      return setActiveTab(shown, activeSpaceIdRef.current, id);
    });
  };

  /** Every open path lands the new tab in the space you are looking at. */
  const addToActiveSpace = (id: string) =>
    setSpaces((ss) => addTabToSpace(ss, activeSpaceIdRef.current, id));

  /**
   * Run a groups.ts membership op on ONE STRIP's slice, writing the changed tab
   * records back to the global store and the resulting id order back to where
   * that order lives: the pane's `cell.tabIds`, or — with no split — the
   * space's `tabIds`.
   *
   * Group ops REORDER — `addToGroup` pulls a tab to its group's right edge,
   * `removeFromGroup` pushes it just past the run — and the strip is the slice.
   * Running them on the global array alone would tag the tab correctly and leave
   * the strip drawing a shredded group, because the order never moved. The
   * order written is a permutation of the slice, so membership and the
   * exactly-one-owner rule are untouched by construction — which is also
   * exactly what `setCellTabs` refuses anything but.
   *
   * KAN-56 pushes that one level down, the same relaxation KAN-45 already made
   * when contiguity moved from the global tab list to a space's slice: a group
   * run is contiguous within a PANE strip, and a group may legitimately appear
   * in two panes at once, each drawing its own chip for the members it holds.
   *
   * Menu-driven, one user click per call, so reading this render's closure is
   * safe (KAN-37's composition hazard is about several updates issued before a
   * single commit, which a context menu cannot do).
   */
  const applyToSlice = (key: CellKey | null) => (fn: (slice: Tab[]) => Tab[]) => {
    const slice = sliceFor(key);
    const after = fn(slice);
    if (after === slice) return;
    const patched = new Map(after.map((t) => [t.id, t] as const));
    const order = after.map((t) => t.id);
    setTabs((ts) => ts.map((t) => patched.get(t.id) ?? t));
    setSpaces((ss) => ss.map((s) => {
      if (s.id !== activeSpaceIdRef.current) return s;
      // The RENDERED layout, which is the one `sliceFor` read `slice` out of and
      // the one `key` was measured against — the same base every pane-level op
      // here uses. Writing `s.layout` instead would, the moment the memo repairs
      // anything (an un-celled member adopted, an anchor re-ranked by compact),
      // hand `setCellTabs` an order that is not a permutation of THAT layout's
      // cell; it would refuse, and `withLayout` would still rewrite `tabIds` to
      // the cells' concatenation — silently dropping the un-celled member out of
      // the space until a restart re-adopted it.
      if (key === null || !layout) return { ...s, tabIds: order };
      return withLayout(s, layout, setCellTabs(layout, key, order));
    }));
  };

  /**
   * Membership AND placement for a newly opened tab: `addTabToSpace` (which also
   * evicts the id from any other space, so exactly-one-owner survives a dedupe
   * hit on a tab another space had), then which pane it lands in, then its
   * position within that pane's strip.
   *
   * With a layout up the pane is not optional — a member with no cell is
   * unreachable, because no strip lists it — so every open path answers "which
   * pane?" by construction rather than by a rule anyone has to remember:
   * `pane` for a per-pane `+`, else the cell of the tab it was opened FROM
   * (auto-link, KAN-47), else the focused pane.
   *
   * `records` is the tab list React is about to commit rather than this render's
   * closure: the auto-link paths resolve `groupId` inside setTabs's updater,
   * because the await before them is a pty spawn — long enough for an ungroup to
   * land. `tabIds` carries no groupId, which is why the placement has to be
   * derived from records at all.
   */
  const landTab = (
    id: string,
    opts: { pane?: CellKey | null; from?: string; group?: string; records?: Tab[] } = {},
  ) => {
    addToActiveSpace(id);
    const { group, records } = opts;
    const regroup = (slice: Tab[]) =>
      group === undefined || !records ? null : addToGroup(slice, id, group).map((t) => t.id);
    setSpaces((ss) => ss.map((s) => {
      if (s.id !== activeSpaceIdRef.current) return s;
      const l = s.layout;
      if (!l) {
        const order = regroup(sliceOf(s.tabIds, records ?? []));
        return order ? { ...s, tabIds: order } : s;
      }
      const first = readingOrder(l)[0];
      if (!first) return s;
      const host = (opts.pane && cellAt(l, opts.pane) ? opts.pane : null)
        ?? keyOfTab(l, opts.from) ?? keyOfTab(l, active) ?? cellKey(first);
      const moved = moveTab(l, id, host);
      if (moved === l) return s;
      const cell = cellOf(moved, id)!;
      const order = regroup(sliceOf(cell.tabIds, records ?? []));
      return withLayout(s, l, order ? setCellTabs(moved, cellKey(cell), order) : moved);
    }));
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
      // KAN-41: provenance survives the restart. Without this, quitting and
      // reopening launders every agent-spawned worker into a session that gets
      // the spawn tool back.
      agentSpawned: t.agentSpawned,
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
  //
  // EXCEPT a tab count that DROPPED, persisted immediately like `active` is —
  // KAN-64: main's agent-session cap counts an agent-spawned tab off THIS
  // document (a restored tab has no live pty to count instead), so a close
  // that only debounced left main reading a stale, too-high count for up to
  // 400ms. Closing five tabs and immediately asking for a sixth (a real MCP
  // sequence — its own close_tab tool is exactly this) measured the cap still
  // refusing on tabs that had already been closed. A tab being ADDED does not
  // get the same treatment: every path that adds one (`openClaudeNewTab`,
  // `openShellTab`, restore) already calls `selectTab`, which the immediate
  // effect above covers.
  const prevTabCount = useRef(tabs.length);
  useEffect(() => {
    if (!restoreDone.current) return;
    const droppedBelow = tabs.length < prevTabCount.current;
    prevTabCount.current = tabs.length;
    if (droppedBelow) { persist(); return; }
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
    // Ctrl+W / File ▸ Close Tab. Through the chokepoint like everything else,
    // so an ambient keystroke cannot kill a live session or a pinned tab — and
    // a refusal here closes NOTHING, rather than falling through to a
    // consolation victim.
    else if (cmd === 'close-tab') { if (active) requestClose([active]); }
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
  // KAN-56: `pane` is the strip whose `+` was pressed, which is how a per-pane
  // `+` answers "which pane does this open into?" without a rule. Ctrl+T and
  // the File menu pass none and land in the focused pane.
  const addTab = async (pane?: CellKey | null) => {
    const home = await window.api.fsHome();
    const t = newFilesTab(home);
    setTabs((ts) => [...ts, t]); landTab(t.id, { pane }); selectTab(t.id);
  };

  // KAN-47: called from the CLI/Explorer-context-menu 'open-path' arm and from
  // the (tab-bar-global, not per-tab) Recent Menu — neither has a source tab
  // to inherit from. Stays far-right, same as today.
  const openFolderTab = (p: string) => {
    const t = newFilesTab(p);
    setTabs((ts) => [...ts, t]); landTab(t.id); selectTab(t.id);
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
      landTab(id, { group: groupId, records: next, from: sourceId });
      selectTab(id);
      return next;
    });
  };

  /**
   * The COMMITTED tab list / space list / focus, for callbacks that OUTLIVE the
   * render that created them (KAN-57).
   *
   * Every other closure in this file answers a click, so "this render's values"
   * and "now" are the same instant. A confirm dialog breaks that: it stays open
   * for as long as the user looks at it, and in that window a tab can be closed
   * by the control channel, moved to another pane or another space, pinned, or
   * have its pty exit. Acting on the closure that opened the dialog is exactly
   * the KAN-37 shape — a replacing write computed from a stale snapshot — and
   * here it would close whatever now sits at a name the user has already
   * stopped looking at.
   *
   * Written from an effect with no dependency list, so it only ever holds state
   * React has actually COMMITTED — never a value queued mid-render. During a
   * synchronous burst (the `closeNow` loop) it does not move, which is
   * precisely what the closure gave before, so nothing about the existing paths
   * changes: `remaining` still shrinks across composed updaters and KAN-44's
   * "close the focused member last" still lands on a real survivor.
   */
  const committed = useRef({ tabs, spaces, active });
  useEffect(() => { committed.current = { tabs, spaces, active }; });

  const closeTab = (id: string) => {
    const { tabs: nowTabs, spaces: nowSpaces, active: nowActive } = committed.current;
    // THE SPACE THAT OWNS THE TAB, not the one you happen to be standing in
    // (KAN-57 review). A confirm outlives the render that opened it, and Ctrl+1..9
    // is live while it is up — so "close a live terminal, switch space, click
    // Continue" used to remove the id from the WRONG space: the origin kept the
    // dead id in `tabIds`, in its layout cell and as its remembered
    // `activeTabId`, and coming back to it focused a tab that no longer existed —
    // a blank window body. Falls back to the active space only when nothing owns
    // the id, which `withoutTab`/`removeTab` then treat as the no-op it is.
    const ownerId = nowSpaces.find((s) => s.tabIds.includes(id))?.id ?? activeSpaceIdRef.current;
    const t = nowTabs.find((x) => x.id === id);
    if (t?.ptyId) window.api.ptyKill(t.ptyId);
    lastActivated.current.delete(id);
    // Route the space's layout through `removeTab` too, exactly like the "Close
    // pane" menu item — not just membership. Without this the render-time
    // `layout` memo only ever `compact`s dead cells away, which can only drop a
    // track that is empty on EVERY row/col; a hole whose track is still occupied
    // by a neighbour (an L-shaped or T-shaped tiling) stays a hole forever
    // (KAN-46 review #2). KAN-56: only the LAST tab of a pane closes the pane —
    // `removeTab` drops the id from its cell and takes the rectangle away only
    // when nothing is left in it.
    setSpaces((ss) => {
      const removed = removeTabFromSpace(ss, ownerId, id);
      if (removed === ss) return ss;
      return removed.map((s) =>
        s.id === ownerId && s.layout
          ? withLayout(s, s.layout, removeTab(s.layout, id))
          : s);
    });
    setTabs((ts) => {
      const remaining = closeTabList(ts, id);
      if (id === nowActive) {
        // Re-pick from THIS SPACE's survivors: a tab another space owns is not
        // on this strip, and focusing it would leave the window showing a pane
        // with no tab. `mine` is this render's membership — a superset as a
        // closeTabs loop shrinks it — intersected with `remaining`, which DOES
        // shrink across composed updaters, so KAN-44's "close the focused
        // member last" fix still lands on a real survivor.
        // `ownerId` rather than the active space: this arm only runs when the
        // closed tab IS the globally active one, in which case the two are the
        // same space — but there is then exactly one right answer to "which
        // strip re-picks focus", and it is the one the tab was on.
        const mine = new Set(nowSpaces.find((s) => s.id === ownerId)?.tabIds ?? []);
        const survivors = remaining.filter((x) => mine.has(x.id));
        // Plain MRU. KAN-46 needed a "prefer a survivor that HAS a pane" pass
        // here, because the old model let a space member sit in no cell at all
        // and re-picking one left the strip highlighting a tab with nothing on
        // screen. KAN-56 makes that state unrepresentable — every member is in
        // exactly one pane, and `selectTab` shows it there — so the preference
        // has nothing left to express.
        // Most-recently-activated survivor; '' only when the space is now empty.
        setActive(survivors.length
          ? survivors.reduce((a, b) =>
            (lastActivated.current.get(b.id) ?? 0) > (lastActivated.current.get(a.id) ?? 0) ? b : a).id
          : '');
      }
      return remaining;
    });
  };

  /**
   * Close these ids for real, no questions. The ONLY caller of `closeTab`.
   *
   * Re-resolves every id against the COMMITTED tab list rather than against
   * whatever was true when the caller decided — an id can name nothing by now
   * (closed from the control channel, or by the pane it lived in going away),
   * and a confirm must never act on a name that has since moved: dropping the
   * unknown ones is what makes an orphaned confirm a no-op instead of a wrong
   * close. `pinned` is re-checked here too, for the same reason SpaceMenu
   * re-checks `canDeleteSpace` inside its own modal.
   *
   * KAN-44's ordering lives here rather than in the group-close loop it used to
   * live in, because every close path now composes through this one: `closeTab`
   * re-picks focus from `remaining`, which still holds the rest of the batch,
   * so the call that sees `id === active` must be the one running against the
   * already-shrunk list — i.e. the focused member goes last.
   */
  const closeNow = (ids: readonly string[]) => {
    const byId = new Map(committed.current.tabs.map((t) => [t.id, t] as const));
    const nowActive = committed.current.active;
    const doomed = ids
      .map((i) => byId.get(i))
      .filter((t): t is Tab => t !== undefined && !t.pinned);
    [...doomed.filter((t) => t.id !== nowActive), ...doomed.filter((t) => t.id === nowActive)]
      .forEach((t) => closeTab(t.id));
  };

  /**
   * THE CHOKEPOINT. Every close anything can ask for goes through here — the
   * strip's `×`, the tab context menu, "Close group's tabs", File ▸ Close Tab /
   * Ctrl+W, and the control channel — which is what makes the two guards below
   * hold *everywhere* rather than on whichever path a ticket happened to name.
   *
   * Returns the ids it REFUSED. `[]` means the close is under way: immediately,
   * or behind a confirm the caller cannot see and must not wait for.
   *
   * Always takes a LIST. That is the whole answer to "ask once for a group":
   * one batch, one risk assessment, one modal. A single close is `[id]`, not a
   * special case.
   *
   * `mode: 'now'` skips the CONFIRM only — never the pinned refusal.
   */
  const requestClose = (ids: readonly string[], mode: 'ask' | 'now' = 'ask'): string[] => {
    const byId = new Map(committed.current.tabs.map((t) => [t.id, t] as const));
    const resolved = ids.map((i) => byId.get(i)).filter((t): t is Tab => t !== undefined);
    // PINNED MEANS UN-CLOSABLE ON EVERY ROUTE THAT CLOSES A TAB. Hiding the `×`
    // was never the guarantee it looked like: the context menu, Ctrl+W and the
    // control channel all closed a pinned tab freely. The escape is Unpin, which
    // sits one item above the (now greyed) Close in the same menu. Refused ids
    // are dropped from the batch rather than failing it, so unpinning one tab of
    // a group does not block closing the rest.
    //
    // THE ONE EXCEPTION, and it is deliberate: deleting a SPACE closes its whole
    // membership, pinned tabs included, and `onDeleteSpace` does not route
    // through here. Deleting a space is an explicit act behind its own confirm,
    // and the tool for "do not delete this" is pinning the SPACE — a tab pin
    // gates tab closes, not space deletes. The delete confirm names the pinned
    // members out loud (`deleteSpaceReason`) so the exception is stated where the
    // user is, not only in this comment.
    const refused = resolved.filter((t) => t.pinned);
    const rest = resolved.filter((t) => !t.pinned);
    const doomed = rest.map((t) => t.id);
    if (doomed.length) {
      const reason = mode === 'now' ? null : closeReason(rest.map((t) => closeRisk(t, status)));
      // The common case — files, viewers, a finished Claude tab, a dead shell —
      // is byte-for-byte what it was: one click, no modal, nothing awaited.
      if (reason === null) closeNow(doomed);
      else setPendingClose({
        reason,
        confirmLabel: doomed.length > 1 ? 'Close tabs' : 'Close tab',
        // Cancel abandons the WHOLE batch, including the members that carried
        // no risk: a half-completed group close the user just declined is a
        // worse end state than either, and re-issuing it costs one right-click.
        confirm: () => closeNow(doomed),
      });
    }
    return refused.map((t) => t.id);
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
  const reorderTabs = (key: CellKey | null) => (from: number, insert: number) => {
    const slice = sliceFor(key);
    const moved = slice[from];
    if (!moved) return;
    const next = reorderWithGroups(slice, from, insert);
    const newGroupId = next.find((t) => t.id === moved.id)?.groupId;
    setSpaces((ss) => ss.map((s) => {
      if (s.id !== activeSpaceIdRef.current) return s;
      // A pane strip's order IS its cell's `tabIds`, so the whole permutation
      // goes straight through `setCellTabs` — which refuses anything that is
      // not one, so a reorder can never add or lose a tab. Against the RENDERED
      // layout, for the reason spelled out in `applyToSlice`: `slice` came from
      // it, so `next` is a permutation of ITS cell, not necessarily of the raw
      // one's.
      if (key !== null && layout)
        return withLayout(s, layout, setCellTabs(layout, key, next.map((t) => t.id)));
      // Where the tab ACTUALLY landed, not where the drag asked it to: KAN-53
      // makes reorderWithGroups clamp `insert` into the dragged tab's own region
      // (pinned tabs are held left of every unpinned one), and reorderInSpace
      // holds ids only, so it cannot re-derive that. Reading the landing index
      // back off the result keeps the two in step by construction rather than by
      // two clamp formulas being kept identical.
      const landed = next.findIndex((t) => t.id === moved.id);
      return reorderInSpace([s], s.id, from, landed)[0];
    }));
    if (newGroupId === moved.groupId) return;
    // Only the tag changes in the store; the position lives in the strip order.
    setTabs((ts) => ts.map((t) => (t.id === moved.id ? next.find((x) => x.id === moved.id)! : t)));
    if (newGroupId !== undefined) expand(newGroupId);
  };

  // Drag-by-head (KAN-52). `applyToSlice` already does exactly the right thing:
  // moveGroupRun is a permutation of the slice that changes no record, so only
  // the space's `tabIds` actually moves. Nothing to expand — a collapsed run
  // drags as the one thing it looks like.
  // KAN-56: a group chip drags within its OWN strip only.
  // ponytail: dragging a whole group run BETWEEN panes is not offered — drag its
  // tabs individually; add it when someone with a 6-tab group in the wrong pane
  // complains.
  const reorderGroup = (key: CellKey | null) => (groupId: string, insert: number) =>
    applyToSlice(key)((sl) => moveGroupRun(sl, groupId, insert));

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
  const groupActionsFor = (key: CellKey | null): GroupActions => ({
    create: (tabId) => {
      const g = newGroup('Group', groups);
      setGroups([...groups, g]);
      applyToSlice(key)((sl) => addToGroup(sl, tabId, g.id));
    },
    add: (tabId, groupId) => applyToSlice(key)((sl) => addToGroup(sl, tabId, groupId)),
    remove: (tabId) => applyToSlice(key)((sl) => removeFromGroup(sl, tabId)),
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
      // ONE call, not a loop of them — which is the whole of how a group close
      // asks ONCE: `requestClose` assesses the batch and raises at most one
      // modal for it. The KAN-44 "close the focused member last" ordering moved
      // into `closeNow` with the rest of the close mechanics.
      //
      // Scoped to THIS strip's slice because the chip you right-clicked is the
      // one you closed: a group that also has members in another pane keeps
      // those. NOT because `closeTab` needs it to be — it resolves the owning
      // space itself since the KAN-57 review, and handing it a tab from another
      // space is space-exact rather than corrupting. A pinned tab can never be
      // in this batch (`setPinned` strips `groupId`), so nothing here can be
      // refused.
      requestClose(sliceFor(key).filter((t) => t.groupId === groupId).map((t) => t.id));
    },
  });

  /**
   * Pin / unpin (KAN-53). Same shape as the three group membership ops and for
   * the same reason: pinning MOVES the tab (to the seam between the pinned and
   * unpinned regions), and the strip is the active space's slice — so the new
   * order has to go back into that space's `tabIds`, not just the tab record.
   * `setPinned` also drops the groupId, which `applyToSlice` writes through
   * because it replaces whole records.
   */
  // KAN-56: per PANE, the same way Chrome pins per window — a pinned tab is held
  // left of every unpinned one in the strip it is actually drawn in.
  const togglePin = (key: CellKey | null) => (id: string) =>
    applyToSlice(key)((sl) => setPinned(sl, id, !sl.find((t) => t.id === id)?.pinned));

  // A new conversation gets its id assigned here rather than discovered later:
  // reading back "whichever jsonl appeared in this folder" cannot tell two tabs
  // on the same repo apart, and getting that wrong would resume the wrong
  // conversation. Resuming an existing one keeps its id, since that is the
  // transcript it goes on writing to.
  // KAN-41: `agentSpawned` is passed straight down to main, which reads it as
  // "this child gets no MCP config and no token". It is set on exactly ONE call
  // path — the control channel's openClaudeSession arm — and on the respawn of a
  // restored tab that carried it.
  const claudeSpawn = async (cwd: string, resumeId?: string, agentSpawned?: true) => {
    await window.api.recentsAdd(cwd);
    const sessionId = resumeId ?? crypto.randomUUID();
    const ptyId = await window.api.ptySpawn({
      path: cwd, resumeId, sessionId: resumeId ? undefined : sessionId, agentSpawned,
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
  const openClaudeNewTab = async (cwd: string, resumeId?: string, agentSpawned?: true) => {
    const { ptyId, sessionId } = await claudeSpawn(cwd, resumeId, agentSpawned);
    const t = newTerminalTab(cwd, 'claude', ptyId, basename(cwd), sessionId, agentSpawned);
    setTabs((ts) => [...ts, t]); landTab(t.id); selectTab(t.id);
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
      landTab(t.id, { group: groupId, records: next, from: sourceId });
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

  // --- KAN-39 control channel ----------------------------------------------
  //
  // Main asks, this answers, exactly once per request id. FOUR ops and no
  // others; why `openClaudeSession` — the one op here that spawns — may not
  // ride `menu:command` is recorded next to the channel constants in
  // src/shared/ipc.ts and above `applyCli` here: menu:command is reachable from
  // argv via sendPendingCli, and this channel is not reachable from anything.
  //
  // WHY A QUEUE RATHER THAN A PLAIN HANDLER. Requests arrive back-to-back with
  // NO React commit between them. An op that answered from its enclosing
  // closure would read the tab list as it was before the op in front of it —
  // the same staleness KAN-37 fixed for the writers, except a functional
  // updater cannot fix it here, because the answer has to leave the process and
  // `setTabs` is not a way to return a value. So requests are queued and
  // drained ONE PER COMMIT: the drain lives in an effect, React runs the newest
  // render's copy of that effect, and it re-arms itself only after its op has
  // settled. Five closeTabs in a row therefore each see one fewer tab, and a
  // listTabs issued straight after an open sees the tab that open created —
  // with no sleep anywhere, because the commit boundary IS the wait.
  const controlQueue = useRef<ControlRequest[]>([]);
  const controlBusy = useRef(false);
  const [controlTick, setControlTick] = useState(0);

  // Mount-once, same as onMenuCommand/onMenuSession. No ref-to-latest-closure
  // needed on THIS half: it only enqueues, and the executor below is what has
  // to be current — which the drain effect gets for free.
  useEffect(() => window.api.onControlRequest((req) => {
    controlQueue.current.push(req);
    setControlTick((n) => n + 1); // the drain is an effect, so it needs a commit
  }), []);

  /**
   * The ops switch. Throwing IS the error path — the drain turns any rejection
   * into an `{ ok: false, error }` reply, so nothing escapes as an unhandled
   * throw and no op ever fails silently.
   */
  const runControl = async (req: ControlRequest): Promise<ControlResult> => {
    // main stopped waiting for this one, so starting it now is work nobody is
    // listening for — and if the caller retried on that timeout, work done
    // TWICE (two Claude processes on one folder). The queue is exactly where
    // that happens: a request sat behind a slow op runs when it reaches the
    // front, long after main rejected it. Both processes read the same system
    // clock, so this is a direct comparison. What it CANNOT cover is the op
    // that was already executing when the timeout fired — see ControlOp.
    if (Date.now() > req.deadline) throw new Error('control: expired');
    // Before restore commits, the restore effect ends in a REPLACING
    // setTabs(restored) that would wipe a tab opened here — the race pendingCli
    // and pendingSession queue around. Answered rather than queued: main times a
    // request out in 15s, so an honest error a caller can retry beats a reply
    // that may never arrive.
    //
    // listTabs is gated too, though nothing it does can be wiped: `tabs` is []
    // until that setTabs(restored) lands, and [] is indistinguishable from "no
    // tabs open". A caller 200ms after launch would be told the window is empty
    // while four tabs are about to appear, and nothing in the reply lets it
    // know to ask again. An error says exactly that, and `restoreDone` flips in
    // the same synchronous block as setTabs(restored), so any drain that gets
    // past here runs after a commit that includes the restored list.
    if (!restoreDone.current) throw new Error('control: not ready');
    switch (req.op) {
      case 'listTabs':
        // The whole store, every space: `tabs` IS the live tab list and a
        // ControlTab names no space. Store order, i.e. the order tabs opened in.
        return tabs.map((t) => toControlTab(t, status));
      case 'closeTab': {
        const { tabId } = req.args;
        if (!tabs.some((t) => t.id === tabId)) throw new Error(`control: unknown tab ${tabId}`);
        // Closing a tab a BACKGROUND space owns is space-exact: `closeTab`
        // resolves the owner off `committed.current.spaces` rather than off
        // whichever space is active. It did not used to, and the dead id it left
        // in the background space's `tabIds` / layout cell / `activeTabId` was
        // written off as untidy-but-harmless — until KAN-57's confirm (with
        // KAN-59's Ctrl+1..9, live over a terminal AND over the modal's Cancel
        // button) gave a human a way to reach the same state, where it renders
        // as a blank window body. See `closeTab`.
        //
        // 'now': THE CONTROL CHANNEL DOES NOT CONFIRM, deliberately. There is
        // no human on it — main gives up after 15s, so a modal nobody answers
        // turns every agent `closeTab` into the one error ControlOp's own doc
        // says must never be auto-retried. A caller that named a tab id by hand
        // has already been explicit; the modal exists to catch the misclick,
        // and there is no click.
        // ponytail: if KAN-40 ever exposes closeTab as an MCP tool the caller
        // becomes a fallible model, and the op then wants `args.force?: boolean`
        // (refuse a live tab, opt in) rather than a modal. Today mcp.ts exposes
        // listTabs only — do not add it before then.
        //
        // The pinned refusal is NOT skipped, and it is reported rather than
        // swallowed: the drain turns this throw into the channel's existing
        // typed `{ ok: false, error }` shape, exactly like the unknown-tab
        // refusal above.
        if (requestClose([tabId], 'now').length)
          throw new Error(`control: tab ${tabId} is pinned`);
        return null;
      }
      case 'openViewerTab':
        // Sourceless, exactly like applyCli's 'open-file' arm: a control caller
        // is not a tab, so there is no group to inherit and it appends far
        // right. Awaited so the tab exists before the reply goes out.
        await openViewerTab(req.args.filePath, req.args.mode ?? 'file');
        return null;
      case 'openClaudeSession':
        // KAN-41: `true` unconditionally, and it is NOT a field on ControlOp.
        // ARRIVING ON THIS CHANNEL is what makes a session agent-spawned, which
        // is strictly stronger than a wire flag — there is no field for a future
        // caller, or a forged IPC message, to set to false. Main withholds the
        // MCP config and token from the child, so the tool cannot hand itself
        // down a generation.
        await openClaudeNewTab(req.args.cwd, req.args.resumeId, true);
        return null;
      default:
        // Unreachable through the type, reachable across an IPC boundary.
        throw new Error(`control: unknown op ${(req as { op: string }).op}`);
    }
  };

  useEffect(() => {
    if (controlBusy.current || !controlQueue.current.length) return;
    const req = controlQueue.current.shift()!;
    controlBusy.current = true;
    // Two-arg `then`, not `.then().catch()`: the catch arm of a chain also sees
    // a throw from the SUCCESS arm, which would put a second reply on the wire
    // for one request id. These two are mutually exclusive by construction.
    runControl(req).then(
      (result) => window.api.controlReply({ id: req.id, ok: true, result }),
      (e: unknown) => window.api.controlReply({
        id: req.id, ok: false, error: e instanceof Error ? e.message : String(e),
      }),
    )
      // Re-armed unconditionally, not just when something is queued: this bump
      // and the op's own state writes land in ONE commit, so the next drain
      // runs against them. An empty queue returns at the top, so the chain ends
      // after a single spare render rather than spinning.
      .finally(() => { controlBusy.current = false; setControlTick((n) => n + 1); });
  }, [controlTick]);

  // --- KAN-41 agent spawn confirmation -------------------------------------
  //
  // Deliberately NOT on the control queue above: that queue is one op per
  // commit with a 15s deadline, and a modal waiting on a human is neither. It
  // would also block every listTabs behind it — a UI deadlock reachable from a
  // tool call. See the CH.spawnConfirm comment in src/shared/ipc.ts.
  //
  // Mount-once, like onControlRequest: this only sets state, and setSpawnAsk is
  // stable. `restoreDone` does NOT gate it — the prompt renders nothing that
  // depends on the tab store, and refusing to ask during restore would silently
  // turn into a denial the user never saw.
  useEffect(() => window.api.onSpawnConfirm(setSpawnAsk), []);

  // Clearing and answering are one step, so no path can leave a dead prompt on
  // screen: a token is answerable exactly once, and main drops an answer for a
  // token it no longer holds. Expiry inside SpawnConfirm comes through here too
  // — main has already forgotten the token by then and the send is a no-op.
  const answerSpawn = (allow: boolean) => {
    if (!spawnAsk) return;
    window.api.spawnConfirmAnswer(spawnAsk.token, allow);
    setSpawnAsk(null);
  };

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

  // --- moving a tab / a group to another space (KAN-66) ---------------------
  //
  // `addTabToSpace` IS the move primitive and has been since KAN-45: it evicts
  // the id from every OTHER space before appending, which is the only reason the
  // exactly-one-owner invariant survives (spaces.ts). So there is no second
  // primitive here, and in particular NO `removeTabFromSpace` call — doing both
  // would revoke membership twice and, on any path where the add is refused,
  // leave the tab owned by nobody: unreachable, with a live pty nothing can
  // close.
  //
  // The DESTINATION needs no GRID placement step. A member with no `GridCell` is
  // a legal (not broken) state, and the `layout` memo above adopts one into the
  // focused pane the moment that space is rendered — its comment names "moved to
  // another space" as the case it exists for, and `migrateLayout` does the same
  // repair on the persisted copy.
  //
  // It does need an ORDER step, for a PINNED tab only. `addTabToSpace` appends,
  // which is right for the ordinary tab it was written for and wrong for a
  // pinned one: the strip holds every pinned tab left of every unpinned one
  // (`normalize`, shared/groups.ts), so appending draws it at the far RIGHT —
  // and then `sanitize()`, which normalizes on write as well as on read, hoists
  // it to the front on disk, so the tab silently jumps to the other end of the
  // strip on the next launch. Slid to the seam here with the same
  // `reorderInSpace` the drag uses. Not a second normalizer (spaces.ts is
  // explicit that repair lives in `sanitize()` and nowhere else): this is the
  // caller placing its own insert, exactly as `setPinned` does for a pin.
  //
  // The SOURCE does. `addTabToSpace` only touches `tabIds`, so a split source
  // space is left with a `GridCell` naming a tab it no longer owns. `closeTab`
  // carries this exact obligation and this mirrors it: the render-time `compact`
  // hides the hole while you are looking at that space, but the layout WRITTEN
  // to disk still has the dead cell, and a hole whose track a neighbour still
  // occupies never compacts away — so it comes back on restart (KAN-46 #2).
  const spacesAfterMove = (ss: Space[], spaceId: string, ids: readonly string[]): Space[] => {
    const isPinned = new Set(committed.current.tabs.filter((t) => t.pinned).map((t) => t.id));
    return ids.reduce((acc, id) => {
      const ownerId = acc.find((s) => s.tabIds.includes(id))?.id;
      const added = addTabToSpace(acc, spaceId, id);
      if (added === acc) return acc; // unknown space, or already a member
      const dest = added.find((s) => s.id === spaceId)!;
      const next = isPinned.has(id)
        ? reorderInSpace(added, spaceId, dest.tabIds.length - 1,
            dest.tabIds.filter((x) => x !== id && isPinned.has(x)).length)
        : added;
      return next.map((s) => {
        if (s.id !== ownerId || !s.layout) return s;
        const vacated = removeTab(s.layout, id);
        // Same reference when the tab had no cell: rewriting `tabIds` from the
        // cells then would drop any OTHER un-celled member out of the space.
        return vacated === s.layout ? s : withLayout(s, s.layout, vacated);
      });
    }, ss);
  };

  /**
   * Move `ids`, in order, into `spaceId`. The one place either route lands.
   *
   * Resolved against the COMMITTED state, not this render's closure: the confirm
   * below outlives the render that opened it, and Ctrl+1..9 is live while it is
   * up — the same hazard `closeTab` documents.
   *
   * `ungroup` strips the groupId, and is true for exactly one case: a grouped
   * tab moving ON ITS OWN (see `moveTabReason`). A whole group keeps its
   * members' tags, because `Workspace.groups` is a flat registry — the run just
   * reappears in the destination strip and `normalize()` closes it up there.
   *
   * The user is NOT taken to the destination. They are still looking at the
   * space they moved the tab out of; only `active` re-picks, and only when the
   * tab that left was the one with focus, exactly as a close does.
   */
  const moveToSpace = (ids: readonly string[], spaceId: string, ungroup: boolean) => {
    const { spaces: nowSpaces, active: nowActive } = committed.current;
    if (!ids.length || !nowSpaces.some((s) => s.id === spaceId)) return;
    const ownerId = nowSpaces.find((s) => ids.some((id) => s.tabIds.includes(id)))?.id;
    if (!ownerId || ownerId === spaceId) return;
    if (ungroup)
      setTabs((ts) => ts.map((t) => {
        if (!ids.includes(t.id) || t.groupId === undefined) return t;
        const { groupId: _drop, ...rest } = t;
        return rest;
      }));
    setSpaces((ss) => spacesAfterMove(ss, spaceId, ids));
    // Re-run against the committed list for the focus decision only — the
    // `onDeleteSpace` idiom: the write above is the functional one, this is a
    // synchronous side effect that depends on nothing else being queued.
    if (ids.includes(nowActive) && ownerId === activeSpaceIdRef.current)
      setActive(focusOf(spacesAfterMove(nowSpaces, spaceId, ids).find((s) => s.id === ownerId)));
  };

  const moveTabToSpace = (tabId: string, spaceId: string) => {
    const { tabs: nowTabs, spaces: nowSpaces } = committed.current;
    const t = nowTabs.find((x) => x.id === tabId);
    // A tab already in that space is not a move, so there is nothing to ask
    // about. `moveToSpace` declines the same case, but it does so BELOW the
    // confirm — so without this guard a grouped tab raises a dialog naming a
    // consequence, the user accepts it, and nothing whatsoever happens. The menu
    // route cannot reach it (the submenu filters the owning space out); the DROP
    // route can, and the owning space's own row is the one nearest the pointer
    // when the switcher springs open under the drag.
    if (!t || nowSpaces.find((s) => s.tabIds.includes(tabId))?.id === spaceId) return;
    const reason = moveTabReason(t.groupId !== undefined);
    // null means do not prompt AT ALL — the ungrouped tab, the pinned tab and
    // the whole-group move all move on one click, with no modal.
    if (reason === null) { moveToSpace([tabId], spaceId, false); return; }
    setPendingMove({ reason, confirmLabel: 'Move tab', confirm: () => moveToSpace([tabId], spaceId, true) });
  };

  const moveGroupToSpace = (groupId: string, spaceId: string) => {
    const { tabs: nowTabs, spaces: nowSpaces } = committed.current;
    const byId = new Map(nowTabs.map((t) => [t.id, t] as const));
    // In the OWNING space's order, so the run arrives the way it read. A group
    // lives in exactly one space (TabBar's "Add to …" filter is what keeps it
    // that way), so this is also every member there is.
    const owner = nowSpaces.find((s) => s.tabIds.some((id) => byId.get(id)?.groupId === groupId));
    if (!owner) return;
    moveToSpace(owner.tabIds.filter((id) => byId.get(id)?.groupId === groupId), spaceId, false);
  };

  // Ctrl+1..9 selects the nth UNPINNED space; Ctrl+Shift+1..9 the nth PINNED
  // one (KAN-82). Both group-relative, matching the accelerator labels
  // SpaceMenu renders via `acceleratorLabel` — "Ctrl+3" is always the 3rd
  // unpinned space, never the 3rd space overall, so a pinned space sliding in
  // ahead of it in the dropdown never changes what the digit means.
  //
  // KAN-59: this used to be gated by `isTypingTarget`, which made it dead
  // whenever a terminal had focus — xterm's focus sink is a hidden
  // `.xterm-helper-textarea`, so the guard declined every press.
  //
  // The fix is `isTextBox` — the predicate that already means "one of the app's
  // OWN text boxes, and not a terminal" (see keys.ts; the grid picker below has
  // used it for exactly this distinction since KAN-56). Not a widened
  // `isTypingTarget`: that one is tag-based on purpose, and an xterm exception
  // by class name is a list to forget to update. The address bar / search box /
  // rename inputs keep declining these shortcuts exactly as before — a rename in
  // flight when the space changes out from under it is a state nobody asked for
  // — while a terminal, which is a <textarea> and not one of ours, no longer
  // does.
  //
  // The other half of the fix is in Terminal.tsx, and BOTH are needed — measured
  // by breaking each one on its own (test/harness/paste.mjs §11 catches either,
  // for the unpinned digits it already covered before KAN-82).
  // xterm registers its keydown listener on that textarea, i.e. at the TARGET
  // phase, strictly before this bubble-phase window listener, and for the six
  // digits that produce a control code it finishes in `cancel(event, true)` —
  // preventDefault AND stopPropagation. So relaxing this guard alone does NOT
  // give "the space switches and the pty also gets ESC": for Ctrl+3..8 the event
  // never arrives here and nothing switches at all. Terminal.tsx's arm returns
  // false before that cancel, which both withholds the byte and lets the press
  // through to us; this half performs the switch, because only App knows how
  // many spaces exist IN EACH GROUP.
  //
  // KAN-83: `keybinds.switchUnpinned`/`.switchPinned` are now passed in rather
  // than hardcoded, and are therefore in the dependency array — cheap here
  // (just re-attaching a window listener, not recreating an xterm instance
  // the way Terminal.tsx's equivalent would be) so a rebind takes effect on
  // the very next keystroke with no restart.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const unpinned = spaceIndex(e, keybinds.switchUnpinned);
      const pinned = unpinned === null ? pinnedSpaceIndex(e, keybinds.switchPinned) : null;
      if (unpinned === null && pinned === null) return;
      if (isTextBox(e.target)) return; // our own inputs only; a terminal is not one
      const pool = pinned !== null ? spaces.filter((s) => s.pinned) : spaces.filter((s) => !s.pinned);
      const target = pool[pinned !== null ? pinned : unpinned!];
      if (!target) return; // fewer than n spaces IN THAT GROUP: leave the key alone
      e.preventDefault();
      switchToSpace(target.id);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [spaces, activeSpaceId, keybinds]);

  // Ctrl+Tab / Ctrl+Shift+Tab cycle to the next/previous space in DISPLAY
  // order (KAN-82) — the same pinned-run-then-unpinned-run order
  // `orderSpaces` gives SpaceMenu's dropdown, so "next" here always matches
  // "next" visually. Wraps at both ends, matching the alt-tab feel the ticket
  // describes.
  //
  // NOT Ctrl+Left/Right: those are word-jump inside Claude Code's own input,
  // and claiming them globally the way Ctrl+1..9 is claimed would permanently
  // break word-by-word cursor movement in every terminal tab. Tab has no such
  // conflict in a shell or in Claude Code.
  //
  // Same two-halves shape as the digit shortcuts above (KAN-59), with the same
  // `isTextBox` guard — but this ALSO calls preventDefault unconditionally
  // (not only once a target is found): Tab's browser default is a focus move,
  // and with zero or one space there is nothing to switch to but still a
  // press to keep off the pty and off the DOM's own focus order. See
  // Terminal.tsx's arm and keys.ts's `spaceCycle` doc for why this one, unlike
  // the digits, cannot leave preventDefault to "only when something changes".
  // KAN-83: `keybinds.cycleNext`/`.cyclePrev`, same reasoning as the digit
  // effect above.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const dir = spaceCycle(e, keybinds.cycleNext, keybinds.cyclePrev);
      if (dir === null) return;
      if (isTextBox(e.target)) return;
      e.preventDefault();
      const ordered = orderSpaces(spaces);
      if (ordered.length === 0) return;
      const from = ordered.findIndex((s) => s.id === activeSpaceId);
      const next = ordered[((from === -1 ? 0 : from) + dir + ordered.length) % ordered.length];
      switchToSpace(next.id);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [spaces, activeSpaceId, keybinds]);

  /**
   * Everything a `.pane` element needs. The click-to-focus handler is split-only:
   * with one pane there is nothing to disambiguate, and attaching a `selectTab`
   * to the whole content area would make a click on a file row a state write it
   * is not today.
   *
   * Capture phase, deliberately: xterm stops propagation on its own container,
   * so a bubbling handler never sees a click inside a terminal — exactly the
   * pane you most need to be able to focus by clicking it.
   *
   * KAN-56: the focus RING moved to the cell's `.paneslot`, which covers the
   * strip as well as the body — the thing that has focus is the pane, and a ring
   * that stopped at the strip's bottom edge would say otherwise.
   */
  const paneProps = (t: Tab) => ({
    className: 'pane',
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
   * THE ONLY PLACE A LAYOUT IS WRITTEN (KAN-56), which is what lets three rules
   * live in one place instead of at every call site:
   *
   * 1. FRACTIONS describe TRACKS, not panes, so they survive an operation
   *    exactly when that axis's track count survives it — which is also
   *    `normalizeFractions`'s own fallback condition, so the two can never
   *    disagree. Cleared per AXIS, not per operation: a column split has no
   *    opinion about row heights. Never keep an array whose length disagrees
   *    with the count, or it resurrects later when the count wanders back.
   * 2. `Space.tabIds` is kept EQUAL to the cells' `tabIds` concatenated in
   *    reading order, so there is exactly one order truth while a layout is up
   *    and collapsing back to `layout: null` costs nothing.
   * 3. FEWER THAN TWO CELLS IS NOT A SPLIT. Collapsing it here rather than
   *    tolerating it is what keeps `layout: null` the single spelling of
   *    "classic tabs" — and it is how the Ctrl+Shift+G 1x1 pick, and closing
   *    the second-to-last pane, get back there with every tab preserved.
   *
   * A `next` of `null` (an op that reports "no split any more") leaves `tabIds`
   * alone: it was already the reading-order concatenation, so the recovered
   * single strip reads exactly like the panes did.
   */
  const withLayout = (s: Space, prev: GridLayout | null, next: GridLayout | null): Space => {
    const grid = next && next.cells.length >= 2 ? next : null;
    return {
      ...s,
      tabIds: next ? layoutTabIds(next) : s.tabIds,
      layout: grid,
      colFractions: prev && grid && grid.cols === prev.cols ? s.colFractions : undefined,
      rowFractions: prev && grid && grid.rows === prev.rows ? s.rowFractions : undefined,
    };
  };

  /**
   * Move `tabId` out of its pane into a NEW one on `side` of it.
   *
   * With no layout yet the one pane is the whole content area holding every tab
   * of the space, which is precisely what `single()` spells — so the first split
   * is cut out of that rather than being a special case. `splitCell` refuses
   * when `tabId` is the sole tab of the pane being cut (that would empty it),
   * and the strip only offers the menu item when it has two or more tabs, so the
   * two agree.
   *
   * Bases off the RENDERED `layout` memo, not `s.layout` — a layout whose cells
   * all belonged to since-closed tabs is a corpse, and `layout` has already had
   * exactly that case pruned to `null`, which is what lets the `single()`
   * fallback fire.
   */
  const splitPane = (tabId: string, side: Side) => {
    mapActiveSpace((s) => {
      const base = layout ?? single(s.tabIds, active);
      const host = keyOfTab(base, tabId);
      if (!host) return s;
      const next = splitCell(base, host, tabId, side);
      if (next === base) return s;
      return withLayout(s, layout, next);
    });
    selectTab(tabId); // queued after the split, so `showTab` finds it and no-ops
  };

  /**
   * Close a PANE without closing its tabs: they merge, in order, into the
   * neighbour that absorbs its rectangle. Closing the second-to-last pane
   * restores `layout: null`, whose implicit single pane holds everything.
   */
  const closePane = (key: CellKey) => {
    if (!layout) return;
    const next = closeCell(layout, key);
    if (next === layout) return;
    mapActiveSpace((s) => withLayout(s, layout, next));
    // The focused tab has just moved into another pane and may not be the tab
    // that pane was showing. Queued after the write, so it acts on the merged
    // layout; a no-op when focus was elsewhere.
    if (active) selectTab(active);
  };

  // --- direct manipulation (KAN-56) ----------------------------------------
  //
  // Two gestures, one hit-test. Dragging a tab off a STRIP into the pane area
  // and dragging a PANE (by its strip's background, or Alt + its body) both
  // resolve a zone through `dropZone`, and then land through DIFFERENT model
  // calls — because a tab and a pane are now different things. An edge quarter
  // splits the pane under the pointer / moves a pane beside it, a centre joins
  // that pane's tab set / swaps the two panes, a divider inserts a full-run
  // track. A strip is a real element with its own handlers, so it never reaches
  // here at all: it wins over the edge quarter beneath it by hit-testing, not
  // by a priority rule.
  //
  // Nothing here re-parents a pane. Every operation is a pure
  // GridLayout -> GridLayout transform, so `gridPlacement` still emits styles
  // for the flat, always-mounted list `.content` has always held — which is
  // KAN-23 made structural, not a rule anyone has to remember (see the render
  // comments below).

  const paneEl = (tabId: string) =>
    contentRef.current?.querySelector<HTMLElement>(`[data-pane="${CSS.escape(tabId)}"]`) ?? null;

  /** A cell's `.paneslot` — the strip's holder, and what the focus ring and the
   *  drag lift are applied to (it covers strip + body, which is the pane). */
  const slotEl = (key: CellKey) =>
    contentRef.current?.querySelector<HTMLElement>(`[data-cell="${CSS.escape(key)}"]`) ?? null;

  /**
   * Freeze the rectangles CSS Grid produced, container-relative — the
   * coordinate space `dropZone` and the indicator both speak.
   *
   * ONCE per drag, not per move: nothing can resize a pane while one is in
   * flight, and re-measuring 60x/second is exactly the cost this path exists to
   * avoid.
   *
   * The rect measured per cell is its ACTIVE TAB's `.pane`, which is the pane
   * BODY — `gridPlacement` gives it `top: STRIP_PX`, so the strip is already
   * excluded and the edge quarters are computed over what the user sees as the
   * pane. `lone` (the dragged tab is the only one in its pane) suppresses the
   * seam zones, because taking it out removes the pane, and that compacts and
   * re-ranks the very track indices a seam is identified by — offering a zone
   * the model will reject is worse than not offering it at all.
   */
  const measureDrop = (lone: boolean) => {
    const node = contentRef.current;
    if (!node) return null;
    const origin = node.getBoundingClientRect();
    const rel = (r: DOMRect): Box =>
      ({ left: r.left - origin.left, top: r.top - origin.top, width: r.width, height: r.height });
    // With no split there is exactly one pane — the active tab's, filling the
    // whole content box, which is the `single()` layout's only cell. That is the
    // case the first-split gesture starts from, which is why this is not gated
    // on `placement.split`.
    const cells: [CellKey, string][] = placement.split
      ? placement.cells.map((c) => [cellKey(c), c.activeTabId] as [CellKey, string])
      : active ? [['0,0', active]] : [];
    const panes: PaneBox[] = [];
    for (const [cell, tabId] of cells) {
      const el = paneEl(tabId);
      if (el) panes.push({ cell, ...rel(el.getBoundingClientRect()) });
    }
    const seams: SeamBox[] = [];
    if (!lone)
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
    for (const n of node?.querySelectorAll('.pane-dragging') ?? []) n.classList.remove('pane-dragging');
    endDrop();
  };

  /**
   * Land a dragged TAB in zone `z`.
   *
   * ORDERING RULE: the layout is written first and `selectTab` second, or
   * `selectTab`'s own `showTab` runs against the pane the tab has not moved into
   * yet. And focus only moves when the layout really changed, because a refused
   * drop must not have a side effect either.
   */
  const applyTabDrop = (tabId: string, z: DropZone) => {
    if (!tabId || z.kind === 'none') return;
    // A centre drop with no grid up is just "show this tab" — every tab is
    // already in the one pane. Materialising a 1x1 layout would turn `.content`
    // into a grid for nothing visible.
    if (z.kind === 'centre' && !layout) { selectTab(tabId); return; }
    // An EDGE drop with no grid is the headline gesture — it is what creates the
    // first split — so that one starts from the implicit single pane.
    const base = layout ?? (z.kind === 'edge' ? single(activeSpace?.tabIds ?? [], active) : null);
    if (!base) return;
    const next =
      z.kind === 'centre' ? moveTab(base, tabId, z.cell)
        : z.kind === 'edge' ? splitCell(base, z.cell, tabId, z.side)
          : insertAtSeam(base, tabId, z.axis, z.index, z.start, z.end);
    if (next === base) return; // refused
    mapActiveSpace((s) => withLayout(s, layout, next));
    selectTab(tabId);
  };

  /**
   * Land a dragged PANE in zone `z` — the whole window, tab set intact.
   *
   * A centre drop SWAPS the two panes' rectangles and an edge drop moves this
   * one beside the target, both of which leave every track count alone, so both
   * axes' dragged fractions survive. Seams are never offered for a pane drag
   * (`measureDrop(true)`): there is no meaning to inserting a track for a pane
   * that already has one.
   */
  /**
   * A tab dropped on ANOTHER pane's strip: it joins that pane's set at the
   * pointer's insert index. `moveTab` takes it out of whichever pane held it,
   * and removes that pane if it was the last tab in it.
   */
  const adoptInto = (key: CellKey) => (tabId: string, insert: number) => {
    if (!layout) return;
    const next = moveTab(layout, tabId, key, insert);
    if (next === layout) return;
    mapActiveSpace((s) => withLayout(s, layout, next));
    selectTab(tabId);
  };

  const applyPaneDrop = (key: CellKey, z: DropZone) => {
    if (!layout) return;
    const next =
      z.kind === 'centre' ? swapCells(layout, key, z.cell)
        : z.kind === 'edge' ? moveCellBeside(layout, key, z.cell, z.side)
          : layout;
    if (next === layout) return;
    mapActiveSpace((s) => withLayout(s, layout, next));
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
  //
  // KAN-56: a pane STRIP is a real element with its own drop handling, so a drag
  // over one is left alone entirely — that is how "the strip beats the edge
  // quarter underneath it" is enforced, by hit-testing rather than by a priority
  // rule this function would have to encode. The indicator is cleared on the way
  // in so a zone painted a pixel earlier does not sit there while the pointer is
  // over a strip.
  const onStrip = (e: React.DragEvent<HTMLDivElement>) =>
    !!(e.target as Element).closest?.('[data-panestrip]');

  const contentDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes(TAB_MIME)) return;
    if (onStrip(e)) { endDrop(); return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const g = dropGeom.current ?? measureDrop(e.dataTransfer.types.includes(LONE_MIME));
    if (g) paint(zoneAt(g, e.clientX, e.clientY));
  };

  const contentDrop = (e: React.DragEvent<HTMLDivElement>) => {
    const g = dropGeom.current;
    if (!e.dataTransfer.types.includes(TAB_MIME) || !g || onStrip(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const z = zoneAt(g, e.clientX, e.clientY);
    endDrop();
    applyTabDrop(e.dataTransfer.getData(TAB_MIME), z);
  };

  /**
   * PRIMARY entry: a press on a pane strip's own background (KAN-56).
   *
   * A pane has a title bar now, and dragging a window by its title bar is the
   * idiom this whole feature emulates. It conflicts with nothing — the strip is
   * chrome over neither an xterm nor a file list, `.tabbar` is already
   * `user-select: none`, and TabBar excludes tabs/chips/buttons before calling
   * this, so the tab drag (which is HTML5 DnD on a `draggable` element) and this
   * (pointer events) can never both start.
   *
   * Pointer events rather than DnD deliberately: the DOM stays readable mid-drag
   * (the harness depends on that) and there is no `dataTransfer` to contend
   * with. Capture is taken on `.content` so the moves and the up land on the
   * handlers below wherever the pointer goes, exactly as SplitDividers does on
   * its 9px handles.
   */
  const onStripGrab = (key: CellKey) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (!placement.split) return;
    e.preventDefault();
    paneDrag.current = { key, x: e.clientX, y: e.clientY, moved: false, pointerId: e.pointerId };
    contentRef.current?.setPointerCapture(e.pointerId);
  };

  /**
   * SECOND entry: Alt + primary drag on a pane BODY — the only way to grab a
   * pane whose strip is scrolled or covered.
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
    if (!placement.split || !e.altKey || e.button !== 0 || !layout) return;
    const el = e.target as Element;
    if (el.closest?.('[data-panestrip]')) return; // the strip's own grab handles it
    const tabId = el.closest?.('[data-pane]')?.getAttribute('data-pane');
    const key = tabId ? keyOfTab(layout, tabId) : null;
    if (!key) return;
    e.preventDefault();
    e.stopPropagation();
    paneDrag.current = { key, x: e.clientX, y: e.clientY, moved: false, pointerId: e.pointerId };
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
      // the divider handles. The slot is what lifts, so the strip lifts with the
      // body — the pane is one window, not a body with a hat.
      slotEl(g.key)?.classList.add('pane-dragging');
      const shown = layout && cellAt(layout, g.key)?.activeTabId;
      if (shown) paneEl(shown)?.classList.add('pane-dragging');
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
    // Below the threshold this was a click, and a click on a pane (or on its
    // strip's background) is the focus move `paneProps` would have made had the
    // capture handler not swallowed it.
    if (!g.moved) {
      const shown = layout && cellAt(layout, g.key)?.activeTabId;
      if (shown) selectTab(shown);
      return;
    }
    if (e.type === 'pointercancel' || !geom) return;
    applyPaneDrop(g.key, zoneAt(geom, e.clientX, e.clientY));
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

  /**
   * Re-tile the panes into `cols` x `rows`. Nothing is ever closed: a target
   * with fewer cells than there are panes MERGES tab sets (`reflow`'s own rule),
   * so a 1x1 pick is the way back to classic tabs with every tab preserved and
   * ordered as the panes read — `withLayout` collapses that single cell to
   * `layout: null`.
   */
  const applyReflow = (cols: number, rows: number) => {
    setPicker(false);
    if (!layout) return; // no panes to rearrange
    const next = reflow(layout, cols, rows);
    if (!next) return;
    mapActiveSpace((s) => withLayout(s, layout, next));
  };

  /** Ctrl+Arrow inside the picker: swap the focused pane with its neighbour.
   *  Committed per press, exactly like SplitDividers' arrow-key resize, and
   *  therefore explicitly NOT part of what Escape reverts. */
  const movePane = (dir: Side) => {
    if (!layout || !focusedKey) return;
    const n = neighbour(layout, focusedKey, dir);
    if (!n) return;
    const next = swapCells(layout, focusedKey, n);
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
    split: placement.split,
    onSplit: splitPane,
    onClosePane: closePane,
  };

  /**
   * Every prop ONE strip needs — the single global one (`key === null`, no
   * layout) or one pane's.
   *
   * A pane strip REUSES TabBar rather than forking a second strip component,
   * and that is the whole reason group runs, pinned tabs, the sliding drag and
   * the context menu behave in a pane exactly as they do in the window: there
   * is one implementation, not two to keep in step. Everything that differs is
   * a coordinate — the list, and where its order is written back to — which is
   * what `key` threads through `applyToSlice` / `reorderTabs` / `togglePin`.
   */
  /** Where "Move Tab to ▸" can send something (KAN-66). Every strip in the
   *  window draws ONE space — the active one — so "except the tab's own space"
   *  is "except the active space", and App is the only place that knows it. */
  const otherSpaces = spaces
    .filter((s) => s.id !== activeSpaceId)
    .map((s) => ({ id: s.id, name: s.name }));

  const stripProps = (key: CellKey | null, list: Tab[]) => ({
    tabs: list,
    groups,
    groupActions: groupActionsFor(key),
    splitActions,
    status,
    onSelect: selectTab,
    // Both the `×` and the context menu's Close land here (KAN-57) — never on
    // `closeTab`, which `closeNow` is now the only caller of.
    onClose: (id: string) => { requestClose([id]); },
    onAdd: () => addTab(key),
    onReorder: reorderTabs(key),
    onReorderGroup: reorderGroup(key),
    onTogglePin: togglePin(key),
    onRename,
    onOpenExplorer,
    onOpenTerminal,
    onOpenIde,
    otherSpaces,
    onMoveTabToSpace: moveTabToSpace,
    onMoveGroupToSpace: moveGroupToSpace,
    paneKey: key,
  });

  const spaceMenu = (
    <SpaceMenu
      spaces={spaces}
      activeSpaceId={activeSpaceId}
      onSwitch={switchToSpace}
      onCreate={onCreateSpace}
      onRename={(id, name) => setSpaces((ss) => renameSpace(ss, id, name))}
      onDelete={onDeleteSpace}
      onTogglePin={(id, pinned) => setSpaces((ss) => setSpacePinned(ss, id, pinned))}
      // KAN-66: dropping a tab / a group on a space row is the same operation
      // the strip's "Move Tab to ▸" is, down to the same function — so the
      // confirm, the source-pane cleanup and the focus re-pick cannot drift
      // between the gesture and the menu.
      onMoveTab={moveTabToSpace}
      onMoveGroup={moveGroupToSpace}
      // App owns the join because `status` is keyed by ptyId, not by tab id —
      // SpaceMenu only renders the answer. Every member of the space, not just
      // the visible ones: deleting it closes all of them.
      tabsOf={(spaceId): { risks: CloseRisk[]; pinnedCount: number } => {
        const members = sliceOf(spaces.find((x) => x.id === spaceId)?.tabIds ?? [], tabs);
        return {
          risks: members.map((t) => closeRisk(t, status)),
          pinnedCount: members.filter((t) => t.pinned).length,
        };
      }}
    />
  );

  return (
    <div className="app">
      {/* With a layout up the top bar keeps its CHROME and loses its tabs: the
          same element, the same height, the same bottom rule, so nothing jumps
          — the tab list and the `+` have moved into the per-pane strips, which
          is what makes "which pane does a new tab open into?" answerable by
          construction instead of by a rule. With no layout this is byte-for-byte
          the strip it has always been. */}
      {placement.split
        ? <div className="tabbar spacebar">{spaceMenu}</div>
        : <TabBar {...stripProps(null, spaceTabs)} activeId={active} spaceMenu={spaceMenu} />}
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
                // KAN-62 finding #1: which pane's keyboard shortcuts fire —
                // `active` is the one focus truth (see "THE FOCUSED PANE IS
                // DERIVED" above), not a second copy of it.
                focused={t.id === active}
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
              <Terminal ptyId={t.ptyId} kind={t.terminalKind} keybinds={keybinds} />
            </div>
          ) : null,
        )}
        {/* PER-PANE TAB STRIPS (KAN-56), and they are FLAT SIBLINGS of the panes
            for exactly the reason the panes themselves are flat: a component
            that wrapped a pane's strip AND its content would re-parent every
            xterm in the window on every cross-pane move and on every
            `layout: null <-> grid` transition, which is KAN-23 per pane per
            drag. So a cell gets a `.paneslot` carrying only its strip, placed
            on the same grid by the same `grid-area` mechanism, and the tab's
            own `.pane` is merely pushed down by `top: STRIP_PX` — a RESIZE of
            an existing node, which Terminal.tsx already coalesces (KAN-50).

            The slot is `pointer-events: none` so it cannot eat a click meant
            for the pane under it; the strip inside re-enables them. A strip
            remounting when its cell's anchor changes (a swap, a reflow) is
            provably harmless — a strip holds no xterm, no scrollback and no
            process. Only the terminal hosts are identity-critical, and they are
            keyed by tab id in a parent that never changes.

            The FOCUS RING lives here rather than on the pane: the thing with
            focus is the whole window-like region, strip included. */}
        {placement.cells.map((c) => {
          const key = cellKey(c);
          return (
            <div
              key={key}
              className={c.tabIds.includes(active) ? 'paneslot pane-focused' : 'paneslot'}
              data-cell={key}
              style={placement.strips[key]}
            >
              <TabBar
                {...stripProps(key, sliceOf(c.tabIds, tabs))}
                activeId={c.activeTabId}
                onAdopt={adoptInto(key)}
                onPaneGrab={onStripGrab(key)}
              />
            </div>
          );
        })}
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
          count={layout?.cells.length ?? 0}
          anchor={contentRef.current?.getBoundingClientRect() ?? null}
          onApply={applyReflow}
          onMovePane={movePane}
          onClose={() => setPicker(false)}
        />
      )}
      {showSettings && (
        // KAN-83: closing the modal — Save or Cancel alike — re-reads settings
        // so a keybind change takes effect immediately. Re-fetching on Cancel
        // too is deliberate: it is a no-op read, and distinguishing the two
        // outcomes here would only duplicate SettingsModal's own knowledge of
        // whether it actually wrote anything.
        <SettingsModal onClose={() => { setShowSettings(false); refreshKeybinds(); }} />
      )}
      {pendingClose && (
        <ConfirmDialog request={pendingClose} onClose={() => setPendingClose(null)} />
      )}
      {pendingMove && (
        <ConfirmDialog request={pendingMove} onClose={() => setPendingMove(null)} />
      )}
      {/* Last, so it is over every other modal — including KAN-57's close confirm
          above: whatever else is open, this is the one asking to run code. */}
      {spawnAsk && <SpawnConfirm request={spawnAsk} onAnswer={answerSpawn} />}
    </div>
  );
}
