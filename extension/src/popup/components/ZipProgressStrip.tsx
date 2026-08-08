export interface ZipProgressStripProps {
  phase: 'fetch' | 'build';
  fetched: number;
  total: number;
}

export function ZipProgressStrip({ phase, fetched, total }: ZipProgressStripProps) {
  const pct = total > 0 ? Math.min(100, Math.round((fetched / total) * 100)) : 0;
  return (
    <div class="px-4 pb-3" role="status" aria-live="polite">
      <div class="mb-1 flex items-center justify-between text-[11px] text-slate-400">
        <span>{phase === 'fetch' ? `Fetching images ${fetched}/${total}…` : 'Building ZIP…'}</span>
        {phase === 'fetch' && total > 0 && <span class="font-mono">{pct}%</span>}
      </div>
      <div class="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
        <div
          class="h-full rounded-full bg-indigo-500 transition-all duration-200"
          style={{ width: phase === 'build' ? '100%' : `${pct}%` }}
        />
      </div>
    </div>
  );
}
