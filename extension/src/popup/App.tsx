import { useState, useEffect, useRef } from 'preact/hooks';
import { Header } from './components/Header';
import { Footer } from './components/Footer';
import { StatusOrb } from './components/StatusOrb';
import { StatusMessage } from './components/StatusMessage';
import { ActionButtons } from './components/ActionButtons';
import { ZipProgressStrip } from './components/ZipProgressStrip';
import { injectContentScript, openPreviewSession, type PreviewSession, isSupportedPageUrl } from './preview-session';
import type { CaptureMode, PreviewEligibilityMessage } from '../shared/preview-protocol';
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
  const imagesEligibleRef = useRef(false);
  const [includeImages, setIncludeImages] = useState(false);
  const [permissionWarning, setPermissionWarning] = useState('');
  const [imagesNote, setImagesNote] = useState('');
  const includeImagesRef = useRef(false);
  const tabUrlRef = useRef<string | null>(null);

  interface ZipBuildState {
    buildId: string;
    phase: 'fetch' | 'build';
    fetched: number;
    total: number;
  }
  const [zipBuild, setZipBuildStateRaw] = useState<ZipBuildState | null>(null);
  const zipBuildRef = useRef<ZipBuildState | null>(null);
  // The most recent zip build's id. Unlike zipBuildRef (nulled on zip:done so
  // the progress strip clears), this survives zip:done so a delayed zip:error
  // from the download-appearance watchdog can still render. Nulled on a new
  // build start, on zip:error, and on unmount.
  const lastBuildIdRef = useRef<string | null>(null);
  const setZipBuildState = (next: ZipBuildState | null) => {
    zipBuildRef.current = next;
    setZipBuildStateRaw(next);
  };

  const sessionRef = useRef<PreviewSession | null>(null);

  const requestIframeInspection = (session: PreviewSession, mode: CaptureMode): void => {
    const generation = inspectionGenerationRef.current + 1;
    inspectionGenerationRef.current = generation;
    // The inspect payload carries the active include-iframes choice so the
    // content script only counts iframe images when they will be captured.
    session.inspect(mode, generation, isIframeIncluded(iframeOptionRef.current));
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
    if (sessionRef.current && prev !== now) {
        // Auto-inclusion flipped iframes off -> on (or the reverse): the
        // content script's last eligibility was computed under the old
        // include-iframes choice, so re-inspect under the new one. Not gated
        // on preview being enabled — the session stays live for eligibility
        // (mirror F4). Terminates: the re-inspection's eligibility returns
        // with prev === now, so no further re-inspection.
        inspectionGenerationRef.current = 0;
        requestIframeInspection(sessionRef.current, message.captureMode);
    }
    setImagesEligible(message.hasImages);
    imagesEligibleRef.current = message.hasImages;
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
    // Mount-only effect: runs once per popup open. All captured values are
    // refs and state setters; the session and handlers are intentionally
    // bound to the popup's lifetime, not to dependency changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Relay zip build broadcasts from the service worker (zip:progress /
  // zip:done / zip:error) into the progress strip and download notes. Only
  // messages for the popup's own buildId are accepted; the buildId is read
  // through a ref so the listener never goes stale across renders.
  useEffect(() => {
    const handleMessage = (message: unknown) => {
      const msg = message as { type?: string; buildId?: string } | null;
      if (!msg || typeof msg !== 'object' || typeof msg.buildId !== 'string') return;
      if (msg.buildId !== (zipBuildRef.current?.buildId ?? lastBuildIdRef.current)) return;

      if (msg.type === 'zip:progress') {
        const p = msg as { phase?: string; fetched?: number; total?: number };
        const current = zipBuildRef.current;
        if (!current) return;
        setZipBuildState({
          ...current,
          phase: p.phase === 'build' ? 'build' : 'fetch',
          fetched: p.fetched ?? current.fetched,
          total: p.total ?? current.total,
        });
      } else if (msg.type === 'zip:done') {
        const d = msg as { downloaded?: string; totalImages?: number; bundledImages?: number; skippedImages?: number };
        setZipBuildState(null);
        setDownloaded(true);
        setTimeout(() => setDownloaded(false), 2000);
        const bundled = d.bundledImages ?? 0;
        const total = d.totalImages ?? 0;
        const skipped = d.skippedImages ?? 0;
        if (d.downloaded === 'md' && total > 0) {
          setImagesNote('Images unavailable - downloaded .md only');
        } else if (bundled > 0) {
          setImagesNote(skipped > 0 ? `Included ${bundled} of ${total} images` : `Included ${bundled} images`);
        }
      } else if (msg.type === 'zip:error') {
        const e = msg as { error?: string };
        lastBuildIdRef.current = null;
        setZipBuildState(null);
        setImagesNote(e.error ?? 'Image bundling failed');
      }
    };
    chrome.runtime.onMessage.addListener(handleMessage);
    return () => {
      lastBuildIdRef.current = null;
      chrome.runtime.onMessage.removeListener(handleMessage);
    };
    // Mount-only listener: stable setters and refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restore an in-flight zip build when the popup reopens: show the stored
  // storage.session snapshot immediately, then refresh it (or hide the strip)
  // with a zip:status liveness ping to the service worker.
  useEffect(() => {
    let cancelled = false;
    const restore = async () => {
      try {
        const stored = await chrome.storage.session.get('activeZipBuild');
        const state = stored.activeZipBuild as
          | { buildId?: string; phase?: string; fetched?: number; total?: number }
          | undefined;
        if (!state?.buildId || cancelled) return;
        setZipBuildState({
          buildId: state.buildId,
          phase: state.phase === 'build' ? 'build' : 'fetch',
          fetched: state.fetched ?? 0,
          total: state.total ?? 0,
        });
        lastBuildIdRef.current = state.buildId;
        const response = await chrome.runtime.sendMessage({ action: 'zip:status', buildId: state.buildId });
        if (cancelled) return;
        if (response?.active) {
          setZipBuildState({
            buildId: response.buildId,
            phase: response.phase === 'build' ? 'build' : 'fetch',
            fetched: response.fetched ?? 0,
            total: response.total ?? 0,
          });
          lastBuildIdRef.current = response.buildId;
        } else {
          setZipBuildState(null);
        }
      } catch {
        if (!cancelled) setZipBuildState(null);
      }
    };
    restore();
    return () => {
      cancelled = true;
    };
    // Mount-only restore: refs and stable setters only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const downloadWithImages = async (markdownText: string, safeTitle: string, sourceUrl?: string) => {
    const buildId = crypto.randomUUID();
    lastBuildIdRef.current = buildId;
    setImagesNote('');
    setZipBuildState({ buildId, phase: 'fetch', fetched: 0, total: 0 });
    try {
      await chrome.runtime.sendMessage({
        action: 'build_zip',
        buildId,
        payload: { markdown: markdownText, title: safeTitle, sourceUrl: sourceUrl ?? null },
      });
    } catch {
      // The done/error broadcast messages drive the UI; a dead response
      // channel (e.g. popup about to close) is not an error. Clear the
      // strip so the pill cannot wedge on "Bundling images…" and the
      // action buttons cannot stay disabled if the build never starts.
      setZipBuildState(null);
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

        // "Download images" ON and the page has images (eligibility):
        // converting also bundles the page images and auto-downloads the ZIP
        // (the toggle alone triggers it, regardless of the auto-download
        // setting). Toggle OFF or an image-less page (dormant preference):
        // auto-download keeps gating the plain .md path.
        if (includeImagesRef.current && imagesEligibleRef.current) {
            downloadWithImages(response.markdown, safeTitle, tab.url);
        } else if (autoDownload) {
            downloadFile(response.markdown, safeTitle);
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
                bundling={zipBuild !== null}
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
                    bundling={zipBuild !== null}
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
