// Renderer half of test/harness/splitgrid.mjs.
//
// This deliberately reproduces App.tsx's REAL structure rather than a
// convenient one, because the whole point of the inverted design is that split
// view does not change that structure:
//   - one flat container (`.content`, position: relative) that gets
//     `placement.container` spread onto it;
//   - EVERY tab mounted once, forever, as an absolutely positioned `.pane`
//     sibling — never re-parented, merely hidden when it is not on screen
//     (that is KAN-23: an xterm that changes parent loses alt-screen mode and
//     its scrollback);
//   - each pane's whole contribution to the layout is `placement.panes[id]`;
//   - one `.paneslot` per CELL (KAN-56), a FLAT SIBLING of the panes carrying
//     that pane's strip and the focus ring, placed on the same grid by the same
//     `grid-area` mechanism. A `<Pane>` component owning both the strip and the
//     content would re-parent every xterm on every cross-pane move, which is
//     the same KAN-23 constraint one level up — so the two are siblings and the
//     tab's own `.pane` is merely pushed down by `top: STRIP_PX`.
//
// Every stand-in has the SAME shape as Terminal.tsx's outer node (a div at
// width:100%/height:100% carrying its own ResizeObserver), so the harness
// measures the exact condition a real terminal depends on.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { GridCell, GridLayout } from '../../src/shared/types';
import { SplitDividers } from '../../src/renderer/components/SplitDividers';
import { cellKey } from '../../src/renderer/gridlayout';
import { gridPlacement } from '../../src/renderer/splitgrid';
import '../../src/renderer/index.css';

const H = window as any;
H.__mounts = {};      // tabId -> times the stand-in has mounted (re-mount detector)
H.__roFires = {};     // tabId -> times the stand-in's OWN ResizeObserver fired
H.__lastResize = null;
H.__resizeCalls = 0;

// KAN-56: a cell is a WINDOW with its own ordered strip, not a tab. One tab per
// cell here on purpose — this is the GEOMETRY harness, and a pane's rectangle
// does not depend on how many tabs its strip lists. Multi-tab panes, cross-pane
// tab drags and strip order are splitview.mjs's job, against the real app.
const cell = (tabId: string, col: number, row: number, colSpan = 1, rowSpan = 1): GridCell =>
  ({ tabIds: [tabId], activeTabId: tabId, col, row, colSpan, rowSpan });

const grid = (cols: number, rows: number): GridLayout => {
  const cells: GridCell[] = [];
  let i = 0;
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols; col++) cells.push(cell(String.fromCharCode(97 + i++), col, row));
  return { cols, rows, cells };
};

// Named cols x rows. `null` is the classic single-pane path — the transition
// that the pane-owning design would have re-mounted every terminal across.
H.__layouts = {
  null: null,
  '1x1': grid(1, 1),
  '1x2': grid(1, 2),
  '2x1': grid(2, 1),
  '2x2': grid(2, 2),
  '3x3': grid(3, 3),
  // A span case, to prove the m x n block path is not a two-pane special case.
  span: { cols: 3, rows: 2, cells: [cell('a', 0, 0, 2, 2), cell('b', 2, 0), cell('c', 2, 1)] } as GridLayout,
  // Identical to '2x2' in every rectangle — only the ORDER of `cells` differs.
  // This is what gridlayout's `place()` actually produces: it moves the touched
  // tab to the end of the array. Nothing on screen has changed, so nothing may
  // re-mount or move in the DOM.
  '2x2reordered': {
    cols: 2, rows: 2,
    cells: [cell('c', 0, 1), cell('d', 1, 1), cell('a', 0, 0), cell('b', 1, 0)],
  } as GridLayout,
};

/** Every tab that exists. App mounts one `.pane` per terminal tab, always. */
const ALL = 'abcdefghi'.split('');
const HUES = [8, 140, 210, 40, 280, 170, 320, 95, 250];

function Stand({ tabId }: { tabId: string }) {
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    H.__mounts[tabId] = (H.__mounts[tabId] ?? 0) + 1;
    // Terminal.tsx's own mechanism, verbatim in spirit: an RO on the
    // 100%-of-pane div. If this never fires on a divider drag, no amount of
    // grid correctness saves a terminal.
    const node = el.current!;
    const ro = new ResizeObserver(() => { H.__roFires[tabId] = (H.__roFires[tabId] ?? 0) + 1; });
    ro.observe(node);
    return () => ro.disconnect();
  }, [tabId]);

  const hue = HUES[(tabId.charCodeAt(0) - 97) % HUES.length];
  return (
    <div
      ref={el}
      className="stand"
      data-stand={tabId}
      style={{
        width: '100%', height: '100%',
        background: `hsl(${hue} 45% 62%)`,
        font: '20px monospace', color: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      {tabId}
    </div>
  );
}

interface State {
  layout: GridLayout | null;
  focused: string | undefined;
  cols?: number[];
  rows?: number[];
}

function Harness() {
  const [s, setS] = useState<State>({ layout: H.__layouts['2x2'], focused: 'a' });
  const contentRef = useRef<HTMLDivElement>(null);
  const placement = useMemo(() => gridPlacement(s.layout, s.cols, s.rows), [s.layout, s.cols, s.rows]);

  // Assigned during render (not in an effect) so the driver script can call it
  // the moment the first paint lands.
  H.__set = (patch: Partial<State>) => setS((prev) => ({ ...prev, ...patch }));
  H.__setLayout = (name: string) => H.__set({ layout: H.__layouts[name], cols: undefined, rows: undefined });

  return (
    // #stage IS the container: `position: relative` + the placement style, the
    // five-line integration described in SplitDividers.tsx.
    <div
      id="stage"
      ref={contentRef}
      style={{ width: 800, height: 600, margin: 24, position: 'relative', overflow: 'hidden', ...placement.container }}
    >
      {ALL.map((id) => (
        <div
          key={id}
          className="pane"
          data-pane={id}
          style={placement.panes[id]}
          hidden={placement.split ? !placement.panes[id] : id !== s.focused}
          onPointerDownCapture={() => H.__set({ focused: id })}
        >
          <Stand tabId={id} />
        </div>
      ))}
      {/* One slot per cell, flat sibling of the panes, holding ONLY the strip —
          and wearing the focus ring, because with KAN-56 the thing that has
          focus is the whole window-like region, strip included. `pointer-events:
          none` on the slot (index.css) is what keeps it from eating a click
          meant for the pane underneath, which the focus section relies on. */}
      {placement.cells.map((c) => {
        const key = cellKey(c);
        return (
          <div
            key={key}
            className={c.tabIds.includes(s.focused ?? '') ? 'paneslot pane-focused' : 'paneslot'}
            data-cell={key}
            style={placement.strips[key]}
          >
            {/* TabBar's own outer node, verbatim in class: `.panestrip` is what
                carries `--panestrip-h`, so a drift between that and
                splitgrid.ts's STRIP_PX shows up as real geometry here. */}
            <div className="tabbar panestrip" data-panestrip={key}>{c.activeTabId}</div>
          </div>
        );
      })}
      <SplitDividers
        placement={placement}
        containerRef={contentRef}
        onResize={(cols, rows) => {
          H.__lastResize = { cols, rows };
          H.__resizeCalls += 1;
          H.__set({ cols, rows });
        }}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
