import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { spaceIndex } from '../keys';

/** Quiet time after which a moving size is treated as finished. */
const SETTLE_MS = 120;
/** ...but a size is never withheld from the pty for longer than this. */
const MAX_HOLD_MS = 250;

export function Terminal({ ptyId, kind }: { ptyId: string; kind?: 'claude' | 'shell' }) {
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

    // KAN-58. Returning false from here tells xterm to skip ITS OWN key handling
    // and nothing more — xterm's `_keyDown` returns before the `cancel(e, true)`
    // its normal Ctrl+letter path ends in, so the BROWSER default still runs.
    // Every arm below therefore calls preventDefault, and a new arm that returns
    // false without one has to say why: dropping it is what produced both bugs
    // in this ticket, each through a different xterm DOM listener.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      // Ctrl+V / Ctrl+Shift+V paste the clipboard (xterm otherwise sends ^V to the shell).
      // term.paste respects bracketed-paste mode, matching right-click paste.
      // preventDefault: otherwise Chromium runs its own Paste on the focused
      // helper textarea, xterm's native "paste" listener pastes a second time
      // (it stopPropagations but never preventDefaults), and the pty receives two
      // complete — separately bracketed — runs.
      if (e.ctrlKey && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        // KAN-60. An image on the clipboard is not bytes a pty can carry, and it
        // does not have to be: Claude Code reads the Windows clipboard ITSELF (a
        // Rust NAPI module in claude.exe calling OpenClipboard /
        // IsClipboardFormatAvailable / GetClipboardData), and that works
        // unchanged as a ConPTY child. So we send it its own paste keystroke and
        // it does the decoding — no pixels through IPC, no temp files, no
        // cleanup story. Measured: PNG -> "[Image #1]", and the model reads the
        // right image back.
        //
        // ptyWrite and not term.paste: this is a KEYSTROKE, not pasted text.
        // Bracketing it would make Claude treat the two bytes as literal text.
        //
        // ASSUMPTION, not a constant: ESC + "v" is alt+v on the wire, which is
        // Claude Code's Windows binding for chat:imagePaste. It was read out of
        // v2.1.220's bundled keymap (ctrl+v is unbound there) and keybindings
        // are now user-editable, so a user who rebinds it gets nothing here.
        //
        // GATED ON A CLAUDE TAB, deliberately. In a shell ESC + "v" is not a
        // harmless no-op: PSReadLine binds Escape to RevertLine, so it would
        // wipe whatever the user had typed and then insert a literal "v".
        // Falling through to the text path instead makes a shell's Ctrl+V with
        // an image on the clipboard do nothing at all, which is the honest
        // answer — nothing in a shell can consume a bitmap.
        //
        // AND GATED ON THERE BEING NO TEXT, which bites more often than the tab
        // kind does. "There is an image on the clipboard" is not "the user
        // wanted to paste an image": Excel, Word and PowerPoint all put a bitmap
        // of the selection there ALONGSIDE its text, so asking `hasImage` first
        // turns an ordinary text paste into an image paste and drops the text
        // with nothing on screen to say so. Text first means this branch fires
        // only where the image is the ONLY thing on offer — a screenshot, a
        // "Copy image" — so KAN-60 adds a path and regresses none. The mixed
        // case is not lost either: Alt+V already reaches Claude Code as ESC v
        // through xterm's own alt handling, with no code of ours involved.
        const text = window.api.clipboardReadText();
        if (!text && kind !== 'shell' && window.api.clipboardHasImage()) {
          window.api.ptyWrite(ptyId, '\u001bv');
          return false;
        }
        if (text) term.paste(text);
        return false;
      }
      // Ctrl/Shift+Enter insert a newline (LF) instead of submitting; plain Enter
      // still sends CR (submit). Mirrors the external terminal's behavior.
      // preventDefault: an un-cancelled keydown still yields a keypress, and
      // xterm's keypress handler sends charCode 13. Measured before the fix,
      // Shift+Enter put "\n" then "\r" on the wire — a newline AND a submit.
      // (Ctrl+Enter escaped it only because that handler ignores ctrl-modified
      // keypresses, which is exactly the kind of accident not to rely on.)
      if (e.key === 'Enter' && (e.ctrlKey || e.shiftKey)) {
        e.preventDefault();
        window.api.ptyWrite(ptyId, '\n');
        return false;
      }
      // KAN-59. Ctrl+1..9 belongs to the app (switch space), so the terminal must
      // not put a byte on the wire for it. Three of the nine already send nothing
      // in xterm 6.0.0; the other six do (common/input/Keyboard.ts, ctrl-only
      // branch): keyCode 51..55 -> ESC/FS/GS/RS/US and 56 -> DEL. Taking all nine
      // costs only those six, and none of them is the only way to type its code:
      // Ctrl+[ sends ESC from the same table and the Escape key exists, Ctrl+4..7's
      // separators are effectively never typed, and DEL has both Delete and
      // Backspace. Uniform beats a shortcut that works on six digits out of nine.
      //
      // The switch itself is App.tsx's window listener, and has to be — this
      // handler has no idea how many spaces exist. Both halves are load-bearing,
      // and this one does MORE than suppress a byte, which is the part that is
      // easy to get wrong: xterm's `_keyDown` ends the six digits that produce a
      // key in `this.cancel(event, true)`, and `cancel` is preventDefault AND
      // stopPropagation. Its listener is on the helper textarea, i.e. the TARGET
      // phase, strictly before App's bubble-phase window listener — so without
      // this arm Ctrl+3..8 never REACH App at all: the pty gets its ESC and the
      // space does not switch. Measured, by deleting this line and re-running
      // test/harness/paste.mjs §11: "Ctrl+3 ... switches to the third space"
      // goes red along with the byte checks. (Ctrl+1/2/9 produce no key, so
      // xterm does not cancel them and they would still switch — which is what
      // makes a half-fix here look like it works.)
      //
      // `spaceIndex` is the SAME predicate App.tsx switches on, not a second
      // hand-written copy, so the two cannot drift apart. It reads e.key while
      // xterm decides on keyCode; where a layout makes those differ the fallout
      // is at worst today's behaviour (App declines, xterm sends its byte).
      //
      // NO preventDefault, and unlike every arm above that is not an oversight:
      // there is no browser default to cancel. A ctrl-modified digit produces no
      // character, and xterm's own _keyPress bails on ctrlKey regardless — the
      // KAN-58 double-paste came from Chromium's Paste EDITING COMMAND on the
      // focused textarea, which has no Ctrl+digit analogue. Cancelling here
      // would not break App's listener (preventDefault does not stop
      // propagation — stopPropagation does, and this arm exists precisely so
      // xterm's `cancel` never runs); the point is that the handler which
      // DECIDES to act is the one that cancels, and with fewer than n spaces App
      // deliberately declines. paste.mjs §11 asserts both sides of that.
      if (spaceIndex(e) !== null) return false;
      return true;
    });

    // Right-click pastes — the Windows console convention, and the only paste
    // affordance a mouse has here. Only when nothing is selected: xterm's own
    // contextmenu handler has just copied the selection into the hidden helper
    // textarea and selected it, which is what makes Edit > Copy work at all in a
    // terminal, and pasting would be the one action that throws it away. So a
    // right-click on a selection is a no-op, deliberately.
    // term.paste, not ptyWrite, so bracketing matches Ctrl+V.
    //
    // KAN-63, decided: when the application has requested mouse tracking, a
    // right-click puts BOTH the SGR button-2 press/release AND this paste on
    // the wire. Windows Terminal suppresses its own paste in that case, on the
    // grounds that the app asked for the mouse. We deliberately do not. Claude
    // Code requests tracking and does nothing with button-2, and a Claude tab
    // is exactly where a user wants right-click paste — matching Windows
    // Terminal would cost the feature its main use to protect a TUI nobody
    // here runs. Two consequences to know before changing this: `vim -c 'set
    // mouse=a'` in a tab both moves the cursor and pastes, and because xterm
    // forwards mouse events instead of selecting under tracking,
    // `hasSelection()` is always false there — so the selection exception
    // above only ever fires in a plain shell. Revisit if a real mouse TUI
    // becomes a normal thing to run in a tab.
    const el = ref.current;
    const onContextMenu = () => {
      if (term.hasSelection()) return;
      const text = window.api.clipboardReadText();
      if (text) term.paste(text);
    };
    el.addEventListener('contextmenu', onContextMenu);

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
      el.removeEventListener('contextmenu', onContextMenu);
      offData(); offExit(); ro.disconnect(); term.dispose();
    };
    // `kind` is in the deps only so the Ctrl+V arm cannot close over a stale
    // one; it is fixed for the life of a tab (set at spawn, restored by
    // fromPersisted), so this never actually re-runs — which matters, because
    // re-running disposes the xterm and that is KAN-23.
  }, [ptyId, kind]);

  return <div className="terminal" ref={ref} style={{ width: '100%', height: '100%' }} />;
}
