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
  imagesEligible,
  includeImages,
  toggleIncludeImages,
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
  imagesEligible: boolean;
  includeImages: boolean;
  toggleIncludeImages: (e: Event) => void;
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
        <Toggle
          id="include-iframes-toggle"
          label="Include iframes"
          description={iframeEligible ? undefined : 'No iframes on this page'}
          checked={includeIframes}
          onChange={toggleIncludeIframes}
          disabled={!iframeEligible}
        />
        <Toggle
          id="include-images-toggle"
          label="Download images"
          description={
            imagesEligible
              ? 'Converts and auto-downloads the page with its images as a ZIP'
              : 'No images on this page'
          }
          checked={includeImages}
          onChange={toggleIncludeImages}
          disabled={!imagesEligible}
        />
        <Toggle
          id="auto-download-toggle"
          label="Auto-download on success"
          description={includeImages && imagesEligible ? 'Handled by Download images' : undefined}
          checked={autoDownload}
          onChange={toggleAutoDownload}
          disabled={includeImages && imagesEligible}
        />
      </div>
    </footer>
  );
}
