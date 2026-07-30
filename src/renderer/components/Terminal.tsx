import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

/** Quiet time after which a moving size is treated as finished. */
const SETTLE_MS = 120;
/** ...but a size is never withheld from the pty for longer than this. */
const MAX_HOLD_MS = 250;

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
    // a test driver does not share the page's world. `data-pty` is here so the
    // two halves can be matched up per terminal: the IPC messages are keyed by
    // ptyId and with a split there is more than one sender.
    const mirror = () => {
      if (!ref.current) return;
      ref.current.dataset.pty = ptyId;
      ref.current.dataset.cols = String(term.cols);
      ref.current.dataset.rows = String(term.rows);
    };
    term.onResize(mirror);
    mirror();

    // A hidden tab has no layout box; fitting to it would compute nonsense
    // cols/rows and resize the pty to match. The ResizeObserver fires again
    // when the tab is shown, so skipping here loses nothing.
    //
    // KAN-50: the fit still runs every frame so the grid tracks the box live,
    // but the pty is told far fewer sizes than the grid passes through.
    //
    // Every `ptyResize` is a `ResizePseudoConsole`, and ConPTY answers one by
    // re-emitting its whole screen buffer at that width. A drag used to produce
    // one per animation frame — ~30 for a one-second drag — and a TUI that
    // samples its own width per render (Claude Code does) can read one width
    // while ConPTY's buffer has already moved to the next, so the frame it draws
    // is wrapped to a column count the viewport no longer has: text clipped
    // mid-word at the left edge, overshooting the right. There is no SIGWINCH on
    // Windows and no further resize is coming, so nothing re-renders it and it
    // stays wrong until something else resizes the pane — which is exactly why
    // switching tabs and back "fixed" it. Coalescing is therefore a correctness
    // fix, not just a flooding one.
    //
    // Three rules, and the first two are why this is not a plain debounce:
    //
    //  - LEADING EDGE. A pty is spawned at 80x24 (`PtyManager.spawn`) and a TUI
    //    paints its first frame at whatever it reads. Withholding the very first
    //    size for even one settle interval reproduces the bug at startup, so the
    //    first size a pty is ever told is sent synchronously.
    //  - MAX HOLD. While a size is being withheld the pty is on the PREVIOUS
    //    one, so an unbounded trailing timer would guarantee the desync for the
    //    whole of every drag. After MAX_HOLD_MS the current size goes out.
    //  - TRAILING. Otherwise one send once the size has been quiet for
    //    SETTLE_MS — longer than a frame (a drag fires every ~8-16ms), shorter
    //    than a person letting go.
    //
    // What this does NOT claim: that only resting sizes reach the pty. A drag
    // slower than MAX_HOLD_MS, or one the user pauses mid-way, sends an
    // intermediate width — deliberately. A width the terminal has held for
    // >=120ms is a width the user is looking at and the pty should have it.
    // The guarantee is only that the LAST size sent is always the resting one
    // and that a burst costs a handful of resizes instead of one per frame.
    let raf = 0;
    let settle = 0;
    let heldSince = 0;
    let told = false;
    const send = () => {
      clearTimeout(settle);
      settle = 0;
      told = true;
      window.api.ptyResize(ptyId, term.cols, term.rows);
    };
    const resize = () => {
      if (!ref.current?.clientHeight) return;
      fit.fit();
      if (!told) return send();
      if (!settle) heldSince = Date.now();
      else if (Date.now() - heldSince >= MAX_HOLD_MS) return send();
      clearTimeout(settle);
      settle = window.setTimeout(send, SETTLE_MS);
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
