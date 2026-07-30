import { useEffect, useRef, useState } from 'react';
import {
  newFilesTab, newTerminalTab, newViewerTab, toPersisted, fromPersisted, needsSpawn, type Tab,
} from './tabs';
import { reorder } from './tabreorder';
import { usePtyStatus } from './ptystatus';
import { FileBrowser } from './components/FileBrowser';
import { Terminal } from './components/Terminal';
import { Viewer } from './components/Viewer';
import { DiffView } from './components/DiffView';
import { RecentMenu } from './components/RecentMenu';
import { SettingsModal } from './components/SettingsModal';
import { TabBar } from './TabBar';

const basename = (p: string) => p.split(/[\\/]/).pop() || p;

export function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string>('');
  const [showSettings, setShowSettings] = useState(false);
  const status = usePtyStatus();
  const lastActivated = useRef<Map<string, number>>(new Map());
  const spawning = useRef<Set<string>>(new Set());
  // An argv/Explorer open is APPENDED to whatever restore produces, never
  // merged into it and never allowed to lose to it: the restore effect below
  // ends in a *replacing* setTabs(restored), so a tab added before it resolves
  // would be silently destroyed. Held here until restore has committed.
  const restoreDone = useRef(false);
  const pendingCli = useRef<[string, string] | null>(null); // [cmd, path]

  const selectTab = (id: string) => {
    lastActivated.current.set(id, Date.now());
    setActive(id);
  };

  useEffect(() => {
    (async () => {
      const w = await window.api.workspaceGet();
      const restored = w.tabs.map(fromPersisted).filter((t): t is Tab => t !== null);
      if (restored.length) { setTabs(restored); selectTab(restored[0].id); }
      else {
        const home = await window.api.fsHome();
        const t = newFilesTab(home);
        setTabs([t]); selectTab(t.id);
      }
      // Both branches end in a replacing setTabs, so the gate is flushed here —
      // after restore has committed — on either path.
      restoreDone.current = true;
      const p = pendingCli.current;
      pendingCli.current = null;
      if (p) applyCli(p[0], p[1]);
    })();
  }, []);

  // Give a restored terminal tab its process. Whether the conversation can be
  // resumed depends on something only the disk knows: `--resume` needs a
  // transcript, and a tab closed before its first message has an id but no
  // file, which claude rejects. Passing the same id as `--session-id` instead
  // means the tab keeps its identity either way, so the *next* restart resumes
  // it properly.
  const spawnFor = async (t: Tab): Promise<string> => {
    if (t.terminalKind === 'shell') return window.api.ptySpawn({ path: t.cwd, shell: true });
    const known = t.sessionId
      ? (await window.api.sessionsList(t.cwd)).some((s) => s.id === t.sessionId)
      : false;
    return window.api.ptySpawn({
      path: t.cwd,
      resumeId: known ? t.sessionId : undefined,
      sessionId: known ? undefined : t.sessionId,
    });
  };

  // Restored terminal tabs are spawned on first activation, not all at once at
  // launch — coming back to six Claude sessions should not mean six CLIs racing
  // for the CPU before the window is usable. A failed spawn paints its own error
  // inside the pane (see PtyManager), so a folder that has since been deleted
  // explains itself rather than silently doing nothing.
  useEffect(() => {
    const t = tabs.find((x) => x.id === active);
    if (!t || !needsSpawn(t) || spawning.current.has(t.id)) return;
    spawning.current.add(t.id);
    spawnFor(t)
      .then((ptyId) => update(t.id, { ptyId }))
      .finally(() => spawning.current.delete(t.id));
  }, [active, tabs]);

  // Persist the tab set so a restart puts you back where you were. Debounced:
  // navigating a folder retitles its tab, and writing the whole document on
  // every keystroke-fast state change is pointless churn.
  useEffect(() => {
    if (!tabs.length) return;
    const timer = setTimeout(() => {
      window.api.workspaceGet().then((w) =>
        window.api.workspaceSet({
          ...w,
          tabs: tabs.map(toPersisted),
          spaces: w.spaces.map((s, i) =>
            i === 0 ? { ...s, tabIds: tabs.map((t) => t.id) } : s),
        }));
    }, 400);
    return () => clearTimeout(timer);
  }, [tabs]);

  // Application menu (File/Settings) posts commands; dispatch through a ref so
  // the subscription (mounted once) always calls the latest closures.
  // The CLI / Explorer context menu rides the same fire-and-forget channel the
  // app menu uses (main/index.ts sendPendingCli), with the path in arg 2.
  // There is deliberately NO arm that spawns Claude: an unauthenticated OS
  // caller can only ever reach openFolderTab / openViewerTab from here. See
  // main/cli.ts for the full reasoning — do not add a 'new-session' arm.
  //
  // ponytail: always appends + focuses, never dedupes against an identical
  // restored tab. Two tabs on the same folder is the price; match on cwd and
  // focus the existing one when someone complains.
  const applyCli = (cmd: string, path: string) => {
    if (cmd === 'open-path') openFolderTab(path);
    else if (cmd === 'open-file') openViewerTab(path);
  };

  const menuHandler = useRef<(cmd: string, arg?: string) => void>(() => {});
  menuHandler.current = (cmd, arg) => {
    if (cmd === 'new-tab') addTab();
    else if (cmd === 'close-tab') { if (active) closeTab(active); }
    else if (cmd === 'open-settings') setShowSettings(true);
    else if (arg && (cmd === 'open-path' || cmd === 'open-file')) {
      // Before restore commits, queue: setTabs(restored) would wipe this tab.
      if (!restoreDone.current) { pendingCli.current = [cmd, arg]; return; }
      applyCli(cmd, arg);
    }
  };
  useEffect(() => window.api.onMenuCommand((cmd, arg) => menuHandler.current(cmd, arg)), []);

  const update = (id: string, patch: Partial<Tab>) =>
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  const addTab = async () => {
    const home = await window.api.fsHome();
    const t = newFilesTab(home);
    setTabs((ts) => [...ts, t]); selectTab(t.id);
  };

  const openFolderTab = (p: string) => {
    const t = newFilesTab(p);
    setTabs((ts) => [...ts, t]); selectTab(t.id);
  };

  // Opening a file gets its own first-class tab (never a split pane — a split
  // could not live inside a future tab group). Re-opening the same file focuses
  // the tab that already has it instead of piling up duplicates.
  const openViewerTab = (filePath: string, mode: 'file' | 'diff' = 'file') => {
    const open = tabs.find(
      (t) => t.view === 'viewer' && t.filePath === filePath && t.viewerMode === mode,
    );
    if (open) { selectTab(open.id); return; }
    const t = newViewerTab(filePath, mode);
    setTabs((ts) => [...ts, t]); selectTab(t.id);
  };

  const closeTab = (id: string) => {
    const t = tabs.find((x) => x.id === id);
    if (t?.ptyId) window.api.ptyKill(t.ptyId);
    const remaining = tabs.filter((x) => x.id !== id);
    setTabs(remaining);
    lastActivated.current.delete(id);
    if (id === active && remaining.length) {
      // Focus the most-recently-activated remaining tab; never leave active blank.
      const next = remaining.reduce((a, b) =>
        (lastActivated.current.get(b.id) ?? 0) > (lastActivated.current.get(a.id) ?? 0) ? b : a);
      setActive(next.id);
    }
  };

  const reorderTabs = (from: number, insert: number) =>
    setTabs((ts) => reorder(ts, from, insert));

  // A new conversation gets its id assigned here rather than discovered later:
  // reading back "whichever jsonl appeared in this folder" cannot tell two tabs
  // on the same repo apart, and getting that wrong would resume the wrong
  // conversation. Resuming an existing one keeps its id, since that is the
  // transcript it goes on writing to.
  const claudeSpawn = async (cwd: string, resumeId?: string) => {
    await window.api.recentsAdd(cwd);
    const sessionId = resumeId ?? crypto.randomUUID();
    const ptyId = await window.api.ptySpawn({
      path: cwd, resumeId, sessionId: resumeId ? undefined : sessionId,
    });
    return { ptyId, sessionId };
  };

  // Orange-arrow / in-place: converts the current files tab into a Claude terminal.
  const openClaude = async (id: string, cwd: string, resumeId?: string) => {
    const { ptyId, sessionId } = await claudeSpawn(cwd, resumeId);
    update(id, {
      view: 'terminal', cwd, ptyId, terminalKind: 'claude', sessionId, title: basename(cwd),
    });
  };

  // Feature 1: Open Recent launches Claude in a NEW tab (never overrides current).
  const openClaudeNewTab = async (cwd: string, resumeId?: string) => {
    const { ptyId, sessionId } = await claudeSpawn(cwd, resumeId);
    const t = newTerminalTab(cwd, 'claude', ptyId, basename(cwd), sessionId);
    setTabs((ts) => [...ts, t]); selectTab(t.id);
  };

  // Feature 5: open a plain shell terminal tab at a folder.
  const openShellTab = async (cwd: string) => {
    const ptyId = await window.api.ptySpawn({ path: cwd, shell: true });
    const t = newTerminalTab(cwd, 'shell', ptyId, 'Terminal');
    setTabs((ts) => [...ts, t]); selectTab(t.id);
  };

  // Feature 4: tab context-menu actions (resolve the tab's cwd, then act).
  const cwdOf = (id: string) => tabs.find((t) => t.id === id)?.cwd;
  const onOpenExplorer = (id: string) => { const p = cwdOf(id); if (p) window.api.openPath(p); };
  const onOpenTerminal = (id: string) => { const p = cwdOf(id); if (p) openShellTab(p); };
  const onOpenIde = (id: string) => { const p = cwdOf(id); if (p) window.api.ideOpen(p); };
  const onRename = (id: string, title: string) =>
    update(id, { title: title.trim() || (cwdOf(id) ? basename(cwdOf(id)!) : 'Tab'), renamed: true });

  const activeTab = tabs.find((t) => t.id === active);

  return (
    <div className="app">
      <TabBar
        tabs={tabs}
        activeId={active}
        status={status}
        onSelect={selectTab}
        onClose={closeTab}
        onAdd={addTab}
        onReorder={reorderTabs}
        onRename={onRename}
        onOpenExplorer={onOpenExplorer}
        onOpenTerminal={onOpenTerminal}
        onOpenIde={onOpenIde}
        recentMenu={
          <RecentMenu
            onOpen={(p, resumeId) => openClaudeNewTab(p, resumeId)}
            onOpenFolder={openFolderTab}
          />
        }
      />
      <div className="content">
        {activeTab?.view === 'files' && (
          <FileBrowser
            cwd={activeTab.cwd}
            tabId={activeTab.id}
            onNavigate={(p) =>
              update(activeTab.id, {
                cwd: p,
                ...(activeTab.renamed ? {} : { title: basename(p) }),
              })
            }
            onOpenClaude={(p) => openClaude(activeTab.id, p)}
            onOpenExternal={(p) => window.api.externalOpen(p)}
            onOpenFile={openViewerTab}
          />
        )}
        {activeTab?.view === 'viewer' && activeTab.filePath && (
          activeTab.viewerMode === 'diff'
            ? <DiffView filePath={activeTab.filePath} />
            : <Viewer filePath={activeTab.filePath} />
        )}
        {/* Terminals stay mounted for every terminal tab and are merely hidden
            when inactive. Unmounting disposes the xterm, and a rebuilt instance
            only ever receives *new* pty bytes — it never sees the escape
            sequences that put the terminal in alt-screen / application-cursor
            mode. A Claude session then silently stops scrolling, because the
            wheel is no longer translated into anything its TUI understands.
            Scrollback is lost with it. KAN-23. */}
        {tabs.map((t) =>
          t.view === 'terminal' && t.ptyId ? (
            <div key={t.id} className="pane" hidden={t.id !== active}>
              <Terminal ptyId={t.ptyId} />
            </div>
          ) : null,
        )}
      </div>
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}
