export function StatusBar({ count, selected }: { count: number; selected: number }) {
  return (
    <div className="statusbar">
      <span>{count} items</span>
      {selected > 0 && <span>{selected} selected</span>}
    </div>
  );
}
