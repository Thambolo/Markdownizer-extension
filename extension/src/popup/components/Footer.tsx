import { Toggle } from './Toggle';

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
    <footer class="border-t border-slate-800 bg-slate-950 px-4 py-3">
      <div class="flex w-full flex-col items-stretch gap-3 text-left">
        <Toggle
          id="capture-preview-toggle"
          label="Preview"
          checked={previewEnabled}
          onChange={togglePreview}
        />
        <Toggle
          id="auto-download-toggle"
          label="Auto-download on success"
          checked={autoDownload}
          onChange={toggleAutoDownload}
        />
      </div>
    </footer>
  );
}
