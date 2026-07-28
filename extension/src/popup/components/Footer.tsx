export function Footer({
  autoDownload,
  toggleAutoDownload,
  previewEnabled,
  togglePreview,
}: {
  autoDownload: boolean;
  toggleAutoDownload: (e: Event) => void;
  previewEnabled: boolean;
  togglePreview: (e: Event) => void;
}) {
  return (
    <footer class="p-3 text-center border-t border-slate-800 bg-slate-950">
      <div class="flex flex-col items-center gap-2">
        <label class="inline-flex items-center gap-2 text-xs text-slate-400 cursor-pointer hover:text-slate-300 transition-colors">
          <input
            type="checkbox"
            checked={previewEnabled}
            onChange={togglePreview}
            class="rounded border-slate-700 bg-slate-900 text-indigo-500 focus:ring-offset-0 focus:ring-1 focus:ring-indigo-500/50"
          />
          <span>Preview</span>
        </label>
        <label class="inline-flex items-center gap-2 text-xs text-slate-400 cursor-pointer hover:text-slate-300 transition-colors">
          <input
            type="checkbox"
            checked={autoDownload}
            onChange={toggleAutoDownload}
            class="rounded border-slate-700 bg-slate-900 text-indigo-500 focus:ring-offset-0 focus:ring-1 focus:ring-indigo-500/50"
          />
          <span>Auto-download on success</span>
        </label>
      </div>
    </footer>
  );
}
