import '../preview/content-preview.css';
import { getContentForMode, getReadabilityContent, selectCaptureRoot } from '../extraction/extractor';
import {
    hasEligibleIframesLightweight,
    hasImagesInRoot,
    readSameOriginFrame,
    IFRAME_MAX_COUNT,
} from '../extraction/iframe-capture';
import { skeletonize, rehydrateMarkdown } from '../skeleton/skeletonizer';
import { shouldUseReadability } from './payload';
import { ContentPreview, CONTENT_PREVIEW_HOST_ATTRIBUTE } from '../preview/content-preview';
import {
    PREVIEW_PORT_NAME,
    type CaptureMode,
    type PreviewEligibilityMessage,
    type PreviewCommand,
} from '../shared/preview-protocol';
import { dispatchMessage, registerMessageHandler } from '../shared/messages';
import type { ConvertPageMessage } from '../shared/messages';
import type { CodeMirrorDocumentCapture } from '../extraction/codemirror-bridge';

interface BackgroundConversionResponse {
    success: boolean;
    markdown_skeleton?: string;
    error?: string;
}

// ── Preview Protocol ──────────────────────────────────────────────────────────

const preview = new ContentPreview();

interface OwnerState {
    port: chrome.runtime.Port;
    sessionId: string;
    generation: number;
}

let nextGeneration = 0;
let currentOwner: OwnerState | null = null;

function normalizeCaptureMode(value: unknown): CaptureMode {
    return value === 'full-page' ? 'full-page' : 'smart';
}

