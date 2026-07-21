export function Breadcrumb({ cwd, onNavigate }: { cwd: string; onNavigate: (p: string) => void }) {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  const sep = cwd.includes('\\') ? '\\' : '/';
  return (
    <div className="breadcrumb">
      {parts.map((seg, i) => (
        <span key={i} className="crumb" onClick={() => onNavigate(parts.slice(0, i + 1).join(sep))}>{seg}{sep}</span>
      ))}
    </div>
  );
}
