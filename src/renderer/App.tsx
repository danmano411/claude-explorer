import { useEffect, useRef, useState } from 'react';
import { newFilesTab, newTerminalTab, type Tab } from './tabs';
import { reorder } from './tabreorder';
import { usePtyStatus } from './ptystatus';
import { FileBrowser } from './components/FileBrowser';
import { Terminal } from './components/Terminal';
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

  const selectTab = (id: string) => {
    lastActivated.current.set(id, Date.now());
    setActive(id);
  };

  useEffect(() => {
    window.api.fsHome().then((home) => {
      const t = newFilesTab(home);
      setTabs([t]); selectTab(t.id);
    });
  }, []);

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

  // Orange-arrow / in-place: converts the current files tab into a Claude terminal.
  const openClaude = async (id: string, cwd: string, resumeId?: string) => {
    await window.api.recentsAdd(cwd);
    const ptyId = await window.api.ptySpawn({ path: cwd, resumeId });
    update(id, { view: 'terminal', cwd, ptyId, terminalKind: 'claude', title: basename(cwd) });
  };

  // Feature 1: Open Recent launches Claude in a NEW tab (never overrides current).
  const openClaudeNewTab = async (cwd: string, resumeId?: string) => {
    await window.api.recentsAdd(cwd);
    const ptyId = await window.api.ptySpawn({ path: cwd, resumeId });
    const t = newTerminalTab(cwd, 'claude', ptyId, basename(cwd));
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
          <>
            <RecentMenu
              onOpen={(p, resumeId) => openClaudeNewTab(p, resumeId)}
              onOpenFolder={openFolderTab}
            />
            <button className="gear" title="Settings" onClick={() => setShowSettings(true)}>⚙</button>
          </>
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
          />
        )}
        {activeTab?.view === 'terminal' && activeTab.ptyId && (
          <Terminal ptyId={activeTab.ptyId} />
        )}
      </div>
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}
