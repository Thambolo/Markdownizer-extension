import { useState, useEffect, useRef } from 'preact/hooks';
import { Header } from './components/Header';
import { Footer } from './components/Footer';
import { StatusOrb } from './components/StatusOrb';
import { StatusMessage } from './components/StatusMessage';
import { ActionButtons } from './components/ActionButtons';
import { injectContentScript, openPreviewSession, type PreviewSession, isSupportedPageUrl } from './preview-session';
import { buildZipBlob } from './zip-download';
import type { CaptureMode, PreviewEligibilityMessage } from '../preview-protocol';
import {
  applyIframeEligibility,
  initialIframeOptionState,
  setIframePreference,
  isIframeIncluded,
  type IframeOptionState,
} from './iframe-option';

interface ExtensionResponse {
  success: boolean;
  markdown: string;
  error?: string;
}

export function App() {
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [markdown, setMarkdown] = useState('');
  const [filename, setFilename] = useState('converted');
  const [error, setError] = useState('');
  const [autoDownload, setAutoDownload] = useState(false);
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [previewEnabled, setPreviewEnabled] = useState(true);
  const [previewWarning, setPreviewWarning] = useState('');
  const [captureMode, setCaptureMode] = useState<CaptureMode>('smart');
  const captureModeRef = useRef<CaptureMode>('smart');
  const [iframeOption, setIframeOption] = useState<IframeOptionState>(initialIframeOptionState);
  const iframeOptionRef = useRef<IframeOptionState>(initialIframeOptionState());
  const previewEnabledRef = useRef(true);
  const inspectionGenerationRef = useRef(0);
  const [imagesEligible, setImagesEligible] = useState(false);
  const [includeImages, setIncludeImages] = useState(false);
  const [permissionWarning, setPermissionWarning] = useState('');
  const [imagesNote, setImagesNote] = useState('');
  const includeImagesRef = useRef(false);
  const tabUrlRef = useRef<string | null>(null);

  const sessionRef = useRef<PreviewSession | null>(null);

  const requestIframeInspection = (session: PreviewSession, mode: CaptureMode): void => {
    const generation = inspectionGenerationRef.current + 1;
    inspectionGenerationRef.current = generation;
    session.inspect(mode, generation);
  };

  const handleIframeEligibility = (message: PreviewEligibilityMessage): void => {
    if (message.captureMode !== captureModeRef.current || message.generation !== inspectionGenerationRef.current) return;

    const prev = isIframeIncluded(iframeOptionRef.current);
    const next = applyIframeEligibility(iframeOptionRef.current, message.hasEligibleIframes);
    iframeOptionRef.current = next;
    setIframeOption(next);
    const now = isIframeIncluded(next);
    if (previewEnabledRef.current && sessionRef.current && prev !== now) {
      sessionRef.current.setIncludeIframes(now);
    }
    setImagesEligible(message.hasImages);
  };

  useEffect(() => {
    (async () => {
      const result = await chrome.storage.local.get(['autoDownload', 'includeImages']);
      if (result.autoDownload !== undefined) {
        setAutoDownload(result.autoDownload);
      }
      if (result.includeImages !== undefined) {
        setIncludeImages(result.includeImages);
        includeImagesRef.current = result.includeImages;
      }
    })();
  }, []);

  // Read preview preference and open session on mount
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    const initPreview = async () => {
      try {
        const result = await chrome.storage.local.get(['capturePreviewEnabled']);
        // Treat only explicit false as disabled; missing value = enabled
        const enabled = result.capturePreviewEnabled !== false;
        if (cancelled) return;
        setPreviewEnabled(enabled);
        previewEnabledRef.current = enabled;

        // Get the active tab
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id || !isSupportedPageUrl(tab.url)) return;
        if (cancelled) return;

        const session = await openPreviewSession(tab.id);
        if (cancelled) {
          session.disconnect();
          return;
        }
        sessionRef.current = session;
        unsubscribe = session.onEligibility(handleIframeEligibility);
        if (enabled) session.show(captureModeRef.current);
        requestIframeInspection(session, captureModeRef.current);
      } catch (err) {
        if (cancelled) return;
        setPreviewWarning('Preview unavailable on this page');
      }
    };

    initPreview();

    return () => {
      cancelled = true;
      unsubscribe?.();
      if (sessionRef.current) {
        sessionRef.current.disconnect();
        sessionRef.current = null;
      }
    };
  }, []);

  const sanitizeTitle = (title?: string) => {
    return (title || "markdown-page")
      .replace(/[^a-z0-9]/gi, '_')
      .toLowerCase();
  };

  const toggleAutoDownload = (e: Event) => {
    const target = e.target as HTMLInputElement;
    const newValue = target.checked;
    setAutoDownload(newValue);
    chrome.storage.local.set({ autoDownload: newValue });
  };

  const togglePreview = async (e: Event) => {
    const target = e.target as HTMLInputElement;
    const newValue = target.checked;
    setPreviewEnabled(newValue);
    previewEnabledRef.current = newValue;
    chrome.storage.local.set({ capturePreviewEnabled: newValue });

    if (!newValue) {
      // Turning off: hide the preview immediately
      if (sessionRef.current) {
        sessionRef.current.hide();
      }
    } else {
      // Turning on: establish session and show
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id || !isSupportedPageUrl(tab.url)) return;

        // Create a session if none exists
        if (!sessionRef.current) {
          const session = await openPreviewSession(tab.id);
          sessionRef.current = session;
          session.onEligibility(handleIframeEligibility);
        }

        sessionRef.current.show(captureModeRef.current);
        requestIframeInspection(sessionRef.current, captureModeRef.current);
        setPreviewWarning('');
      } catch {
        setPreviewWarning('Preview unavailable on this page');
      }
    }
  };

  const toggleCaptureFullPage = (e: Event) => {
    const target = e.target as HTMLInputElement;
    const newValue = target.checked;
    const newMode: CaptureMode = newValue ? 'full-page' : 'smart';
    setCaptureMode(newMode);
    captureModeRef.current = newMode;

    // If preview is enabled and session exists, show with new mode immediately
    if (previewEnabled && sessionRef.current) {
        sessionRef.current.show(newMode);
        sessionRef.current.setIncludeIframes(isIframeIncluded(iframeOptionRef.current));
    }
    if (sessionRef.current) {
      inspectionGenerationRef.current = 0;
      requestIframeInspection(sessionRef.current, newMode);
    }
  };

  const toggleIncludeIframes = (e: Event) => {
    const target = e.target as HTMLInputElement;
    const next = setIframePreference(iframeOptionRef.current, target.checked ? 'include' : 'exclude');
    iframeOptionRef.current = next;
    setIframeOption(next);
    // The session stays open for eligibility even when visual preview is
    // disabled, so re-inspection must not be gated on preview being enabled.
    if (sessionRef.current) {
      sessionRef.current.setIncludeIframes(isIframeIncluded(next));
      inspectionGenerationRef.current = 0;
      requestIframeInspection(sessionRef.current, captureModeRef.current);
    }
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
    chrome.storage.local.set({ includeImages: newValue });
  };

  const downloadFile = (content: string, filename: string) => {
    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename.endsWith('.md') ? filename : `${filename}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    setDownloaded(true);
    setTimeout(() => setDownloaded(false), 2000);
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename.endsWith('.zip') ? filename : `${filename}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setDownloaded(true);
    setTimeout(() => setDownloaded(false), 2000);
  };

  const downloadWithImages = async (markdownText: string, safeTitle: string, tabUrl?: string) => {
    try {
        const result = await buildZipBlob(markdownText, safeTitle, tabUrl ?? null);
        if (!result.blob) {
            downloadFile(markdownText, safeTitle);
            setImagesNote(result.totalImages > 0 ? 'Images unavailable - downloaded .md only' : '');
            return;
        }
        downloadBlob(result.blob, safeTitle);
        setImagesNote(
            result.skippedImages > 0
                ? `Included ${result.bundledImages} of ${result.totalImages} images`
                : `Included ${result.bundledImages} images`,
        );
    } catch (err) {
        console.error(err);
        downloadFile(markdownText, safeTitle);
        setImagesNote('Image bundling failed - downloaded .md only');
    }
  };

  const handleConvert = async () => {
    if (status === 'loading') return;
    setStatus('loading');
    setError('');
    setMarkdown('');
    setImagesNote('');

    // Set preview to loading state before conversion
    if (previewEnabled && sessionRef.current) {
      sessionRef.current.setLoading();
    }

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab.id) throw new Error("No active tab found");
      if (!isSupportedPageUrl(tab.url)) {
        throw new Error("Open a normal webpage first. Markdownizer cannot run on browser settings, extension pages, or internal URLs.");
      }

      const response = await ensureContentScriptLoaded(tab.id, captureMode, isIframeIncluded(iframeOptionRef.current));
      processResponse(response, tab);

    } catch (err: unknown) {
      console.error(err);
      // Restore preview ready state before showing error
      if (previewEnabled && sessionRef.current) {
        sessionRef.current.setReady();
      }
      const errorMessage = err instanceof Error ? err.message : "Failed. Refresh the tab.";
      setError(errorMessage);
      setStatus('error');
    }
  };

  const processResponse = (response: ExtensionResponse, tab: chrome.tabs.Tab) => {
      if (response && response.success) {
        // Restore the normal preview state while keeping it visible until popup close
        if (previewEnabled && sessionRef.current) {
          sessionRef.current.setReady();
        }
        const safeTitle = sanitizeTitle(tab.title);
        tabUrlRef.current = tab.url ?? null;
        setMarkdown(response.markdown);
        setFilename(safeTitle);
        setStatus('success');

        if (autoDownload) {
            if (includeImagesRef.current) {
                downloadWithImages(response.markdown, safeTitle, tab.url);
            } else {
                downloadFile(response.markdown, safeTitle);
            }
        }
      } else {
        throw new Error(response.error || "Unknown error occurred");
      }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const openSettings = () => {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL('options.html'));
    }
  };

    return (
      <div class="w-[320px] min-h-[400px] flex flex-col bg-slate-950 text-slate-100 font-['Inter'] selection:bg-indigo-500/30">

        <Header openSettings={openSettings} />

        {/* Main Content */}
        <main class="flex-1 flex flex-col p-6 items-center justify-center gap-6 relative">

            <StatusOrb status={status} handleConvert={handleConvert} />

            <StatusMessage status={status} markdownLength={markdown.length} error={error} warning={previewWarning || permissionWarning} note={imagesNote} />

            {/* Success Actions (Only visible on Success) */}
            {status === 'success' && (
                <ActionButtons
                    copied={copied}
                    downloaded={downloaded}
                    includeImages={includeImagesRef.current}
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
          toggleCaptureFullPage={toggleCaptureFullPage}
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

/**
 * Ensures the content script is loaded before sending a message.
 * If the initial message fails, it attempts to inject the script and retry.
 */
async function ensureContentScriptLoaded(tabId: number, captureMode: CaptureMode, includeIframes: boolean): Promise<ExtensionResponse> {
    try {
        return await chrome.tabs.sendMessage(tabId, { action: "convert_page", captureMode, includeIframes });
    } catch (e: unknown) {
        // If messaging fails, the script might not be injected (e.g. extension updated or fresh tab)
        await injectContentScript(tabId);

        // Retry loop: The script might take a moment to initialize its message listeners
        let lastError;
        for (let i = 0; i < 5; i++) {
            await new Promise(resolve => setTimeout(resolve, 200));
            try {
                return await chrome.tabs.sendMessage(tabId, { action: "convert_page", captureMode, includeIframes });
            } catch (err) {
                lastError = err;
            }
        }

        throw lastError || new Error("Failed to establish connection to content script");
    }
}
