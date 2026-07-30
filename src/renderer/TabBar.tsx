import { Fragment, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Tab } from './tabs';
import type { PtyStatus, TabGroup } from '../shared/types';
import { useAppState, type DragPayload } from './appstate';
import { GROUP_COLORS, moveGroupRun, reorderWithGroups, segments } from '../shared/groups';
import { ContextMenu } from './components/ContextMenu';

const TAB_MIME = 'application/x-ce-tab';
/** Dragging a group by its label chip carries the group id, not a tab id — the
 *  two drags land through different model calls, so they need different types. */
const GROUP_MIME = 'application/x-ce-tabgroup';
const SPRING_MS = 600;
/** How long a displaced tab takes to slide to its new slot. Short enough that
 *  the strip keeps up with a fast drag, long enough to read as movement. */
const SLIDE_MS = 160;

/**
 * A drag in flight (KAN-52). `ids` are the slide keys the FLIP pass must LEAVE
 * ALONE because the pointer is positioning them; `moveKeys` are the ones the
 * pointer actually translates. They differ for a group drag: the wrapper is
 * what follows the pointer, but its member tabs ride inside it and would be
 * measured as having moved, so they are excluded from FLIP without being
 * translated themselves.
 */
type Dnd =
  // `id`, not a frozen index (KAN-52 review #4): a tab closing or opening
  // mid-drag (pty exit, auto-link) shifts everyone's index, and dragstart's
  // snapshot would silently move the wrong tab. Resolved back to an index via
  // `indexOf` at every use, so it always reads the CURRENT list.
  | { kind: 'tab'; id: string; ids: Set<string>; moveKeys: string[] }
  | { kind: 'group'; groupId: string; ids: Set<string>; moveKeys: string[] };

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// GROUP_COLORS is the palette; these are just human labels for the recolor
// menu, positional. A colour the list doesn't name still gets an entry.
const COLOR_NAMES = ['Clay', 'Sage', 'Sand'];

/** Everything the strip can do to a tab folder. One object rather than eight
 *  more flat props — the seam is frozen here for the rest of M5. */
export interface GroupActions {
  create: (tabId: string) => void;
  add: (tabId: string, groupId: string) => void;
  remove: (tabId: string) => void;
  rename: (groupId: string, name: string) => void;
  recolor: (groupId: string, color: string) => void;
  /** Un-groups the members; must NOT close them. */
  ungroup: (groupId: string) => void;
  closeTabs: (groupId: string) => void;
  toggleCollapsed: (groupId: string) => void;
}

/**
 * Split view, from the strip's point of view (KAN-46). One object, same seam
 * shape as `GroupActions`.
 *
 * The strip stays global and single: there is one row of tabs no matter how
 * many panes are up, and a tab is not "in" a pane — panes are placement only.
 * So the only thing the menu needs to know is whether the right-clicked tab
 * currently HAS a pane, which decides between "put it in a new one" and "take
 * its pane away".
 */
export interface SplitActions {
  /** Tab ids with a pane right now. With no split up this is the active tab,
   *  which is the single pane — that is what keeps "Split right" off the menu
   *  of the tab you are already looking at, where it could only be a no-op. */
  placed: string[];
  /** More than one pane is up, i.e. there is a pane to close. */
  split: boolean;
  /** Splits the FOCUSED pane and shows `tabId` in the half that appears. */
  onSplit: (tabId: string, axis: 'col' | 'row') => void;
  /** Removes `tabId`'s pane. The tab itself stays on the strip. */
  onClosePane: (tabId: string) => void;
}

interface Props {
  /** The ACTIVE SPACE's ordered slice, not every tab that exists — the strip
   *  renders one space (KAN-45). `segments()` and the `onReorder` indices below
   *  are therefore space-relative; see the authority rule in renderer/spaces.ts. */
  tabs: Tab[];
  groups: TabGroup[];
  groupActions: GroupActions;
  splitActions: SplitActions;
  activeId: string;
  status: Map<string, PtyStatus>;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onAdd: () => void;
  onReorder: (from: number, insert: number) => void; // insert index is post-splice (see groups.reorderWithGroups)
  /** Drag-by-head (KAN-52): move a whole group's run. Same post-splice `insert`
   *  coordinate as `onReorder`, over the list with the run removed. */
  onReorderGroup: (groupId: string, insert: number) => void;
  /** Chrome-style pin/unpin (KAN-53). Not part of `GroupActions` on purpose:
   *  pinning REMOVES a tab from its group, so folding it in there would put the
   *  two mutually exclusive states behind one seam. */
  onTogglePin: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onOpenExplorer: (id: string) => void;
  onOpenTerminal: (id: string) => void;
  onOpenIde: (id: string) => void;
  /** Rendered at the very left edge — the only control there. The File menu
   *  (New Tab / Open Recent) used to live in this strip too, but KAN-55 moved
   *  it into the native app menu, so `spaceMenu` is on its own now. */
  spaceMenu: ReactNode;
}

