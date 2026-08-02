import { Toggle } from './Toggle';

export function Footer({
  autoDownload,
  toggleAutoDownload,
  previewEnabled,
  togglePreview,
  captureFullPage,
  toggleCaptureFullPage,
  iframeEligible,
  includeIframes,
  toggleIncludeIframes,
}: {
  autoDownload: boolean;
  toggleAutoDownload: (e: Event) => void;
  previewEnabled: boolean;
  togglePreview: (e: Event) => void;
  captureFullPage: boolean;
  toggleCaptureFullPage: (e: Event) => void;
  iframeEligible: boolean;
  includeIframes: boolean;
  toggleIncludeIframes: (e: Event) => void;
}) {
  return (
    <footer class="border-t border-slate-800 bg-slate-950 px-4 py-3">
      <div class="flex w-full flex-col items-stretch gap-3 text-left">
        <Toggle
          id="capture-preview-toggle"
          label="Preview selection"
          checked={previewEnabled}
          onChange={togglePreview}
        />
        <Toggle
          id="capture-full-page-toggle"
          label="Capture full page"
          description="Default: Smart selection"
          checked={captureFullPage}
          onChange={toggleCaptureFullPage}
        />
        {iframeEligible && (
          <Toggle
            id="include-iframes-toggle"
            label="Include iframes"
            checked={includeIframes}
            onChange={toggleIncludeIframes}
          />
        )}
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
