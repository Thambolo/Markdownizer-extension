import contentScriptPath from '../content.ts?script';
import contentStylePath from '../content-preview.css?url';

import {
    PREVIEW_PORT_NAME,
    type CaptureMode,
    type PreviewEligibilityMessage,
} from '../preview-protocol';

// ── Public Types ──────────────────────────────────────────────────────────────

export interface PreviewSession {
    show(captureMode: CaptureMode): void;
    inspect(captureMode: CaptureMode, generation: number, includeIframes?: boolean): void;
    onEligibility(listener: (message: PreviewEligibilityMessage) => void): () => void;
    setLoading(): void;
    setReady(): void;
    hide(): void;
    disconnect(): void;
    setIncludeIframes(enabled: boolean): void;
}

// ── Supported-URL Check ──────────────────────────────────────────────────────

export function isSupportedPageUrl(url?: string): boolean {
    if (!url) return false;

    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

// ── Content-Script Readiness ─────────────────────────────────────────────────

const RETRY_INTERVAL_MS = 200;
const MAX_RETRIES = 5;

export async function injectContentScript(tabId: number): Promise<void> {
    // Vite emits extension-relative paths for these imports. Strip a leading
    // slash when running from an extension page so Chrome's scripting APIs get
    // a path relative to the extension root. The manifest fallback keeps the
    // test/dev mock path working when Vite does not process ?script imports.
    const manifestContentScript = chrome.runtime.getManifest().content_scripts?.[0];
    const scriptFile = (typeof contentScriptPath === 'string'
        ? contentScriptPath
        : manifestContentScript?.js?.[0])?.replace(/^\/+/, '');
    const styleFile = (typeof contentStylePath === 'string'
        ? contentStylePath
        : manifestContentScript?.css?.[0])?.replace(/^\/+/, '');

    if (!scriptFile) {
        throw new Error('Content script asset unavailable');
    }

    if (styleFile) {
        await chrome.scripting.insertCSS({
            target: { tabId },
            files: [styleFile],
        });
    }

    await chrome.scripting.executeScript({
        target: { tabId },
        files: [scriptFile],
    });
}

async function waitForContentScript(tabId: number): Promise<void> {
    try {
        await chrome.tabs.sendMessage(tabId, { action: 'preview_ready' });
        return; // Content script already loaded
    } catch {
        // Content script not present — inject and retry
    }

    await injectContentScript(tabId);

    let lastError: unknown;
    for (let i = 0; i < MAX_RETRIES; i++) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
        try {
            await chrome.tabs.sendMessage(tabId, { action: 'preview_ready' });
            return;
        } catch (err) {
            lastError = err;
        }
    }

    throw lastError || new Error('Failed to establish connection to content script');
}

// ── Session Factory ──────────────────────────────────────────────────────────

export async function openPreviewSession(tabId: number): Promise<PreviewSession> {
    await waitForContentScript(tabId);

    const sessionId = crypto.randomUUID();
    const port = chrome.tabs.connect(tabId, { name: PREVIEW_PORT_NAME });

    let disconnected = false;

    const eligibilityListeners = new Set<(message: PreviewEligibilityMessage) => void>();
    const handleMessage = (message: unknown) => {
        if (!message || typeof message !== 'object' || (message as { type?: unknown }).type !== 'preview:eligibility') return;
        const eligibility = message as PreviewEligibilityMessage;
        if (eligibility.sessionId !== sessionId) return;
        eligibilityListeners.forEach((listener) => listener(eligibility));
    };
    port.onMessage.addListener(handleMessage);

    const send = (type: string, captureMode?: CaptureMode) => {
        if (disconnected) return;
        const message: Record<string, unknown> = { type, sessionId };
        if (captureMode) {
            message.captureMode = captureMode;
        }
        port.postMessage(message);
    };

    return {
        show: (captureMode: CaptureMode) => send('preview:show', captureMode),
        inspect: (captureMode: CaptureMode, generation: number, includeIframes?: boolean) => {
            if (disconnected) return;
            port.postMessage({
                type: 'preview:inspect',
                sessionId,
                captureMode,
                generation,
                ...(includeIframes === undefined ? {} : { includeIframes }),
            });
        },
        onEligibility: (listener: (message: PreviewEligibilityMessage) => void) => {
            if (disconnected) return () => {};
            eligibilityListeners.add(listener);
            return () => eligibilityListeners.delete(listener);
        },
        setLoading: () => send('preview:loading'),
        setReady: () => send('preview:ready'),
        hide: () => send('preview:hide'),
        setIncludeIframes: (enabled: boolean) => {
            if (disconnected) return;
            port.postMessage({ type: 'preview:set-iframes', sessionId, enabled });
        },
        disconnect: () => {
            if (disconnected) return;
            disconnected = true;
            port.onMessage.removeListener(handleMessage);
            eligibilityListeners.clear();
            port.disconnect();
        },
    };
}
