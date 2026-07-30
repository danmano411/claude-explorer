import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

/** Quiet time that means "the size has come to rest" (see the resize comment). */
const SETTLE_MS = 120;

export function Terminal({ ptyId }: { ptyId: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const term = new XTerm({
      cursorBlink: true,
      fontFamily: 'Cascadia Mono, Consolas, monospace',
      fontSize: 13,
      theme: { background: '#262019', foreground: '#E8E0D0', cursor: '#C15F3C' }, // Retro Claude, see UI Design System
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);

    const offData = window.api.onPtyData((id, d) => { if (id === ptyId) term.write(d); });
    const offExit = window.api.onPtyExit((id) => { if (id === ptyId) term.write('\r\n[session ended]\r\n'); });
    term.onData((d) => window.api.ptyWrite(ptyId, d));

    // Ctrl/Shift+Enter insert a newline (LF) instead of submitting; plain Enter
    // still sends CR (submit). Mirrors the external terminal's behavior.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      // Ctrl+V / Ctrl+Shift+V paste the clipboard (xterm otherwise sends ^V to the shell).
      // term.paste respects bracketed-paste mode, matching right-click paste.
      if (e.ctrlKey && (e.key === 'v' || e.key === 'V')) {
        const text = window.api.clipboardReadText();
        if (text) term.paste(text);
        return false;
      }
      // Ctrl/Shift+Enter insert a newline (LF) instead of submitting; plain Enter
      // still sends CR (submit). Mirrors the external terminal's behavior.
      if (e.key === 'Enter' && (e.ctrlKey || e.shiftKey)) {
        window.api.ptyWrite(ptyId, '\n');
        return false;
      }
      return true;
    });

    // KAN-50 test seam. The invariant this component owns — xterm's grid matches
    // the size the pty was last told — is only checkable if both halves are
    // readable from outside. The pty half already is: it is an IPC message. This
    // is the xterm half, mirrored onto the element by xterm's OWN resize event,
    // so it tracks the grid rather than the code that reports the grid. An
    // ATTRIBUTE and not a JS property because DOM expandos are per-JS-world and
    // a test driver does not share the page's world.
    const mirror = () => {
      if (!ref.current) return;
      ref.current.dataset.cols = String(term.cols);
      ref.current.dataset.rows = String(term.rows);
    };
    term.onResize(mirror);
    mirror();

    // A hidden tab has no layout box; fitting to it would compute nonsense
    // cols/rows and resize the pty to match. The ResizeObserver fires again
    // when the tab is shown, so skipping here loses nothing.
    //
    // KAN-50: the pty is told the size only once it has STOPPED CHANGING, while
    // the fit still runs every frame so the grid tracks the box live.
    //
    // Every `ptyResize` is a `ResizePseudoConsole`, and ConPTY answers one by
    // re-emitting its whole screen buffer at that width. A drag used to produce
    // one per animation frame — ~30 for a one-second drag — so a TUI got ~30
    // widths in ~500ms and every one of them except the last was a width the
    // terminal had already moved past by the time the repaint arrived. A TUI
    // that samples its width per frame (Claude Code does) can render at any of
    // them, and the frame it settles on is then wrapped to a column the viewport
    // no longer has: text clipped mid-word at the left edge, overshooting the
    // right. Nothing re-renders it, so it stays wrong until something else
    // resizes the pane — which is exactly why switching tabs and back "fixed" it.
    //
    // So: coalescing intermediate sizes away is the fix, not an optimisation.
    // Only sizes the terminal actually came to rest at ever reach the pty.
    //
    // Not a poll and not a re-fit — a single trailing timer, re-armed while the
    // size is moving and fired once when it stops. SETTLE_MS is longer than a
    // frame (a drag fires every ~8-16ms) and shorter than a person letting go.
    let raf = 0;
    let settle = 0;
    const resize = () => {
      if (!ref.current?.clientHeight) return;
      fit.fit();
      clearTimeout(settle);
      settle = window.setTimeout(() => window.api.ptyResize(ptyId, term.cols, term.rows), SETTLE_MS);
    };
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(resize);
    });
    ro.observe(ref.current);
    resize();
    // Re-fit once layout/fonts have settled so column count accounts for the
    // reserved scrollbar gutter (prevents text drawing under the scrollbar).
    const fonts = setTimeout(resize, 60);

    return () => {
      clearTimeout(fonts); clearTimeout(settle); cancelAnimationFrame(raf);
      offData(); offExit(); ro.disconnect(); term.dispose();
    };
  }, [ptyId]);

  return <div className="terminal" ref={ref} style={{ width: '100%', height: '100%' }} />;
}
