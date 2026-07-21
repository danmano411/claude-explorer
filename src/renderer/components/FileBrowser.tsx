import { useEffect, useMemo, useRef, useState } from 'react';
import type { DirEntry } from '../../shared/types';
import { sameDrive, winBasename, winDirname } from '../../shared/pathutil';
import { emptySelection, applyClick, type Selection } from '../selection';
import { initHistory, canBack, canForward, navigate, goBack, goForward } from '../history';
import { renameCmd, moveCmd, copyCmd, mkdirCmd, newFileCmd, deleteCmd, type Command } from '../undo';
import { useAppState } from '../appstate';
import { NavBar } from './NavBar';
import { StatusBar } from './StatusBar';
import { ContextMenu, type MenuItem } from './ContextMenu';

export function FileBrowser({ cwd, tabId, onNavigate, onOpenClaude, onOpenExternal }: {
  cwd: string;
  tabId: string;
  onNavigate: (p: string) => void;
  onOpenClaude: (p: string) => void;
  onOpenExternal: (p: string) => void;
}) {
  const app = useAppState();
  const [history, setHistory] = useState(() => initHistory(cwd));
  const dir = history.current;
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [selection, setSelection] = useState<Selection>(emptySelection());
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null);
  const [confirmDel, setConfirmDel] = useState<string[] | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const dragButton = useRef(0);

  const notify = (m: string) => { setToast(m); setTimeout(() => setToast(''), 2500); };

  const selectedPaths = useMemo(
    () => [...selection.indices].sort((a, b) => a - b).map((i) => entries[i]).filter(Boolean).map((e) => e.path),
    [selection, entries]
  );

  const load = () => { window.api.fsList(dir).then(setEntries).catch(() => setEntries([])); };

  // load list when directory changes
  useEffect(() => { window.api.fsList(dir).then(setEntries).catch(() => setEntries([])); setSelection(emptySelection()); }, [dir]);
  // sync from external cwd changes (App / spring-load)
  useEffect(() => { if (cwd !== dir) setHistory((h) => navigate(h, cwd)); }, [cwd]);
  // report effective dir upward
  useEffect(() => { if (dir !== cwd) onNavigate(dir); }, [dir]);

  const nav = (p: string) => setHistory((h) => navigate(h, p));
  const refresh = () => load();

  const runGuarded = async (paths: string[], cmd: Command) => {
    try { await app.withGuard(paths, () => app.undo.run(cmd)); }
    catch { notify('That item is busy — try again in a moment.'); throw new Error('busy'); }
  };

  const paste = async (destDir: string) => {
    const cb = app.clipboard;
    if (!cb || !cb.paths.length) return;
    for (const src of cb.paths) {
      const cmd = cb.mode === 'copy' ? copyCmd(src, destDir) : moveCmd(src, destDir);
      try { await runGuarded([src, destDir], cmd); } catch { return; }
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
    try { await runGuarded([r.path], renameCmd(r.path, dest)); } catch { return; }
    load();
  };

  const createThenRename = async (make: () => Command) => {
    const before = new Set(entries.map((e) => e.path));
    try { await runGuarded([dir], make()); } catch { return; }
    const list = await window.api.fsList(dir);
    setEntries(list);
    const created = list.find((e) => !before.has(e.path));
    if (created) setRenaming({ path: created.path, value: created.name });
  };
  const newFolder = () => createThenRename(() => mkdirCmd(dir, 'New folder'));
  const newFile = () => createThenRename(() => newFileCmd(dir, 'New file'));

  const doDelete = async () => {
    const paths = confirmDel; setConfirmDel(null);
    if (!paths?.length) return;
    try { await runGuarded(paths, deleteCmd(paths)); } catch { return; }
    setSelection(emptySelection()); load();
  };

  const doUndo = async () => { await app.undo.undo(); load(); };
  const doRedo = async () => { await app.undo.redo(); load(); };

  // move-vs-copy drop, one command per path
  const runDrop = async (paths: string[], destFolder: string, ev: { ctrlKey: boolean; shiftKey: boolean }, forced?: 'move' | 'copy') => {
    if (paths.some((p) => app.isBusy(p)) || app.isBusy(destFolder)) { notify('That item is busy — drop refused.'); return; }
    for (const src of paths) {
      const mode = forced ?? ((ev.ctrlKey || !sameDrive(src, destFolder)) ? 'copy' : 'move');
      // dropping into the folder an item already lives in is a no-op for a move
      if (mode === 'move' && winDirname(src) === destFolder) continue;
      const cmd = mode === 'copy' ? copyCmd(src, destFolder) : moveCmd(src, destFolder);
      try { await runGuarded([src, destFolder], cmd); } catch { return; }
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
      { label: 'Open', onClick: () => (isDir ? nav(entry.path) : window.api.openPath(entry.path)) },
    ];
    if (isDir) {
      items.push({ label: 'Open in Claude', onClick: () => onOpenClaude(entry.path) });
      items.push({ label: 'Open in external terminal', onClick: () => onOpenExternal(entry.path) });
    }
    items.push({ separator: true });
    items.push({ label: 'Cut', onClick: () => app.setClipboard({ mode: 'cut', paths }) });
    items.push({ label: 'Copy', onClick: () => app.setClipboard({ mode: 'copy', paths }) });
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
      const tag = (e.target as HTMLElement).tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA';
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); setHistory(goBack); return; }
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); setHistory(goForward); return; }
      if (e.key === 'F5') { e.preventDefault(); refresh(); return; }
      if (typing) return;
      if (e.key === 'Backspace') { e.preventDefault(); nav(winDirname(dir)); return; }
      if (e.ctrlKey && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); setSelection({ anchor: 0, indices: new Set(entries.map((_, i) => i)) }); return; }
      if (e.key === 'Escape') { setSelection(emptySelection()); setMenu(null); return; }
      if (e.ctrlKey && (e.key === 'x' || e.key === 'X')) { if (selectedPaths.length) app.setClipboard({ mode: 'cut', paths: selectedPaths }); return; }
      if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) { if (selectedPaths.length) app.setClipboard({ mode: 'copy', paths: selectedPaths }); return; }
      if (e.ctrlKey && (e.key === 'v' || e.key === 'V')) { paste(dir); return; }
      if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); doUndo(); return; }
      if (e.ctrlKey && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); doRedo(); return; }
      if (e.ctrlKey && e.shiftKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); newFolder(); return; }
      if (e.key === 'F2') { if (selectedPaths.length === 1) { const p = selectedPaths[0]; setRenaming({ path: p, value: winBasename(p) }); } return; }
      if (e.key === 'Delete') { if (selectedPaths.length) setConfirmDel(selectedPaths); return; }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [dir, entries, selectedPaths, app.clipboard]);

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
      <ul
        className={['entries', app.drag && dropTarget === dir ? 'dir-drop' : ''].join(' ').trim()}
        onContextMenu={(ev) => { ev.preventDefault(); setMenu({ x: ev.clientX, y: ev.clientY, items: buildMenu(undefined, []) }); }}
        onDragOver={(ev) => { if (app.drag) { ev.preventDefault(); setDropTarget(dir); } }}
        onDragLeave={(ev) => { if (ev.currentTarget === ev.target) setDropTarget((t) => (t === dir ? null : t)); }}
        onDrop={(ev) => { ev.preventDefault(); setDropTarget(null); dropInto(dir, ev); }}
      >
        {entries.map((e, i) => {
          const selected = selection.indices.has(i);
          return (
            <li
              key={e.path}
              draggable
              className={[selected ? 'entry selected' : 'entry', dropTarget === e.path ? 'drop-target' : ''].join(' ').trim()}
              onMouseDown={(ev) => { dragButton.current = ev.button; }}
              onClick={(ev) => setSelection((s) => applyClick(s, i, { ctrl: ev.ctrlKey, shift: ev.shiftKey }))}
              onDoubleClick={() => (e.isDirectory ? nav(e.path) : window.api.openPath(e.path))}
              onContextMenu={(ev) => {
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
                <span className="entry-label">{e.isDirectory ? '📁' : '📄'} {e.name}</span>
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
      </ul>
      <StatusBar count={entries.length} selected={selection.indices.size} />
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
      {confirmDel && (
        <div className="modal-backdrop" onClick={() => setConfirmDel(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <p>Delete {confirmDel.length} item(s)? They can be restored with Ctrl+Z or from the Recycle Bin.</p>
            <div className="modal-actions">
              <button className="danger" onClick={doDelete}>Delete</button>
              <button onClick={() => setConfirmDel(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