export function TabBar({
  tabs, groups, groupActions, splitActions, activeId, status, onSelect, onClose, onAdd, onReorder,
  onReorderGroup, onTogglePin, onRename, onOpenExplorer, onOpenTerminal, onOpenIde, spaceMenu,
}: Props) {
  // useAppState throws until the provider is mounted (V4); tolerate that pre-V4.
  let drag: DragPayload = null;
  try { drag = useAppState().drag; } catch { /* provider not mounted yet */ }

  // Drag state lives in BOTH a ref and state on purpose. The ref is the source
  // of truth for the event handlers — dragstart, dragover and drop are three
  // separate native events and the handlers must not have to wait for React to
  // commit between them (the hazard groups.mjs documents at its top). The state
  // is what re-renders the strip into the previewed order.
  const dndRef = useRef<Dnd | null>(null);
  const insertRef = useRef<number | null>(null);
  const [dnd, setDnd] = useState<Dnd | null>(null);
  const [insert, setInsert] = useState<number | null>(null);
  const [springId, setSpringId] = useState<string | null>(null);
  const springTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [gmenu, setGmenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [gRenaming, setGRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const clearSpring = () => {
    if (springTimer.current) { clearTimeout(springTimer.current); springTimer.current = null; }
    setSpringId(null);
  };

  const startSpring = (id: string) => {
    if (springTimer.current) clearTimeout(springTimer.current);
    setSpringId(id);
    springTimer.current = setTimeout(() => { onSelect(id); clearSpring(); }, SPRING_MS);
  };

  const startRename = (id: string) => {
    const t = tabs.find((x) => x.id === id);
    if (!t) return;
    setGRenaming(null);
    setDraft(t.title);
    setRenaming(id);
  };

  const commitRename = () => {
    if (renaming) onRename(renaming, draft);
    setRenaming(null);
  };

  // Same inline-edit pattern as a tab rename, sharing `draft` — only one of the
  // two can be open at a time (each entry point closes the other).
  const startGroupRename = (id: string) => {
    const g = groups.find((x) => x.id === id);
    if (!g) return;
    setRenaming(null);
    setDraft(g.name);
    setGRenaming(id);
  };

  const commitGroupRename = () => {
    if (gRenaming) groupActions.rename(gRenaming, draft);
    setGRenaming(null);
  };

  const renameInput = (commit: () => void, cancel: () => void) => (
    <input
      className="tab-rename"
      autoFocus
      value={draft}
      onClick={(e) => e.stopPropagation()}
      onDragStart={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      }}
    />
  );

  // Drag coordinates are indexes into the FLAT `tabs` prop — the active space's
  // slice (KAN-45), not into a segment. reorder()/reorderWithGroups()/
  // reorderInSpace() all speak that space. Collapsed members
  // still occupy their indexes here, which is what keeps a drop next to a
  // collapsed group land in the same place it would if it were open.
  //
  // Note this indexes the PROP, never `view` below: the preview is derived from
  // `tabs` on every pointer move and must never be fed back into itself, or the
  // drag would compound its own guesses instead of re-asking the model.
  const indexOf = new Map(tabs.map((t, i) => [t.id, i] as const));

  // ===== Sliding drag (KAN-52) ==============================================
  // The strip renders the ANSWER the model would give if you released right now
  // — `reorderWithGroups` / `moveGroupRun` over the real list — so "dropping
  // commits what is already on screen" is true by construction rather than by
  // two code paths being kept in agreement. The drop hands the same `insert` to
  // App, which calls the same function.
  const view: Tab[] =
    dnd === null || insert === null
      ? tabs
      : dnd.kind === 'tab'
        ? (() => {
            const from = indexOf.get(dnd.id);
            return from === undefined ? tabs : reorderWithGroups(tabs, from, insert);
          })()
        : moveGroupRun(tabs, dnd.groupId, insert);

  const stripRef = useRef<HTMLDivElement>(null);
  /** Slot centres frozen at dragstart, one per index of `tabs`. Frozen, not
   *  live: re-measuring after each preview would let a threshold the drag has
   *  just crossed move under the pointer and oscillate. ponytail: a tab joining
   *  a group widens that run by the wrapper's padding, so later thresholds
   *  drift by a few px — re-capture per preview (and add hysteresis) if anyone
   *  can feel it. */
  const geom = useRef<{ id: string; center: number }[]>([]);
  /** Last committed left edge per slide key — the "First" of the FLIP. */
  const lastLeft = useRef<Map<string, number>>(new Map());
  /** Pointer offset inside the grabbed element, and its live translation. */
  const grab = useRef({ dx: 0, tx: 0 });
  const ghost = useRef<HTMLCanvasElement | null>(null);
  /** Last pointer x seen by dragover, so the layout effect can re-anchor the
   *  held tab after a preview commit (KAN-52 review #5). */
  const lastX = useRef<number | null>(null);

  const slideNode = (key: string) =>
    stripRef.current?.querySelector<HTMLElement>(`[data-slide="${CSS.escape(key)}"]`) ?? null;

  /**
   * FLIP: the previewed order is really rendered (so group chrome, padding and
   * the pinned clamp all lay themselves out correctly), then every displaced
   * element is snapped back to where it was and released. Layout runs only when
   * the previewed INDEX changes, not per pointer move; everything between is
   * pure transform.
   */
  useLayoutEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const nodes = [...el.querySelectorAll<HTMLElement>('[data-slide]')];
    const before = lastLeft.current;
    lastLeft.current = new Map(nodes.map((n) => [n.dataset.slide!, n.getBoundingClientRect().left] as const));
    if (!dnd || reducedMotion()) return;

    const moved: HTMLElement[] = [];
    for (const n of nodes) {
      if (dnd.ids.has(n.dataset.slide!)) continue;
      // Document order puts a group wrapper before its members, so an already
      // translated ancestor means this node is riding along and must not be
      // translated again.
      if (n.parentElement?.closest<HTMLElement>('[data-slide]')?.style.transform) continue;
      const was = before.get(n.dataset.slide!);
      const dx = was === undefined ? 0 : was - lastLeft.current.get(n.dataset.slide!)!;
      if (!dx) continue;
      n.style.transition = 'none';
      n.style.transform = `translateX(${dx}px)`;
      moved.push(n);
    }
    if (moved.length) {
      void el.offsetWidth; // flush the inverted positions before releasing them
      for (const n of moved) { n.style.transition = `transform ${SLIDE_MS}ms ease`; n.style.transform = ''; }
    }
    // KAN-52 review #5: a preview commit can remount the dragged node itself
    // (crossing into/out of a group wrapper is a parent change, so React
    // discards the old node), which drops its transform for one frame until
    // the next dragover reapplies it. Re-anchor right after the commit,
    // using the last pointer position, instead of waiting for that event.
    if (lastX.current !== null) follow(lastX.current);
  });

  const beginDrag = (next: Dnd, e: React.DragEvent, node: HTMLElement | null) => {
    dndRef.current = next;
    insertRef.current = null;
    setDnd(next);
    setInsert(null);
    // Freeze the geometry. A collapsed group's members have no element of their
    // own, so they inherit their label chip's centre — which is exactly right:
    // the whole run is one thing on screen, so the pointer is either left of it
    // or right of it.
    const el = stripRef.current;
    geom.current = tabs.map((t) => {
      const n = el && (slideNode(t.id) ?? (t.groupId ? slideNode(`g:${t.groupId}`) : null));
      const r = n?.getBoundingClientRect();
      return { id: t.id, center: r ? r.left + r.width / 2 : Number.MAX_SAFE_INTEGER };
    });
    grab.current = { dx: node ? e.clientX - node.getBoundingClientRect().left : 0, tx: 0 };
    // KAN-52 review #1: the preview reparents the dragged element across a
    // group boundary (into or out of a .tabgroup wrapper), and React remounts
    // across a parent change — so the ORIGINAL source node is detached from
    // the tree and a `dragend` listener on `.tabbar` never sees it bubble.
    // `dragend` still fires ON the node the OS is tracking as the drag
    // source, wherever it now sits, so listen there directly.
    if (node) node.addEventListener('dragend', cancelDrag, { once: true });
    e.dataTransfer.effectAllowed = 'move';
    // The real element follows the pointer, so the OS ghost would be a second
    // copy of the same tab. Under reduced motion nothing follows the pointer,
    // so the ghost is the only drag affordance left and stays.
    if (!reducedMotion()) {
      if (!ghost.current) {
        const c = document.createElement('canvas');
        c.width = c.height = 1;
        ghost.current = c;
      }
      try { e.dataTransfer.setDragImage(ghost.current, 0, 0); } catch { /* synthetic DragEvent (harness) */ }
    }
  };

  const endDrag = () => {
    for (const n of stripRef.current?.querySelectorAll<HTMLElement>('[data-slide]') ?? []) {
      n.style.transition = '';
      n.style.transform = '';
    }
    dndRef.current = null;
    insertRef.current = null;
    lastX.current = null;
    setDnd(null);
    setInsert(null);
  };

  // Shared by the strip's onDragEnd and the source-node listener beginDrag
  // attaches (KAN-52 review #1) — both are just "the drag is over, and it was
  // not a drop" (onDrop already calls endDrag itself and short-circuits
  // before this can double-fire anything observable).
  const cancelDrag = () => { clearSpring(); endDrag(); };

  /** Post-splice insert index: how many tabs that are NOT moving sit left of
   *  the pointer. Same coordinate space `reorderWithGroups` expects. */
  const insertAt = (x: number, ids: Set<string>) =>
    geom.current.reduce((n, g) => n + (!ids.has(g.id) && g.center < x ? 1 : 0), 0);

  const follow = (x: number) => {
    for (const key of dndRef.current?.moveKeys ?? []) {
      const n = slideNode(key);
      if (!n) continue;
      // rect.left already includes the current translation, so back it out.
      const t = grab.current.tx + x - grab.current.dx - n.getBoundingClientRect().left;
      grab.current.tx = t;
      n.style.transition = 'none';
      n.style.transform = `translateX(${t}px)`;
    }
  };

  const renderTab = (t: Tab) => {
    let cls = t.id === activeId ? 'tab active' : 'tab';
    if (t.pinned) cls += ' pinned';
    if (dnd?.kind === 'tab' && dnd.ids.has(t.id)) cls += ' dragging';
    if (springId === t.id) cls += ' spring-target';
    const isTerminal = t.view === 'terminal';
    const isClaude = isTerminal && t.terminalKind === 'claude';
    const st = isClaude ? (status.get(t.ptyId!) ?? 'running') : null;
    return (
      <button
        key={t.id}
        data-slide={t.id}
        className={cls}
        // A pinned tab shows no title, so the native tooltip is the only way
        // left to tell two folder icons apart.
        title={t.pinned ? t.title : undefined}
        draggable={renaming !== t.id}
        onClick={() => onSelect(t.id)}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, id: t.id }); }}
        onDragStart={(e) => {
          beginDrag({ kind: 'tab', id: t.id, ids: new Set([t.id]), moveKeys: [t.id] }, e, e.currentTarget);
          e.dataTransfer.setData(TAB_MIME, t.id);
        }}
        onDragEnter={(e) => {
          // File drag from a FileBrowser → spring-load this tab after a hover.
          if (drag && e.dataTransfer.types.includes('application/x-ce-files')) {
            if (springId !== t.id) startSpring(t.id);
          }
        }}
        // A tab reorder is steered by the STRIP, not by whichever tab happens to
        // be under the pointer — the tabs move as you drag, so the element you
        // are over keeps changing. Only the file-drag hover is per-tab now.
        onDragOver={(e) => { if (drag && !dndRef.current) e.preventDefault(); }}
        onDragLeave={() => { if (springId === t.id) clearSpring(); }}
      >
        <span className="tab-icon">
          {isClaude
            ? <span className={'tab-status ' + st} />
            : isTerminal ? '▶' : '📁'}
        </span>
        {/* Pinned = icon only: no title, no close button (Chrome's model — a
            pinned tab is meant to be un-closable by accident). Both are still
            reachable from the context menu. Rename is still offered, so the
            input still renders here when it is open. */}
        {renaming === t.id
          ? renameInput(commitRename, () => setRenaming(null))
          : !t.pinned && <span className="tab-title">{t.title}</span>}
        {!t.pinned && (
          <span className="close" onClick={(e) => { e.stopPropagation(); onClose(t.id); }}>×</span>
        )}
      </button>
    );
  };

  return (
    <div
      className="tabbar"
      ref={stripRef}
      onDragOver={(e) => {
        const d = dndRef.current;
        if (!d || !(e.dataTransfer.types.includes(TAB_MIME) || e.dataTransfer.types.includes(GROUP_MIME))) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const at = insertAt(e.clientX, d.ids);
        if (at !== insertRef.current) { insertRef.current = at; setInsert(at); }
        if (!reducedMotion()) { lastX.current = e.clientX; follow(e.clientX); }
      }}
      onDrop={(e) => {
        const d = dndRef.current;
        const at = insertRef.current;
        // Unconditional: a FILE dropped on a tab lands here too, and its
        // spring-load timer must not survive the drop that ended the hover.
        clearSpring();
        if (!d) return;
        e.preventDefault();
        endDrag();
        if (at === null) return;
        // Unconditional, even when `at` equals the tab's own index: landing on a
        // group's inclusive edge changes MEMBERSHIP without changing position,
        // and the preview has already shown that happening.
        if (d.kind === 'tab') {
          // Resolved fresh, not the dragstart snapshot (KAN-52 review #4) — a
          // close/open mid-drag would otherwise move whatever tab now sits at
          // a stale index instead of the one actually dragged.
          const from = indexOf.get(d.id);
          if (from !== undefined) onReorder(from, at);
        } else onReorderGroup(d.groupId, at);
      }}
      onDragEnd={cancelDrag}
    >
      {spaceMenu}
      {/* Chrome's model: a group is a contiguous run of the one horizontal
          strip. segments() does the chopping; groups.ts guarantees contiguity,
          so there is no layout maths here — an ungrouped run renders exactly as
          it always did (direct children of .tabbar), a grouped run gets one
          wrapper carrying the colour bar and the label chip. */}
      {segments(view, groups).map((seg, si) =>
        seg.group === null ? (
          <Fragment key={`loose-${si}`}>{seg.tabs.map(renderTab)}</Fragment>
        ) : (
          <div
            key={seg.group.id}
            data-slide={`g:${seg.group.id}`}
            className={dnd?.kind === 'group' && dnd.groupId === seg.group.id ? 'tabgroup dragging' : 'tabgroup'}
            style={{ '--group-color': seg.group.color } as CSSProperties}
          >
            <span
              className="group-label"
              // Grabbing the chip drags the whole run (KAN-52). The chip is also
              // the collapse toggle and the group menu; a drag and a click are
              // mutually exclusive gestures, so all three coexist.
              draggable={gRenaming !== seg.group.id}
              onDragStart={(e) => {
                const g = seg.group!;
                const key = `g:${g.id}`;
                beginDrag({
                  kind: 'group',
                  groupId: g.id,
                  // Members ride inside the wrapper: excluded from FLIP, but the
                  // wrapper is the only thing the pointer translates.
                  ids: new Set([key, ...tabs.filter((t) => t.groupId === g.id).map((t) => t.id)]),
                  moveKeys: [key],
                }, e, e.currentTarget.closest<HTMLElement>('.tabgroup'));
                e.dataTransfer.setData(GROUP_MIME, g.id);
              }}
              onClick={() => { if (gRenaming !== seg.group!.id) groupActions.toggleCollapsed(seg.group!.id); }}
              onContextMenu={(e) => { e.preventDefault(); setGmenu({ x: e.clientX, y: e.clientY, id: seg.group!.id }); }}
            >
              {gRenaming === seg.group.id
                ? renameInput(commitGroupRename, () => setGRenaming(null))
                : (
                  <>
                    <span className="group-label-name">{seg.group.name}</span>
                    {seg.group.collapsed && (
                      <span className="group-label-count"> ({seg.tabs.length})</span>
                    )}
                  </>
                )}
            </span>
            {/* ponytail: a collapsed group hides its members even when one of
                them is the active tab — the pane still shows it, but its tab is
                not on the strip. Chrome moves focus out instead; do that here if
                anyone trips over it. */}
            {!seg.group.collapsed && seg.tabs.map(renderTab)}
          </div>
        ),
      )}
      <button className="tab add" onClick={onAdd}>+</button>

      {menu && (() => {
        const t = tabs.find((x) => x.id === menu.id);
        const hasPane = splitActions.placed.includes(menu.id);
        // Exactly one of these two is ever offered, because "does this tab have
        // a pane" is the whole state machine: a tab with no pane can be split
        // into one, a tab with a pane can lose it. Splitting a tab that is
        // already on screen would just be a move, and closing the only pane
        // there is is what `layout: null` already means.
        //
        // Empty for the common case — the active tab with no split up
        // (`hasPane && !split`, "close pane" makes no sense with nothing to
        // close). Its leading separator rides along with it: spread in below
        // ONLY when there is something to separate, or an empty array between
        // two unconditional separators renders a double rule (ContextMenu does
        // not collapse runs of them) every time that common case hits.
        const splitItems = hasPane
          ? splitActions.split
            ? [{ label: 'Close pane', onClick: () => splitActions.onClosePane(menu.id) }]
            : []
          : [
            { label: 'Split right', onClick: () => splitActions.onSplit(menu.id, 'col' as const) },
            { label: 'Split down', onClick: () => splitActions.onSplit(menu.id, 'row' as const) },
          ];
        return (
          <ContextMenu
            x={menu.x}
            y={menu.y}
            onClose={() => setMenu(null)}
            items={[
              { label: 'Rename', onClick: () => startRename(menu.id) },
              { label: 'Open in File Explorer', onClick: () => onOpenExplorer(menu.id) },
              { label: 'Open Terminal', onClick: () => onOpenTerminal(menu.id) },
              { label: 'Open in IDE', onClick: () => onOpenIde(menu.id) },
              ...(splitItems.length ? [{ separator: true as const }, ...splitItems] : []),
              { separator: true },
              { label: t?.pinned ? 'Unpin tab' : 'Pin tab', onClick: () => onTogglePin(menu.id) },
              // Pinning and grouping are mutually exclusive (KAN-53): a pinned
              // tab is held left of every unpinned one, so it could only ever
              // break a group's contiguous run. groups.ts refuses the operation;
              // the menu must not offer it either, or the item would silently do
              // nothing. A pinned tab also never has a groupId, so "Remove from
              // group" cannot apply.
              ...(t?.pinned ? [] : [
                { label: 'New group from this tab', onClick: () => groupActions.create(menu.id) },
                // KAN-45 integration review #2: `groups` is the whole workspace's
                // list, not this strip's — filtered to groups that actually have a
                // member ON THIS STRIP (`tabs` is the active space's slice), or a
                // group that lives entirely in another space shows up here too,
                // and picking it splits one group across two spaces: both strips
                // draw a chip for it, and collapse/rename/recolor/ungroup act on
                // both at once since those all run over the global `groups`/`tabs`.
                ...groups
                  .filter((g) => g.id !== t?.groupId && tabs.some((x) => x.groupId === g.id))
                  .map((g) => ({ label: `Add to “${g.name}”`, swatch: g.color, onClick: () => groupActions.add(menu.id, g.id) })),
                ...(t?.groupId ? [{ label: 'Remove from group', onClick: () => groupActions.remove(menu.id) }] : []),
              ]),
              { separator: true },
              { label: 'Close', onClick: () => onClose(menu.id) },
            ]}
          />
        );
      })()}

      {gmenu && (
        <ContextMenu
          x={gmenu.x}
          y={gmenu.y}
          onClose={() => setGmenu(null)}
          items={[
            { label: 'Rename group', onClick: () => startGroupRename(gmenu.id) },
            { separator: true },
            ...GROUP_COLORS.map((c, i) => ({
              label: COLOR_NAMES[i] ?? `Color ${i + 1}`,
              swatch: c,
              onClick: () => groupActions.recolor(gmenu.id, c),
            })),
            { separator: true },
            { label: 'Ungroup', onClick: () => groupActions.ungroup(gmenu.id) },
            { label: "Close group's tabs", onClick: () => groupActions.closeTabs(gmenu.id) },
          ]}
        />
      )}
    </div>
  );
}
