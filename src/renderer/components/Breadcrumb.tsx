import { crumbs } from '../../shared/pathutil';

export function Breadcrumb({ cwd, onNavigate }: { cwd: string; onNavigate: (p: string) => void }) {
  return (
    <div className="breadcrumb">
      {crumbs(cwd).map((c, i) => (
        <span key={i} className="crumb" onClick={() => onNavigate(c.path)}>{c.label}</span>
      ))}
    </div>
  );
}
