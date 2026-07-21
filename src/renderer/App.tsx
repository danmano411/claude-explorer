import { useEffect, useRef, useState } from 'react';
import { newFilesTab, type Tab } from './tabs';
import { FileBrowser } from './components/FileBrowser';
import { Terminal } from './components/Terminal';
import { RecentMenu } from './components/RecentMenu';
import { TabBar } from './TabBar';

export function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string>('');
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

  const reorderTabs = (from: number, to: number) => {
    setTabs((ts) => {
      const a = [...ts];
      const [moved] = a.splice(from, 1);
      a.splice(to, 0, moved);
      return a;
    });
  };

  const openClaude = async (id: string, cwd: string, resumeId?: string) => {
    await window.api.recentsAdd(cwd);
    const ptyId = await window.api.ptySpawn({ path: cwd, resumeId });
    update(id, { view: 'terminal', cwd, ptyId, title: cwd.split(/[\\/]/).pop() || cwd });
  };

  const activeTab = tabs.find((t) => t.id === active);

  return (
    <div className="app">
      <TabBar
        tabs={tabs}
        activeId={active}
        onSelect={selectTab}
        onClose={closeTab}
        onAdd={addTab}
        onReorder={reorderTabs}
        recentMenu={
          <RecentMenu
            onOpen={(p, resumeId) => activeTab && openClaude(activeTab.id, p, resumeId)}
            onOpenFolder={openFolderTab}
          />
        }
      />
      <div className="content">
        {activeTab?.view === 'files' && (
          <FileBrowser
            cwd={activeTab.cwd}
            tabId={activeTab.id}
            onNavigate={(p) => update(activeTab.id, { cwd: p, title: p.split(/[\\/]/).pop() || p })}
            onOpenClaude={(p) => openClaude(activeTab.id, p)}
            onOpenExternal={(p) => window.api.externalOpen(p)}
          />
        )}
        {activeTab?.view === 'terminal' && activeTab.ptyId && (
          <Terminal ptyId={activeTab.ptyId} />
        )}
      </div>
    </div>
  );
}
