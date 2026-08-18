import { useRef, useState } from 'preact/hooks';
import type { CaptureMode } from '../../shared/preview-protocol';
import { isSupportedPageUrl, type PreviewSession } from '../preview-session';
import { isIframeIncluded, type IframeOptionState } from '../iframe-option';
import { sendWithInjectionRetry } from '../content-script-loader';
import { downloadBlob } from '../../shared/download';

interface ExtensionResponse {
    success: boolean;
    markdown: string;
    error?: string;
}

/** Conversion state and actions: convert_page with the content-script
 * readiness retry, result routing (zip vs plain .md download), the blob
 * download helper, and the clipboard flash. */
export function useConversion(options: {
    previewEnabledRef: { current: boolean };
    sessionRef: { current: PreviewSession | null };
    captureModeRef: { current: CaptureMode };
    iframeOptionRef: { current: IframeOptionState };
    includeImagesRef: { current: boolean };
    imagesEligibleRef: { current: boolean };
    autoDownload: boolean;
    downloadWithImages: (markdown: string, safeTitle: string, sourceUrl?: string) => void;
    setDownloaded: (d: boolean) => void;   // from useZipBuild — downloadFile's flash
    setImagesNote: (note: string) => void; // from useZipBuild — cleared on convert
    tabUrlRef: { current: string | null }; // converted page URL for zip re-downloads
}) {
    const {
        previewEnabledRef, sessionRef, captureModeRef, iframeOptionRef,
        includeImagesRef, imagesEligibleRef, autoDownload,
        downloadWithImages, setDownloaded, setImagesNote, tabUrlRef,
    } = options;
    const autoDownloadRef = useRef(autoDownload);
    autoDownloadRef.current = autoDownload;

    const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
    const [markdown, setMarkdown] = useState('');
    const [filename, setFilename] = useState('converted');
    const [error, setError] = useState('');
    const [copied, setCopied] = useState(false);

    const sanitizeTitle = (title?: string) => {
        return (title || "markdown-page")
            .replace(/[^a-z0-9]/gi, '_')
            .toLowerCase();
    };

    const downloadFile = (content: string, filename: string) => {
        downloadBlob(
            new Blob([content], { type: 'text/markdown' }),
            filename.endsWith('.md') ? filename : `${filename}.md`,
            0,
        );
        setDownloaded(true);
        setTimeout(() => setDownloaded(false), 2000);
    };

    // Content-script readiness for the conversion message; the loader owns the
    // ping → inject → retry policy.
    const ensureContentScriptLoaded = (tabId: number): Promise<ExtensionResponse> =>
        sendWithInjectionRetry<ExtensionResponse>(tabId, {
            action: 'convert_page',
            captureMode: captureModeRef.current,
            includeIframes: isIframeIncluded(iframeOptionRef.current),
        });

    const processResponse = (response: ExtensionResponse, tab: chrome.tabs.Tab) => {
        if (response && response.success) {
            // Restore the normal preview state while keeping it visible until popup close
            if (previewEnabledRef.current && sessionRef.current) {
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
            } else if (autoDownloadRef.current) {
                downloadFile(response.markdown, safeTitle);
            }
        } else {
            throw new Error(response.error || "Unknown error occurred");
        }
    };

    const handleConvert = async () => {
        if (status === 'loading') return;
        setStatus('loading');
        setError('');
        setMarkdown('');
        setImagesNote('');

        // Set preview to loading state before conversion
        if (previewEnabledRef.current && sessionRef.current) {
            sessionRef.current.setLoading();
        }

        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab.id) throw new Error("No active tab found");
            if (!isSupportedPageUrl(tab.url)) {
                throw new Error("Open a normal webpage first. Markdownizer cannot run on browser settings, extension pages, or internal URLs.");
            }

            const response = await ensureContentScriptLoaded(tab.id);
            processResponse(response, tab);

        } catch (err: unknown) {
            console.error(err);
            // Restore preview ready state before showing error
            if (previewEnabledRef.current && sessionRef.current) {
                sessionRef.current.setReady();
            }
            const errorMessage = err instanceof Error ? err.message : "Failed. Refresh the tab.";
            setError(errorMessage);
            setStatus('error');
        }
    };

    const handleCopy = () => {
        navigator.clipboard.writeText(markdown);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return { status, error, markdown, filename, copied, setCopied, handleConvert, handleCopy, downloadFile };
}