export function normalizeIncludeIframes(value: unknown): boolean {
    return value === true;
}

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PREVIEW_PORT_NAME) return;

    const generation = nextGeneration++;
    let latestInspection: { captureMode: CaptureMode; generation: number; includeIframes: boolean } | null = null;
    let acceptedInspectionGeneration = -1;
    let currentSessionId = '';
    let eligibilityObserver: MutationObserver | null = null;
    const frameObserverMap = new Map<HTMLIFrameElement, { observer: MutationObserver; document: Document }>();
    let refreshFrame = 0;
    let watcherActive = true;

    // Cached live root from selectCaptureRoot — never re-derived via getContentForMode
    let cachedRoot: HTMLElement | null = null;

    const postEligibility = (): void => {
        if (!latestInspection) return;
        // Reject stale generation inspections
        if (latestInspection.generation < acceptedInspectionGeneration) return;
        // Use lightweight eligibility — never call getContentForMode
        const root = cachedRoot ?? selectCaptureRoot(latestInspection.captureMode);
        if (!root) return;
        const response: PreviewEligibilityMessage = {
            type: 'preview:eligibility',
            sessionId: currentSessionId,
            captureMode: latestInspection.captureMode,
            generation: latestInspection.generation,
            hasEligibleIframes: hasEligibleIframesLightweight(root),
            hasImages: hasImagesInRoot(root, latestInspection.includeIframes),
        };
        port.postMessage(response);
    };

    const scheduleEligibilityRefresh = (): void => {
        if (refreshFrame) return;
        const refresh = () => {
            refreshFrame = 0;
            // Reconcile frame-document observers before re-reading: iframes
            // added to the root since the last refresh (or navigated frames
            // with a replaced document) get a live observer now, so their
            // later mutations keep the toggle fresh. Diff-based and
            // rAF-coalesced, so a no-op when nothing changed.
            reconcileFrameDocumentObservers(cachedRoot ?? document.body);
            postEligibility();
        };
        if (typeof requestAnimationFrame === 'function') {
            refreshFrame = requestAnimationFrame(refresh);
        } else {
            refreshFrame = window.setTimeout(refresh, 0);
        }
    };

    /** Check whether a mutation record is caused by the preview host overlay. */
    const isPreviewHostMutation = (record: MutationRecord): boolean => {
        const target = record.target;
        if (target instanceof Element) {
            if (target.hasAttribute(CONTENT_PREVIEW_HOST_ATTRIBUTE)) return true;
            if (target.closest?.(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`)) return true;
        }
        return false;
    };

    /**
     * Tag-name check (not instanceof): a loaded same-origin frame's document
     * is a separate DOM tree whose nodes belong to the frame's realm, so
     * `instanceof HTMLImageElement` never matches them. Tag names work across
     * realms, keeping frame-document mutations recognizable.
     */
    const hasIframeOrImageTag = (node: unknown): boolean => {
        if (typeof node !== 'object' || node === null) return false;
        const tag = (node as { tagName?: unknown }).tagName;
        return tag === 'IFRAME' || tag === 'IMG';
    };

    /** Check whether a mutation record involves iframes or images. */
    const isCaptureRelevantMutation = (record: MutationRecord): boolean => {
        if (isPreviewHostMutation(record)) return false;

        // Target is an iframe or image element itself (e.g. src attribute change)
        if (hasIframeOrImageTag(record.target)) return true;

        // Added nodes include an iframe or image
        if (record.type === 'childList' && record.addedNodes?.length) {
            const addedRelevant = Array.from(record.addedNodes).some((node) => {
                const element = node as Element;
                if (typeof element.matches !== 'function') return false;
                return element.matches('iframe,img') || !!element.querySelector?.('iframe,img');
            });
            if (addedRelevant) return true;
        }

        // Attribute change on an iframe within the cached root
        if (record.type === 'attributes' && hasIframeOrImageTag(record.target)) {
            if (cachedRoot?.contains(record.target)) return true;
        }

        return false;
    };

    const handleMutations = (records: MutationRecord[]): void => {
        if (!watcherActive) return;
        if (records.some((record) => isCaptureRelevantMutation(record))) {
            scheduleEligibilityRefresh();
        }
    };

    const handleFrameLoad = (event: Event): void => {
        if (!watcherActive) return;
        const target = event.target;
        // Only refresh when the loaded iframe is within the cached root
        if (target instanceof HTMLIFrameElement && cachedRoot?.contains(target)) {
            scheduleEligibilityRefresh();
        }
    };

    const startEligibilityWatcher = (): void => {
        watcherActive = true;
        if (eligibilityObserver) return;
        // Observe the cached root (or document.body fallback), NOT document.documentElement
        const observeTarget = cachedRoot ?? document.body;
        eligibilityObserver = new MutationObserver(handleMutations);
        eligibilityObserver.observe(observeTarget, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['src', 'srcdoc', 'sandbox', 'title'],
        });
        document.addEventListener('load', handleFrameLoad, true);
        reconcileFrameDocumentObservers(observeTarget);
    };

    /**
     * A frame's document is a separate DOM tree: mutations inside an already
     * loaded same-origin frame would never reach the root observer, leaving
     * the toggle stale (e.g. lazy-loaded images inside the frame). Keep one
     * observer per readable top-level frame, bounded by IFRAME_MAX_COUNT,
     * and diff the attachments against the current root so that iframes
     * added after inspection get observed and navigated frames get re-observed
     * (old document disconnected, new document attached).
     * Frames inside frames are intentionally NOT observed here — the watcher
     * restarts on every inspection, so nested content is picked up when a
     * parent frame becomes eligible or the user re-inspects.
     */
    const reconcileFrameDocumentObservers = (observeTarget: HTMLElement): void => {
        const frames = Array.from(observeTarget.querySelectorAll<HTMLIFrameElement>('iframe'));

        // Detach entries whose frame left the root or whose document changed
        // (navigation replaces the frame's document).
        for (const [frame, entry] of frameObserverMap) {
            if (!frames.includes(frame) || entry.document !== readSameOriginFrame(frame)) {
                entry.observer.disconnect();
                frameObserverMap.delete(frame);
            }
        }

        // Attach observers for readable frames not yet tracked.
        for (const frame of frames) {
            if (frameObserverMap.size >= IFRAME_MAX_COUNT) break;
            if (frameObserverMap.has(frame)) continue;
            const frameDocument = readSameOriginFrame(frame);
            if (!frameDocument) continue;
            const observer = new MutationObserver(handleMutations);
            observer.observe(frameDocument, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['src', 'srcdoc', 'sandbox', 'title'],
            });
            frameObserverMap.set(frame, { observer, document: frameDocument });
        }
    };

    const stopEligibilityWatcher = (): void => {
        watcherActive = false;
        eligibilityObserver?.disconnect();
        eligibilityObserver = null;
        for (const { observer } of frameObserverMap.values()) observer.disconnect();
        frameObserverMap.clear();
        document.removeEventListener('load', handleFrameLoad, true);
        if (refreshFrame) {
            if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(refreshFrame);
            else window.clearTimeout(refreshFrame);
            refreshFrame = 0;
        }
    };

    const handleMessage = (msg: unknown) => {
        const cmd = msg as PreviewCommand;

        switch (cmd.type) {
            case 'preview:show': {
                const captureMode = normalizeCaptureMode(cmd.captureMode);
                const root = selectCaptureRoot(captureMode);
                if (!root) {
                    port.postMessage({
                        success: false,
                        error: 'No visible source element found.',
                    });
                    return;
                }
                currentOwner = { port, sessionId: cmd.sessionId, generation };
                preview.show(root);
                port.postMessage({ success: true });
                break;
            }
            case 'preview:inspect': {
                const captureMode = normalizeCaptureMode(cmd.captureMode);
                // Reject stale generation: only accept inspections at or above the current accepted generation
                if (cmd.generation < acceptedInspectionGeneration) return;
                acceptedInspectionGeneration = cmd.generation;
                currentSessionId = cmd.sessionId;
                latestInspection = {
                    captureMode,
                    generation: cmd.generation,
                    // Default false when undefined: with iframes excluded, frame
                    // images never reach the Markdown so they must not count.
                    includeIframes: normalizeIncludeIframes(cmd.includeIframes),
                };
                // Cache the live root from selectCaptureRoot — never derive via getContentForMode
                const newRoot = selectCaptureRoot(captureMode);
                if (newRoot !== cachedRoot) {
                    // Root changed — tear down old watcher, set up new one
                    stopEligibilityWatcher();
                    cachedRoot = newRoot;
                }
                startEligibilityWatcher();
                postEligibility();
                break;
            }
            case 'preview:set-iframes': {
                // Only the current generation may change state
                if (!currentOwner || currentOwner.generation !== generation) return;
                preview.setIncludeIframes(cmd.enabled === true);
                break;
            }

            default: {
                // Only the current generation may change state or remove
                if (!currentOwner || currentOwner.generation !== generation) return;

                if (cmd.type === 'preview:loading') {
                    preview.setLoading();
                } else if (cmd.type === 'preview:ready') {
                    preview.setReady();
                } else if (cmd.type === 'preview:hide') {
                    preview.remove();
                    currentOwner = null;
                }
                break;
            }
        }
    };

    const handleDisconnect = () => {
        port.onMessage.removeListener(handleMessage);
        stopEligibilityWatcher();
        cachedRoot = null;
        // Only the current generation cleans up
        if (currentOwner && currentOwner.generation === generation) {
            preview.remove();
            currentOwner = null;
        }
    };

    port.onMessage.addListener(handleMessage);
    port.onDisconnect.addListener(handleDisconnect);
});

// ── Page Conversion (popup) ───────────────────────────────────────────────────

registerMessageHandler('preview_ready', (_request, _sender, sendResponse) => {
    sendResponse({ success: true });
    return false; // Synchronous response
});

registerMessageHandler('convert_page', (request, _sender, sendResponse) => {
    const msg = request as ConvertPageMessage;
    processPage(
        normalizeCaptureMode(msg.captureMode),
        normalizeIncludeIframes(msg.includeIframes),
    ).then(sendResponse).catch((err) => {
        console.error("Markdownizer Error:", err);
        // Default to technical message if userMessage is not set (for unexpected errors)
        sendResponse({ success: false, error: err.message });
    });
    return true; // Keep channel open for async response
});

/**
 * Main Entry Point: Listen for messages from the popup
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => dispatchMessage(request, sender, sendResponse));

async function requestCodeMirrorCapture(): Promise<CodeMirrorDocumentCapture | null> {
    try {
        const response = await chrome.runtime.sendMessage({ action: 'read_codemirror_capture' });
        if (response?.success && response.capture) {
            return response.capture as CodeMirrorDocumentCapture;
        }
    } catch {
        // Service worker unavailable or execution failed — fall back gracefully
    }
    return null;
}

async function processPage(captureMode: CaptureMode, includeIframes = false) {
    let codeMirrorCapture: CodeMirrorDocumentCapture | null = null;
    // Capture page-owned editor models when needed. Iframe inclusion is
    // required to discover editors inside frames; the direct selector covers
    // editors in the main document without adding a bridge call for ordinary pages.
    if (includeIframes || document.querySelector('.CodeMirror')) {
        codeMirrorCapture = await requestCodeMirrorCapture();
    }

    let extraction = getContentForMode(captureMode, { includeIframes, codeMirrorCapture: codeMirrorCapture ?? undefined });
    if (!extraction) throw new Error('Could not find visible page content.');

    let skeleton = skeletonize(extraction.element);
    if (includeIframes && shouldUseReadability(skeleton.html)) {
        throw new Error('The page and included iframe content are too large to convert. Turn off Include iframes and try again.');
    }
    if (shouldUseReadability(skeleton.html) && captureMode === 'full-page') {
        throw new Error('The full page is too large to convert. Turn off Capture full page to use Smart selection.');
    }

    if (shouldUseReadability(skeleton.html) && captureMode === 'smart') {
        extraction = getReadabilityContent();
        if (!extraction) throw new Error('Could not reduce page content to the supported size.');
        skeleton = skeletonize(extraction.element);
    }

    if (captureMode === 'smart' && shouldUseReadability(skeleton.html)) {
        throw new Error('This page is too large to convert.');
    }

    const { html, tokens } = skeleton;
    const response: BackgroundConversionResponse = await chrome.runtime.sendMessage({
        action: "convert_skeleton",
        payload: {
            html_skeleton: html,
            url: window.location.href,
            client_type: "extension",
            extraction_strategy: extraction.strategy
        }
    });

    if (!response?.success || !response.markdown_skeleton) {
        throw new Error(response?.error || "Could not convert page.");
    }

    const markdown = rehydrateMarkdown(response.markdown_skeleton, tokens);

    return { success: true, markdown };
}
