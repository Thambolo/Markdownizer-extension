import { PREVIEW_PORT_NAME, type CaptureMode } from '../preview-protocol';

// ── Public Types ──────────────────────────────────────────────────────────────

export interface PreviewSession {
    show(captureMode: CaptureMode): void;
    setLoading(): void;
    setReady(): void;
    hide(): void;
    disconnect(): void;
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
    const contentScript = chrome.runtime.getManifest().content_scripts?.[0];
    const contentScriptFile = contentScript?.js?.[0];

    if (!contentScriptFile) {
        throw new Error('Content script configuration missing in manifest');
    }

    const contentStyleFile = contentScript?.css?.[0];
    if (contentStyleFile) {
        await chrome.scripting.insertCSS({
            target: { tabId },
            files: [contentStyleFile],
        });
    }

    await chrome.scripting.executeScript({
        target: { tabId },
        files: [contentScriptFile],
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
        setLoading: () => send('preview:loading'),
        setReady: () => send('preview:ready'),
        hide: () => send('preview:hide'),
        disconnect: () => {
            if (disconnected) return;
            disconnected = true;
            port.disconnect();
        },
    };
}
