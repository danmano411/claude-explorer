import { useEffect, useMemo, useRef, useState } from 'react';
import type { DirEntry, FileMode, GitStatusResult, TrashWarn } from '../../shared/types';
import { sameDrive, winBasename, winDirname } from '../../shared/pathutil';
import { emptySelection, applyClick, type Selection } from '../selection';
import { initHistory, canBack, canForward, navigate, goBack, goForward } from '../history';
import { renameCmd, moveCmd, copyCmd, mkdirCmd, newFileCmd, deleteCmd, OpError, type Command } from '../undo';
import { unwrap, type ConfirmRequest } from '../opresult';
import { gutterMarks, markKey, type GutterMark } from '../diffparse';
import { IDLE_MS } from '../ptystatus';
import { isTypingTarget } from '../keys';
import { useAppState, type Clipboard } from '../appstate';
import { NavBar } from './NavBar';
import { StatusBar } from './StatusBar';
import { ConfirmDialog } from './ConfirmDialog';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { SearchOverlay } from './SearchOverlay';

/** A command factory: the confirm word is baked in at build time, so a retry is
 *  just "build the same command again, this time with the typed word". */
type CommandFactory = (confirm?: string) => Command;

/** Per-(tab, folder) scroll offsets, outliving the component so a remount or a
 *  tab switch can restore them. ponytail: unbounded map — a session would have to
 *  visit ~100k distinct folders to matter; add an LRU cap if that ever changes. */
const scrollOffsets = new Map<string, number>();

/** Gutter marker: git's own letters, so the meaning transfers straight to the
 *  terminal next door. '·' is a folder that merely contains changes. */
// KAN-32: worded so it does not read as data loss — it is not. The items are
// still on disk, staged, and main retries them automatically.
const trashWarnMessage = (w: TrashWarn): string =>
  `${w.count} item${w.count === 1 ? '' : 's'}${w.volume ? ` on ${w.volume}` : ''} could not be moved to the Recycle Bin — they will be retried next launch.`;

const MARK: Record<GutterMark, [glyph: string, title: string]> = {
  modified: ['M', 'Modified'],
  added: ['A', 'Added (staged)'],
  deleted: ['D', 'Deleted'],
  untracked: ['U', 'New — not tracked by Git yet'],
  renamed: ['R', 'Renamed'],
  contains: ['·', 'Contains changes'],
};

