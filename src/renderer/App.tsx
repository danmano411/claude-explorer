import { useEffect, useState } from 'react';
import { newFilesTab, type Tab } from './tabs';
import { FileBrowser } from './components/FileBrowser';
import { Terminal } from './components/Terminal';
import { RecentMenu } from './components/RecentMenu';

export function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string>('');

  useEffect(() => {
    window.api.fsHome().then((home) => {
      const t = newFilesTab(home);
      setTabs([t]); setActive(t.id);
    });
  }, []);

  const update = (id: string, patch: Partial<Tab>) =>
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  const addTab = async () => {
    const home = await window.api.fsHome();
    const t = newFilesTab(home);
    setTabs((ts) => [...ts, t]); setActive(t.id);
  };

  const closeTab = (id: string) => {
    const t = tabs.find((x) => x.id === id);
    if (t?.ptyId) window.api.ptyKill(t.ptyId);
    setTabs((ts) => ts.filter((x) => x.id !== id));
  };

  const openClaude = async (id: string, cwd: string, resumeId?: string) => {
    await window.api.recentsAdd(cwd);
    const ptyId = await window.api.ptySpawn({ path: cwd, resumeId });
    update(id, { view: 'terminal', cwd, ptyId, title: cwd.split(/[\\/]/).pop() || cwd });
  };

  const activeTab = tabs.find((t) => t.id === active);

  return (
    <div className="app">
      <div className="tabbar">
        <RecentMenu onOpen={(p, resumeId) => activeTab && openClaude(activeTab.id, p, resumeId)} onOpenFolder={(p) => { const t = newFilesTab(p); setTabs((ts)=>[...ts,t]); setActive(t.id); }} />
        {tabs.map((t) => (
          <button key={t.id} className={t.id === active ? 'tab active' : 'tab'} onClick={() => setActive(t.id)}>
            {t.view === 'terminal' ? '▶ ' : '📁 '}{t.title}
            <span className="close" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}>×</span>
          </button>
        ))}
        <button className="tab add" onClick={addTab}>+</button>
      </div>
      <div className="content">
        {activeTab?.view === 'files' && (
          <FileBrowser
            cwd={activeTab.cwd}
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
