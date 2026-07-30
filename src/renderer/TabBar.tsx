import { Fragment, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Tab } from './tabs';
import type { PtyStatus, TabGroup } from '../shared/types';
import { useAppState, type DragPayload } from './appstate';
import { dropIndex } from '../shared/tabreorder';
import { GROUP_COLORS, segments } from '../shared/groups';
import { ContextMenu } from './components/ContextMenu';

const TAB_MIME = 'application/x-ce-tab';
const SPRING_MS = 600;

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
  onReorder: (from: number, insert: number) => void; // insert index is post-splice (from tabreorder)
  onRename: (id: string, title: string) => void;
  onOpenExplorer: (id: string) => void;
  onOpenTerminal: (id: string) => void;
  onOpenIde: (id: string) => void;
  /** Rendered at the very left edge, before the Recent menu (KAN-45). Same
   *  slot-shaped prop as `recentMenu` — the strip stays presentational and App
   *  owns the space state. */
  spaceMenu: ReactNode;
  recentMenu: ReactNode;
}

export function TabBar({
  tabs, groups, groupActions, splitActions, activeId, status, onSelect, onClose, onAdd, onReorder,
  onRename, onOpenExplorer, onOpenTerminal, onOpenIde, spaceMenu, recentMenu,
}: Props) {
  // useAppState throws until the provider is mounted (V4); tolerate that pre-V4.
  let drag: DragPayload = null;
  try { drag = useAppState().drag; } catch { /* provider not mounted yet */ }

  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [over, setOver] = useState<{ index: number; side: 'left' | 'right' } | null>(null);
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
  const indexOf = new Map(tabs.map((t, i) => [t.id, i] as const));

  const renderTab = (t: Tab) => {
    const i = indexOf.get(t.id)!;
    let cls = t.id === activeId ? 'tab active' : 'tab';
    if (over?.index === i) cls += over.side === 'right' ? ' drop-right' : ' drop-left';
    if (springId === t.id) cls += ' spring-target';
    const isTerminal = t.view === 'terminal';
    const isClaude = isTerminal && t.terminalKind === 'claude';
    const st = isClaude ? (status.get(t.ptyId!) ?? 'running') : null;
    return (
      <button
        key={t.id}
        className={cls}
        draggable={renaming !== t.id}
        onClick={() => onSelect(t.id)}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, id: t.id }); }}
        onDragStart={(e) => {
          setDragFrom(i);
          e.dataTransfer.setData(TAB_MIME, t.id);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragEnter={(e) => {
          // File drag from a FileBrowser → spring-load this tab after a hover.
          if (drag && e.dataTransfer.types.includes('application/x-ce-files')) {
            if (springId !== t.id) startSpring(t.id);
          }
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(TAB_MIME)) {
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            const side: 'left' | 'right' = e.clientX > r.left + r.width / 2 ? 'right' : 'left';
            if (over?.index !== i || over?.side !== side) setOver({ index: i, side });
          } else if (drag) {
            e.preventDefault(); // allow the file-drag hover to keep firing
          }
        }}
        onDragLeave={() => {
          if (springId === t.id) clearSpring();
          if (over?.index === i) setOver(null);
        }}
        onDrop={(e) => {
          clearSpring();
          const dropped = over;
          setOver(null);
          const id = e.dataTransfer.getData(TAB_MIME);
          if (id && dragFrom !== null && dropped) {
            e.preventDefault();
            const insert = dropIndex(dragFrom, dropped.index, dropped.side);
            if (insert !== dragFrom) onReorder(dragFrom, insert);
          }
          setDragFrom(null);
        }}
        onDragEnd={() => { setDragFrom(null); setOver(null); clearSpring(); }}
      >
        <span className="tab-icon">
          {isClaude
            ? <span className={'tab-status ' + st} />
            : isTerminal ? '▶' : '📁'}
        </span>
        {renaming === t.id
          ? renameInput(commitRename, () => setRenaming(null))
          : <span className="tab-title">{t.title}</span>}
        <span className="close" onClick={(e) => { e.stopPropagation(); onClose(t.id); }}>×</span>
      </button>
    );
  };

  return (
    <div className="tabbar">
      {spaceMenu}
      {recentMenu}
      {/* Chrome's model: a group is a contiguous run of the one horizontal
          strip. segments() does the chopping; groups.ts guarantees contiguity,
          so there is no layout maths here — an ungrouped run renders exactly as
          it always did (direct children of .tabbar), a grouped run gets one
          wrapper carrying the colour bar and the label chip. */}
      {segments(tabs, groups).map((seg, si) =>
        seg.group === null ? (
          <Fragment key={`loose-${si}`}>{seg.tabs.map(renderTab)}</Fragment>
        ) : (
          <div
            key={seg.group.id}
            className="tabgroup"
            style={{ '--group-color': seg.group.color } as CSSProperties}
          >
            <span
              className="group-label"
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
              { separator: true },
              // Exactly one of these two is ever offered, because "does this tab
              // have a pane" is the whole state machine: a tab with no pane can
              // be split into one, a tab with a pane can lose it. Splitting a
              // tab that is already on screen would just be a move, and closing
              // the only pane there is is what `layout: null` already means.
              ...(hasPane
                ? splitActions.split
                  ? [{ label: 'Close pane', onClick: () => splitActions.onClosePane(menu.id) }]
                  : []
                : [
                  { label: 'Split right', onClick: () => splitActions.onSplit(menu.id, 'col' as const) },
                  { label: 'Split down', onClick: () => splitActions.onSplit(menu.id, 'row' as const) },
                ]),
              { separator: true },
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