export function FileBrowser({ cwd, tabId, focused, onNavigate, onOpenClaude, onOpenExternal, onOpenFile }: {
  cwd: string;
  tabId: string;
  // KAN-62 finding #1. Split view mounts one FileBrowser per visible pane, and
  // each registers its OWN window-level keydown listener — without this guard
  // EVERY pane's listener fires on a single Ctrl+C, and the last one mounted
  // wins, deterministically overwriting the real OS clipboard (and the in-app
  // one) with whichever pane ISN'T the one the user is looking at. `focused`
  // is `App.tsx`'s single derived focus truth (`t.id === active`) passed down,
  // not a second copy of it — see App.tsx's "THE FOCUSED PANE IS DERIVED".
  focused: boolean;
  onNavigate: (p: string) => void;
  onOpenClaude: (p: string) => void;
  onOpenExternal: (p: string) => void;
  onOpenFile: (p: string, mode?: 'file' | 'diff') => void;
}) {
  const app = useAppState();
  const [history, setHistory] = useState(() => initHistory(cwd));
  const dir = history.current;
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [listError, setListError] = useState('');
  const [mode, setMode] = useState<FileMode>('explorer');
  const [selection, setSelection] = useState<Selection>(emptySelection());
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null);
  const [confirmDel, setConfirmDel] = useState<string[] | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const [searching, setSearching] = useState(false);
  const [git, setGit] = useState<GitStatusResult | null>(null);
  const noGit = useRef(false); // plain folder / git missing: stop asking
  const dragButton = useRef(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Scroll offset belongs to the tab, not to the <ul>. React reuses that DOM node
  // between two file tabs, so without this the newly activated tab inherits the
  // other tab's scrollTop. Keyed by tab AND folder, so walking into a subfolder
  // starts at the top while walking back restores where you were. KAN-25.
  const listRef = useRef<HTMLUListElement>(null);
  const scrollKey = `${tabId}\0${dir}`;
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = scrollOffsets.get(scrollKey) ?? 0;
  }, [scrollKey]);

  // Policy refusals are longer than "busy" chatter, so they get more time on screen.
  const notify = (m: string, ms = 2500) => {
    clearTimeout(toastTimer.current);
    setToast(m);
    toastTimer.current = setTimeout(() => setToast(''), ms);
  };

  // Explorer mode hides the noise; Developer mode shows everything. Indices used
  // by selection/keyboard address THIS list, never the unfiltered one.
  const shown = useMemo(
    () => (mode === 'developer' ? entries : entries.filter((e) => !e.hidden)),
    [entries, mode]
  );

  const selectedPaths = useMemo(
    () => [...selection.indices].sort((a, b) => a - b).map((i) => shown[i]).filter(Boolean).map((e) => e.path),
    [selection, shown]
  );

  const applyList = (r: Awaited<ReturnType<typeof window.api.fsList>>) => {
    if (r.ok) { setEntries(r.entries); setListError(''); }
    else { setEntries([]); setListError(r.reason); }
  };
  const load = () => {
    window.api.fsList(dir).then(applyList).catch((err) => {
      setEntries([]);
      setListError(err instanceof Error ? err.message : 'Could not read this folder');
    });
  };

  // Git status drives the row gutter. A non-repo folder is a normal state: no
  // gutter, no message, and (via noGit) no further spawns while we sit here.
  const loadGit = () => {
    window.api.gitStatus(dir)
      .then((r) => {
        setGit(r);
        if (!r.ok && r.kind !== 'error') noGit.current = true;
      })
      .catch(() => setGit(null));
  };

  // load list when directory changes
  useEffect(() => { load(); setSelection(emptySelection()); }, [dir]);
  useEffect(() => { noGit.current = false; setGit(null); loadGit(); }, [dir]);

  /**
   * Freshness: Claude edits files WHILE you watch, so a gutter that only moves on
   * F5 answers the wrong question. pty:data is broadcast for every terminal, so
   * "the machine went quiet" is signal enough — re-read git status IDLE_MS after
   * the last byte (the same debounce the tab status dots use). Deliberately not a
   * timer: no output, no git spawn, forever.
   *
   * ponytail: ANY terminal's idle refreshes this tab, even one working in an
   * unrelated folder — one cheap git call beats correlating pty cwds. Correlate
   * if a busy session ever makes the listing feel jumpy.
   */
  // A file Claude CREATES has no row to mark until the listing is re-read, so
  // the idle tick reloads that too — but only when nothing is in flight, since
  // selection indices address `shown` and a reload would move them under a
  // drag, a rename, or an open dialog. Read through a ref: the pty subscription
  // is mounted per-directory and must not re-subscribe on every keystroke.
  const idleReloadSafe = useRef(true);
  idleReloadSafe.current =
    !renaming && !menu && !confirmDel && !confirmRequest && !app.drag && selection.indices.size === 0;

  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = window.api.onPtyData(() => {
      if (noGit.current) return;
      clearTimeout(t);
      t = setTimeout(() => { loadGit(); if (idleReloadSafe.current) load(); }, IDLE_MS);
    });
    return () => { off(); clearTimeout(t); };
  }, [dir]);

  const marks = useMemo(
    () => (git?.ok ? gutterMarks(git.files) : new Map<string, GutterMark>()),
    [git]
  );
  // Deleted files have no row to mark — they are gone from disk — but "Claude
  // deleted this" is the change you most want to see, so they get a ghost row.
  const deletedHere = useMemo(
    () => (git?.ok
      ? git.files.filter((f) => f.status === 'deleted' && markKey(winDirname(f.path)) === markKey(dir))
      : []),
    [git, dir]
  );
  const gutter = (p: string) => {
    if (!git?.ok) return null; // not a repo: no gutter at all
    const m = marks.get(markKey(p));
    return <span className={m ? `gutter g-${m}` : 'gutter'} title={m ? MARK[m][1] : undefined}>{m ? MARK[m][0] : ''}</span>;
  };
  // sync from external cwd changes (App / spring-load)
  useEffect(() => { if (cwd !== dir) setHistory((h) => navigate(h, cwd)); }, [cwd]);
  // report effective dir upward
  useEffect(() => { if (dir !== cwd) onNavigate(dir); }, [dir]);

  // mode is persisted in main; the status-bar button and the menu share one path
  useEffect(() => { window.api.settingsGet().then((s) => setMode(s.mode)); }, []);
  const toggleMode = () => {
    const next: FileMode = mode === 'developer' ? 'explorer' : 'developer';
    setMode(next);
    setSelection(emptySelection()); // indices address `shown`, which just changed
    void window.api.settingsSet({ mode: next });
  };
  useEffect(
    () => window.api.onMenuCommand((cmd) => { if (cmd === 'toggle-mode') toggleMode(); }),
    [mode]
  );

  // Startup retry (or a quit-time flush) couldn't reach the Recycle Bin. Not
  // data loss — say so — the items are staged on disk and main retries them.
  useEffect(() => window.api.onTrashWarn((warn) => notify(trashWarnMessage(warn), 6000)), []);

  const nav = (p: string) => setHistory((h) => navigate(h, p));
  const refresh = () => { load(); noGit.current = false; loadGit(); };

  /** Runs a command through the busy guard and the undo stack. Returns false
   *  (without pushing anything onto the stack) when main refused it. */
  const runGuarded = async (paths: string[], make: CommandFactory, confirm?: string): Promise<boolean> => {
    try {
      await app.withGuard(paths, () => app.undo.run(make(confirm)));
      return true;
    } catch (err) {
      if (err instanceof OpError) {
        const r = err.result;
        if (r.code === 'NEEDS_CONFIRM') {
          setConfirmRequest({
            reason: r.reason,
            typed: r.typed,
            confirm: async (word: string) => { if (await runGuarded(paths, make, word)) load(); },
          });
        } else notify(r.reason, 6000);
      } else notify('That item is busy — try again in a moment.');
      return false;
    }
  };

  // KAN-62. The in-app clipboard already drives this pane's own Paste; this
  // ALSO puts the absolute path(s) on the real OS clipboard as text, one per
  // line, so a subsequent Ctrl+V into a Claude tab (or any other text field)
  // carries something.
  //
  // Finding #2: clipboard.writeText() REPLACES the whole OS clipboard, every
  // format on it, not just adds text/plain. Our own Copy/Cut never put
  // anything else there, but a REAL Windows Explorer copy might already be
  // sitting on the clipboard (CF_HDROP, surfaced to us as a 'text/uri-list'-ish
  // format) — measured: writeText silently destroys it, and Electron cannot
  // read the raw CF_HDROP bytes back out to restore them (writeBuffer of what
  // readBuffer('text/uri-list') returns writes 0 bytes and wipes everything).
  // So when one is already there we leave the OS clipboard alone rather than
  // clobber a pending real Explorer paste; this pane's own Paste still works
  // either way because it drives off the in-app clipboard, not the OS one.
  const setClip = (c: NonNullable<Clipboard>) => {
    app.setClipboard(c);
    if (!window.api.clipboardHasFileDrop()) window.api.clipboardWriteText(c.paths.join('\n'));
  };

  const paste = async (destDir: string) => {
    const cb = app.clipboard;
    if (!cb || !cb.paths.length) return;
    for (const src of cb.paths) {
      const make: CommandFactory = cb.mode === 'copy'
        ? (c) => copyCmd(src, destDir, c)
        : (c) => moveCmd(src, destDir, c);
      if (!(await runGuarded([src, destDir], make))) return;
    }
    if (cb.mode === 'cut') app.setClipboard(null);
    load();
  };

  const commitRename = async () => {
    const r = renaming; setRenaming(null);
    if (!r) return;
    const name = r.value.trim();
    if (!name || name === winBasename(r.path)) return;
    const dest = winDirname(r.path) + '\\' + name;
    if (!(await runGuarded([r.path], (c) => renameCmd(r.path, dest, c)))) return;
    load();
  };

  const createThenRename = async (make: CommandFactory) => {
    const before = new Set(entries.map((e) => e.path));
    if (!(await runGuarded([dir], make))) return;
    const list = await window.api.fsList(dir);
    applyList(list);
    if (!list.ok) return;
    const created = list.entries.find((e) => !before.has(e.path));
    if (created) setRenaming({ path: created.path, value: created.name });
  };
  const newFolder = () => createThenRename((c) => mkdirCmd(dir, 'New folder', c));
  const newFile = () => createThenRename((c) => newFileCmd(dir, 'New file', c));

  const doDelete = async () => {
    // The dialog clears `confirmDel` itself, once this settles — so the modal
    // stays up for the duration of the delete instead of vanishing and leaving
    // the list looking untouched until the op lands.
    const paths = confirmDel;
    if (!paths?.length) return;
    if (!(await runGuarded(paths, (c) => deleteCmd(paths, c)))) return;
    setSelection(emptySelection()); load();
  };

  // A rejected undo leaves the stack intact (see UndoStack) — surface it and
  // still refresh, so the view never disagrees with disk.
  const runUndoRedo = async (fn: () => Promise<void>) => {
    try { await fn(); }
    catch (err) { notify(err instanceof OpError ? err.result.reason : 'Could not undo that — try again.', 6000); }
    load();
  };
  const doUndo = () => runUndoRedo(() => app.undo.undo());
  const doRedo = () => runUndoRedo(() => app.undo.redo());

  // move-vs-copy drop, one command per path
  const runDrop = async (paths: string[], destFolder: string, ev: { ctrlKey: boolean; shiftKey: boolean }, forced?: 'move' | 'copy') => {
    if (paths.some((p) => app.isBusy(p)) || app.isBusy(destFolder)) { notify('That item is busy — drop refused.'); return; }
    for (const src of paths) {
      const kind = forced ?? ((ev.ctrlKey || !sameDrive(src, destFolder)) ? 'copy' : 'move');
      // dropping into the folder an item already lives in is a no-op for a move
      if (kind === 'move' && winDirname(src) === destFolder) continue;
      const make: CommandFactory = kind === 'copy'
        ? (c) => copyCmd(src, destFolder, c)
        : (c) => moveCmd(src, destFolder, c);
      if (!(await runGuarded([src, destFolder], make))) return;
    }
    app.setDrag(null);
    load();
  };

  // Shared drop entry point (used by folder rows AND the open-folder background → dir).
  const dropInto = (dest: string, ev: React.DragEvent) => {
    const payload = app.drag;
    if (!payload || !payload.paths.length) return;
    const paths = payload.paths;
    if (dragButton.current === 2) {
      setMenu({
        x: ev.clientX, y: ev.clientY, items: [
          { label: 'Move here', onClick: () => runDrop(paths, dest, ev, 'move') },
          { label: 'Copy here', onClick: () => runDrop(paths, dest, ev, 'copy') },
          { separator: true },
          { label: 'Cancel', onClick: () => app.setDrag(null) },
        ],
      });
    } else {
      runDrop(paths, dest, { ctrlKey: ev.ctrlKey, shiftKey: ev.shiftKey });
    }
  };

  const buildMenu = (entry: DirEntry | undefined, paths: string[]): MenuItem[] => {
    const canPaste = !!app.clipboard && app.clipboard.paths.length > 0;
    if (!entry) {
      return [
        { label: 'Paste', onClick: () => paste(dir), disabled: !canPaste },
        { separator: true },
        { label: 'New Folder', onClick: newFolder },
        { label: 'New File', onClick: newFile },
        { separator: true },
        { label: 'Reveal in File Explorer', onClick: () => window.api.revealPath(dir) },
      ];
    }
    const isDir = entry.isDirectory;
    const items: MenuItem[] = [
      { label: 'Open', onClick: () => (isDir ? nav(entry.path) : onOpenFile(entry.path)) },
    ];
    if (isDir) {
      items.push({ label: 'Open in Claude', onClick: () => onOpenClaude(entry.path) });
      items.push({ label: 'Open in external terminal', onClick: () => onOpenExternal(entry.path) });
    } else {
      // Only offered when there is something to diff — a clean or untracked file
      // would open a tab that says "no changes", which is a wasted click.
      const m = marks.get(markKey(entry.path));
      if (m && m !== 'untracked' && m !== 'contains') {
        items.push({ label: 'Show changes', onClick: () => onOpenFile(entry.path, 'diff') });
      }
      items.push({ label: 'Open in default app', onClick: () => window.api.openPath(entry.path) });
    }
    items.push({ separator: true });
    items.push({ label: 'Cut', onClick: () => setClip({ mode: 'cut', paths }) });
    items.push({ label: 'Copy', onClick: () => setClip({ mode: 'copy', paths }) });
    items.push({ label: 'Paste', onClick: () => paste(entry.path), disabled: !canPaste || !isDir });
    items.push({ separator: true });
    if (paths.length === 1) items.push({ label: 'Rename', onClick: () => setRenaming({ path: entry.path, value: entry.name }) });
    items.push({ label: 'Delete', onClick: () => setConfirmDel(paths) });
    items.push({ separator: true });
    items.push({ label: 'New Folder', onClick: newFolder });
    items.push({ label: 'New File', onClick: newFile });
    items.push({ separator: true });
    items.push({ label: 'Reveal in File Explorer', onClick: () => window.api.revealPath(entry.path) });
    return items;
  };

  // keyboard shortcuts
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      // KAN-62 finding #1: this listener is window-level and every visible
      // pane in a split mounts one, so without this every keystroke would
      // otherwise reach ALL of them — Ctrl+C in the pane you're looking at
      // would also fire in the other pane, last-mounted wins, and the wrong
      // file's path lands on the OS clipboard (and gets pasted into Claude).
      if (!focused) return;
      const typing = isTypingTarget(e.target);
      // KAN-69: these three were ABOVE the `typing` guard (unlike everything
      // below it), so Alt+Left/Alt+Right/F5 fired straight through a focused
      // rename box — or the address bar, or the search box — and navigated the
      // pane out from under whatever was being typed. Unlike Ctrl+F just below,
      // nothing needs these to reach a text field, so they move behind the gate.
      if (!typing) {
        if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); setHistory(goBack); return; }
        if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); setHistory(goForward); return; }
        if (e.key === 'F5') { e.preventDefault(); refresh(); return; }
      }
      // Above the `typing` guard on purpose: Ctrl+F must reach the search box
      // even when a field already has focus, the way every other app behaves.
      if (e.ctrlKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); setSearching(true); return; }
      if (typing) return;
      if (e.key === 'Backspace') { e.preventDefault(); nav(winDirname(dir)); return; }
      if (e.ctrlKey && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); setSelection({ anchor: 0, indices: new Set(shown.map((_, i) => i)) }); return; }
      if (e.key === 'Escape') { setSelection(emptySelection()); setMenu(null); return; }
      if (e.ctrlKey && (e.key === 'x' || e.key === 'X')) { if (selectedPaths.length) setClip({ mode: 'cut', paths: selectedPaths }); return; }
      if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) { if (selectedPaths.length) setClip({ mode: 'copy', paths: selectedPaths }); return; }
      if (e.ctrlKey && (e.key === 'v' || e.key === 'V')) { paste(dir); return; }
      if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); doUndo(); return; }
      if (e.ctrlKey && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); doRedo(); return; }
      if (e.ctrlKey && e.shiftKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); newFolder(); return; }
      if (e.key === 'F2') { if (selectedPaths.length === 1) { const p = selectedPaths[0]; setRenaming({ path: p, value: winBasename(p) }); } return; }
      if (e.key === 'Delete') {
        e.preventDefault();
        const paths = selectedPaths;
        if (!paths.length) return;
        if (e.shiftKey) {
          // Permanent delete bypasses staging and returns [], so there is nothing
          // to restore — deliberately NO undo entry. Explorer mode is refused by
          // main; the refusal reason arrives here as a toast.
          void unwrap(
            async (confirm) => {
              const r = await window.api.fsDelete(paths, { permanent: true, confirm });
              if (r.ok) { setSelection(emptySelection()); load(); } // also covers the confirmed retry
              return r;
            },
            (m) => notify(m, 6000),
            setConfirmRequest,
          );
          return;
        }
        setConfirmDel(paths);
        return;
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [dir, shown, selectedPaths, app.clipboard, focused]);

  return (
    <div className="filebrowser">
      <NavBar
        cwd={dir}
        canBack={canBack(history)}
        canForward={canForward(history)}
        onBack={() => setHistory(goBack)}
        onForward={() => setHistory(goForward)}
        onRefresh={refresh}
        onNavigate={nav}
      />
      {searching && (
        <SearchOverlay
          dir={dir}
          entries={shown}
          mode={mode}
          onClose={() => setSearching(false)}
          onOpen={(hit) => {
            setSearching(false);
            if (hit.isDirectory) nav(hit.path);
            else onOpenFile(hit.path);
          }}
        />
      )}
      <ul
        ref={listRef}
        className={['entries', app.drag && dropTarget === dir ? 'dir-drop' : ''].join(' ').trim()}
        onScroll={(ev) => scrollOffsets.set(scrollKey, ev.currentTarget.scrollTop)}
        onContextMenu={(ev) => { ev.preventDefault(); setMenu({ x: ev.clientX, y: ev.clientY, items: buildMenu(undefined, []) }); }}
        onDragOver={(ev) => { if (app.drag) { ev.preventDefault(); setDropTarget(dir); } }}
        onDragLeave={(ev) => { if (ev.currentTarget === ev.target) setDropTarget((t) => (t === dir ? null : t)); }}
        onDrop={(ev) => { ev.preventDefault(); setDropTarget(null); dropInto(dir, ev); }}
      >
        {listError && <li className="empty">{listError}</li>}
        {shown.map((e, i) => {
          const selected = selection.indices.has(i);
          // KAN-69: the rename `<input>` below is a DOM descendant of this row, and
          // it only ever stops propagation for `click` (that event type alone —
          // `dblclick`/`contextmenu`/`dragstart` are each their own DOM event type
          // and bubble straight past a click-only guard). Gating the ROW's props
          // on "is THIS row being renamed" closes every event type at once — the
          // same idiom TabBar already uses for `draggable` — rather than adding
          // another per-event stopPropagation line to the input that the next new
          // event type would just as easily miss again.
          const isRenamingThis = renaming?.path === e.path;
          return (
            <li
              key={e.path}
              draggable={!isRenamingThis}
              className={[selected ? 'entry selected' : 'entry', dropTarget === e.path ? 'drop-target' : ''].join(' ').trim()}
              style={e.hidden ? { opacity: 0.55 } : undefined}
              onMouseDown={(ev) => { dragButton.current = ev.button; }}
              onClick={(ev) => setSelection((s) => applyClick(s, i, { ctrl: ev.ctrlKey, shift: ev.shiftKey }))}
              onDoubleClick={isRenamingThis ? undefined : () => (e.isDirectory ? nav(e.path) : onOpenFile(e.path))}
              onContextMenu={isRenamingThis
                // Swallowed, not left to bubble: the containing <ul> has its OWN
                // onContextMenu (empty-space menu), so simply omitting this handler
                // while renaming would still surface A context menu, just the wrong
                // one.
                ? (ev) => { ev.preventDefault(); ev.stopPropagation(); }
                : (ev) => {
                    ev.preventDefault(); ev.stopPropagation();
                    const inSel = selection.indices.has(i);
                    if (!inSel) setSelection(applyClick(emptySelection(), i, { ctrl: false, shift: false }));
                    const paths = inSel ? selectedPaths : [e.path];
                    setMenu({ x: ev.clientX, y: ev.clientY, items: buildMenu(e, paths) });
                  }}
              onDragStart={(ev) => {
                let paths = selectedPaths;
                if (!selection.indices.has(i)) { setSelection(applyClick(emptySelection(), i, { ctrl: false, shift: false })); paths = [e.path]; }
                app.setDrag({ paths, sourceTabId: tabId });
                ev.dataTransfer.setData('application/x-ce-files', JSON.stringify(paths));
              }}
              onDragOver={(ev) => { if (e.isDirectory && app.drag) { ev.preventDefault(); ev.stopPropagation(); setDropTarget(e.path); } }}
              onDragLeave={() => setDropTarget((t) => (t === e.path ? null : t))}
              onDrop={(ev) => {
                if (!e.isDirectory) return; // fall through to the container (drop into current dir)
                ev.preventDefault(); ev.stopPropagation(); setDropTarget(null);
                dropInto(e.path, ev);
              }}
            >
              {renaming?.path === e.path ? (
                <input
                  className="rename-input"
                  autoFocus
                  value={renaming.value}
                  onChange={(ev) => setRenaming({ path: e.path, value: ev.target.value })}
                  onClick={(ev) => ev.stopPropagation()}
                  onBlur={commitRename}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter') { ev.preventDefault(); commitRename(); }
                    else if (ev.key === 'Escape') { ev.preventDefault(); setRenaming(null); }
                  }}
                />
              ) : (
                <>
                  {gutter(e.path)}
                  <span className="entry-label" title={e.isSymlink ? 'Junction / symlink' : undefined}>
                    {e.isDirectory ? '📁' : '📄'} {e.name}{e.isSymlink ? ' ↗' : ''}
                  </span>
                </>
              )}
              {e.isDirectory && !renaming && (
                <button
                  className="entry-open"
                  title="Open this folder in Claude"
                  onClick={(ev) => { ev.stopPropagation(); onOpenClaude(e.path); }}
                >
                  →
                </button>
              )}
            </li>
          );
        })}
        {/* Rendered AFTER the mapped list on purpose: selection indices address
            `shown`, and a ghost row has no file on disk to act on. */}
        {deletedHere.map((f) => (
          <li
            key={f.path}
            className="entry ghost"
            title="Deleted — no longer on disk. Double-click to see what was removed."
            onDoubleClick={() => onOpenFile(f.path, 'diff')}
          >
            {gutter(f.path)}
            <span className="entry-label">📄 <s>{winBasename(f.path)}</s></span>
          </li>
        ))}
      </ul>
      <StatusBar count={shown.length} selected={selection.indices.size} mode={mode} onToggleMode={toggleMode} />
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
      {/* The shared ConfirmDialog (KAN-57), same as the policy round-trip below
          — this was the third hand-rolled copy of the same markup. */}
      {confirmDel && (
        <ConfirmDialog
          request={{
            reason: `Delete ${confirmDel.length} item(s)? They can be restored with Ctrl+Z or from the Recycle Bin.`,
            confirmLabel: 'Delete',
            confirm: doDelete,
          }}
          onClose={() => setConfirmDel(null)}
        />
      )}
      {confirmRequest && (
        <ConfirmDialog request={confirmRequest} onClose={() => setConfirmRequest(null)} />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
