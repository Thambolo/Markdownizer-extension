import { useState, useEffect, useRef } from 'preact/hooks';
import { Header } from './components/Header';
import { Footer } from './components/Footer';
import { StatusOrb } from './components/StatusOrb';
import { StatusMessage } from './components/StatusMessage';
import { ActionButtons } from './components/ActionButtons';
import { ZipProgressStrip } from './components/ZipProgressStrip';
import { usePersistedToggle } from './hooks/use-persisted-toggle';
import { useCaptureMode } from './hooks/use-capture-mode';
import { useZipBuild } from './hooks/use-zip-build';
import { usePreviewSession } from './hooks/use-preview-session';
import { useConversion } from './hooks/use-conversion';
import { initialIframeOptionState, isIframeIncluded, type IframeOptionState } from './iframe-option';

export function App() {
  const [autoDownload, setAutoDownload] = usePersistedToggle('autoDownload', false);
  const [includeImages, setIncludeImages] = usePersistedToggle('includeImages', false);
  const [captureMode, setCaptureMode, captureModeRef] = useCaptureMode('smart');
  const {
    zipBuild, isBundling, imagesNote, setImagesNote,
    downloaded, setDownloaded, downloadWithImages,
  } = useZipBuild();

  const [previewEnabled, setPreviewEnabled] = useState(true);
  const [permissionWarning, setPermissionWarning] = useState('');
  const previewEnabledRef = useRef(previewEnabled);
  previewEnabledRef.current = previewEnabled;
  const tabUrlRef = useRef<string | null>(null);
  const iframeOptionRef = useRef<IframeOptionState>(initialIframeOptionState());
  const imagesEligibleRef = useRef(false);
  const includeImagesRef = useRef(false);

  // Storage-prefs mount effect: the usePersistedToggle instances restore the
  // toggle states; this keeps the conversion ref in sync with the persisted
  // include-images value.
  useEffect(() => {
    (async () => {
      const result = await chrome.storage.local.get(['autoDownload', 'includeImages']);
      if (result.includeImages !== undefined) {
        includeImagesRef.current = result.includeImages;
      }
    })();
  }, []);

  const preview = usePreviewSession({
    captureModeRef,
    previewEnabled,
    setPreviewEnabled,
    onIframeOptionChange: (next) => { iframeOptionRef.current = next; },
    onImagesEligibleChange: (eligible) => { imagesEligibleRef.current = eligible; },
  });
  const { iframeOption, imagesEligible, previewWarning, togglePreview, toggleCaptureFullPage, toggleIncludeIframes } = preview;

  const conversion = useConversion({
    previewEnabledRef,
    sessionRef: preview.sessionRef,
    captureModeRef,
    iframeOptionRef,
    includeImagesRef,
    imagesEligibleRef,
    autoDownload,
    downloadWithImages,
    setDownloaded,
    setImagesNote,
    tabUrlRef,
  });
  const { status, error, markdown, filename, copied, handleConvert, handleCopy, downloadFile } = conversion;

  const toggleAutoDownload = (e: Event) => {
    setAutoDownload((e.target as HTMLInputElement).checked);
  };

  const toggleCaptureFullPageWrapped = (e: Event) => {
    // The preview hook owns the session side effects and writes the shared
    // capture-mode ref; keep the state in sync for the footer checkbox.
    toggleCaptureFullPage(e);
    setCaptureMode(captureModeRef.current);
  };

  const ensureImagePermission = async (): Promise<boolean> => {
    try {
      const origins = ['<all_urls>'];
      if (await chrome.permissions.contains({ origins })) return true;
      return await chrome.permissions.request({ origins });
    } catch {
      // Any permissions API failure is treated as denial; the caller's denial
      // path reverts the toggle and explains the requirement.
      return false;
    }
  };

  const toggleIncludeImages = async (e: Event) => {
    const target = e.target as HTMLInputElement;
    const newValue = target.checked;
    if (newValue) {
      const granted = await ensureImagePermission();
      if (!granted) {
        setIncludeImages(false);
        includeImagesRef.current = false;
        setPermissionWarning('Image bundling needs site access permission.');
        return;
      }
    }
    setPermissionWarning('');
    setIncludeImages(newValue);
    includeImagesRef.current = newValue;
  };

  return (
    <div class="w-[320px] min-h-[400px] flex flex-col bg-slate-950 text-slate-100 font-['Inter'] selection:bg-indigo-500/30">

      <Header />

      {/* Main Content */}
      <main class="flex-1 flex flex-col p-6 items-center justify-center gap-6 relative">

        <StatusOrb status={status} handleConvert={handleConvert} />

        <StatusMessage
          status={status}
          markdownLength={markdown.length}
          error={error}
          warning={previewWarning || permissionWarning}
          note={imagesNote}
          bundling={isBundling}
        />

        {/* Zip build progress: above the action buttons; gated only on
            zipBuild so the mid-build restore path keeps showing it */}
        {zipBuild && (
          <ZipProgressStrip phase={zipBuild.phase} fetched={zipBuild.fetched} total={zipBuild.total} />
        )}

        {/* Success Actions (Only visible on Success) */}
        {status === 'success' && (
          <ActionButtons
            copied={copied}
            downloaded={downloaded}
            imagesActive={includeImagesRef.current && imagesEligibleRef.current}
            bundling={isBundling}
            handleCopy={handleCopy}
            handleDownload={() => { setImagesNote(''); downloadFile(markdown, filename); }}
            handleDownloadZip={() => downloadWithImages(markdown, filename, tabUrlRef.current ?? undefined)}
          />
        )}

      </main>

      <Footer
        autoDownload={autoDownload}
        toggleAutoDownload={toggleAutoDownload}
        previewEnabled={previewEnabled}
        togglePreview={togglePreview}
        captureFullPage={captureMode === 'full-page'}
        toggleCaptureFullPage={toggleCaptureFullPageWrapped}
        iframeEligible={iframeOption.eligible}
        includeIframes={isIframeIncluded(iframeOption)}
        toggleIncludeIframes={toggleIncludeIframes}
        imagesEligible={imagesEligible}
        includeImages={includeImages}
        toggleIncludeImages={toggleIncludeImages}
      />

    </div>
  );
}
