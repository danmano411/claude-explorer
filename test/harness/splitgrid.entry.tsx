// Renderer half of test/harness/splitgrid.mjs — SplitGrid with coloured divs
// standing in for panes. Bundled by that script; not part of the app build.
//
// Every stand-in deliberately has the SAME shape as Terminal.tsx's outer node
// (a div at width:100%/height:100% carrying its own ResizeObserver), so the
// harness measures the exact condition a real terminal depends on rather than a
// friendlier stand-in.
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { GridCell, GridLayout } from '../../src/shared/types';
import { SplitGrid, usePaneResize } from '../../src/renderer/components/SplitGrid';
import '../../src/renderer/index.css';

const H = window as any;
H.__mounts = {};      // tabId -> times the stand-in has mounted (re-mount detector)
H.__paneSizes = {};   // tabId -> sizes delivered by usePaneResize
H.__roFires = {};     // tabId -> times the stand-in's OWN ResizeObserver fired
H.__lastResize = null;

const cell = (tabId: string, col: number, row: number, colSpan = 1, rowSpan = 1): GridCell =>
  ({ tabId, col, row, colSpan, rowSpan });

const grid = (cols: number, rows: number): GridLayout => {
  const cells: GridCell[] = [];
  let i = 0;
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols; col++) cells.push(cell(String.fromCharCode(97 + i++), col, row));
  return { cols, rows, cells };
};

// Named cols x rows.
H.__layouts = {
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

const HUES = [8, 140, 210, 40, 280, 170, 320, 95, 250];

function Stand({ tabId }: { tabId: string }) {
  const el = useRef<HTMLDivElement>(null);

  usePaneResize(({ width, height }) => {
    (H.__paneSizes[tabId] ||= []).push([Math.round(width), Math.round(height)]);
  });

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
  layout: GridLayout;
  focused: string | undefined;
  cols?: number[];
  rows?: number[];
}

function Harness() {
  const [s, setS] = useState<State>({ layout: H.__layouts['2x2'], focused: 'a' });

  // Assigned during render (not in an effect) so the driver script can call it
  // the moment the first paint lands.
  H.__set = (patch: Partial<State>) => setS((prev) => ({ ...prev, ...patch }));
  H.__setLayout = (name: string) => H.__set({ layout: H.__layouts[name], cols: undefined, rows: undefined });

  return (
    <div id="stage" style={{ width: 800, height: 600, margin: 24 }}>
      <SplitGrid
        layout={s.layout}
        focusedTabId={s.focused}
        onFocusPane={(id) => H.__set({ focused: id })}
        colFractions={s.cols}
        rowFractions={s.rows}
        onResize={(cols, rows) => {
          H.__lastResize = { cols, rows };
          H.__set({ cols, rows });
        }}
        renderPane={(tabId) => <Stand tabId={tabId} />}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
