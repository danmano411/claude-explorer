import { useEffect, useMemo, useRef, useState } from 'react';
import type { DirEntry, FileMode, SearchDone, SearchHit } from '../../shared/types';

/**
 * Explorer-style search: a box pinned to the top-right, results in a panel
 * floating beneath it. The file list behind is never replaced, so closing the
 * overlay puts you back exactly where you were.
 *
 * Two searches share the box:
 *  - as you type -> instant match on the names already loaded for this folder.
 *    No IPC, no ripgrep, nothing to cancel.
 *  - Enter -> recursive ripgrep under this folder, streaming in as it walks.
 */
export function SearchOverlay({
  dir, entries, mode, onOpen, onClose,
}: {
  dir: string;
  entries: DirEntry[];
  mode: FileMode;
  onOpen: (hit: SearchHit) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [deep, setDeep] = useState<SearchHit[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState<SearchDone | null>(null);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchId = useRef<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Instant, local, no round trip: the names for this folder are already here.
  const local = useMemo<SearchHit[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return entries
      .filter((e) => e.name.toLowerCase().includes(q))
      .map((e) => ({ path: e.path, name: e.name, isDirectory: e.isDirectory }));
  }, [entries, query]);

  // Deep hits are deduped against the local ones so a file whose name matched
  // does not appear twice when ripgrep reports it again.
  const results = useMemo(() => {
    const seen = new Set(local.map((h) => h.path));
    return [...local, ...deep.filter((h) => !seen.has(h.path) || h.line !== undefined)];
  }, [local, deep]);

  useEffect(() => { setCursor(0); }, [query]);

  // Keep the highlighted row in view while arrowing through a long result list.
  useEffect(() => {
    listRef.current?.children[cursor]?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  useEffect(() => {
    const offHits = window.api.onSearchHits((id, hits) => {
      if (id === searchId.current) setDeep((prev) => [...prev, ...hits]);
    });
    const offDone = window.api.onSearchDone((id, d) => {
      if (id !== searchId.current) return;
      searchId.current = null;
      setRunning(false);
      setDone(d);
    });
    return () => { offHits(); offDone(); };
  }, []);

  // Leaving with a search in flight would strand a ripgrep child walking a tree.
  useEffect(() => () => { if (searchId.current) window.api.searchCancel(searchId.current); }, []);

  const runDeep = async () => {
    const q = query.trim();
    if (!q) return;
    if (searchId.current) window.api.searchCancel(searchId.current);
    setDeep([]);
    setDone(null);
    setRunning(true);
    searchId.current = await window.api.searchStart({
      root: dir,
      query: q,
      content: true,
      regex: false,
      caseSensitive: false,
      // Explorer mode keeps ripgrep's defaults (.gitignore honoured, hidden
      // skipped); Developer mode searches everything. Same split as the list.
      includeIgnored: mode === 'developer',
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, Math.max(results.length - 1, 0)));
      return;
    }
    if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      // Enter on a highlighted row opens it; Enter in the box starts the deep
      // search. Arrowing into the list is what distinguishes the two.
      if (cursor > 0 && results[cursor]) onOpen(results[cursor]);
      else if (results.length && cursor === 0 && deep.length) onOpen(results[0]);
      else runDeep();
    }
  };

  const status = () => {
    if (running) return `searching… ${deep.length}`;
    if (done && !done.ok && done.kind === 'norg') return 'names only — search binary missing';
    if (done && !done.ok && done.kind === 'badpattern') return 'bad pattern';
    if (done && !done.ok && done.kind === 'error') return done.reason;
    if (done?.ok && done.truncated) return `${results.length}+ (stopped early)`;
    if (query.trim()) return `${results.length}`;
    return '';
  };

  return (
    <div className="search-overlay" onKeyDown={onKeyDown}>
      <div className="search-box">
        <input
          ref={inputRef}
          className="search-input"
          placeholder="Search this folder"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
        <span className="search-status">{status()}</span>
        <button className="search-close" title="Close (Esc)" onClick={onClose}>×</button>
      </div>

      {query.trim() && (
        <ul className="search-results" ref={listRef}>
          {results.length === 0 && !running && (
            <li className="empty">
              {done ? 'No matches' : 'No name matches — press Enter to search inside files'}
            </li>
          )}
          {results.map((h, i) => (
            <li
              key={`${h.path}:${h.line ?? ''}`}
              className={['search-row', i === cursor ? 'active' : ''].join(' ').trim()}
              onMouseEnter={() => setCursor(i)}
              onClick={() => onOpen(h)}
            >
              <span className="search-name">
                {h.isDirectory ? '📁 ' : ''}{h.name}
                {h.line !== undefined && <span className="search-line">:{h.line}</span>}
              </span>
              {h.preview
                ? <span className="search-preview">{h.preview}</span>
                : <span className="search-path">{relative(dir, h.path)}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Path shown relative to the folder being searched — the absolute prefix is
 *  the same for every row and only costs width. */
function relative(root: string, p: string): string {
  const r = root.endsWith('\\') ? root : `${root}\\`;
  return p.toLowerCase().startsWith(r.toLowerCase()) ? p.slice(r.length) : p;
}
