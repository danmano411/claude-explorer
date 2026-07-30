import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

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

    // A hidden tab has no layout box; fitting to it would compute nonsense
    // cols/rows and resize the pty to match. The ResizeObserver fires again
    // when the tab is shown, so skipping here loses nothing.
    const resize = () => {
      if (!ref.current?.clientHeight) return;
      fit.fit();
      window.api.ptyResize(ptyId, term.cols, term.rows);
    };
    // Coalesced to one fit per animation frame. This is a FLOODING fix, not a
    // correctness one — resize() was already idempotent and every fire produced
    // the right size. But a split-view divider drag (KAN-46) re-writes the grid
    // template on every pointermove, so this observer fires ~8x per drag and
    // each fire was one more `ptyResize` IPC and one more ConPTY screen-buffer
    // resize. One per frame is all a 60Hz drag can show.
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(resize);
    });
    ro.observe(ref.current);
    resize();
    // Re-fit once layout/fonts have settled so column count accounts for the
    // reserved scrollbar gutter (prevents text drawing under the scrollbar).
    const settle = setTimeout(resize, 60);

    return () => {
      clearTimeout(settle); cancelAnimationFrame(raf);
      offData(); offExit(); ro.disconnect(); term.dispose();
    };
  }, [ptyId]);

  return <div className="terminal" ref={ref} style={{ width: '100%', height: '100%' }} />;
}
