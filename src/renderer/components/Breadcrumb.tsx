export function Breadcrumb({ cwd, onNavigate }: { cwd: string; onNavigate: (p: string) => void }) {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  const sep = cwd.includes('\\') ? '\\' : '/';
  // A POSIX absolute path has a leading '/' that split() discards. Without it
  // the crumbs read "Users/me/" and clicking one navigates to a RELATIVE path.
  const rooted = sep === '/' && cwd.startsWith('/');
  const pathTo = (n: number) => (rooted ? '/' : '') + parts.slice(0, n).join(sep);
  return (
    <div className="breadcrumb">
      {rooted && <span className="crumb" onClick={() => onNavigate('/')}>{sep}</span>}
      {parts.map((seg, i) => (
        <span key={i} className="crumb" onClick={() => onNavigate(pathTo(i + 1))}>{seg}{sep}</span>
      ))}
    </div>
  );
}
