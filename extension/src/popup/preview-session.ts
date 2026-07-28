import { PREVIEW_PORT_NAME } from '../preview-protocol';

// ── Public Types ──────────────────────────────────────────────────────────────

export interface PreviewSession {
    show(): void;
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

async function waitForContentScript(tabId: number): Promise<void> {
    try {
        await chrome.tabs.sendMessage(tabId, { action: 'preview_ready' });
        return; // Content script already loaded
    } catch {
        // Content script not present — inject and retry
    }

    const manifest = chrome.runtime.getManifest();
    const contentScriptFile = manifest.content_scripts?.[0]?.js?.[0];

    if (!contentScriptFile) {
        throw new Error('Content script configuration missing in manifest');
    }

    await chrome.scripting.executeScript({
        target: { tabId },
        files: [contentScriptFile],
    });

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

    const send = (type: string) => {
        if (disconnected) return;
        port.postMessage({ type, sessionId });
    };

    return {
        show: () => send('preview:show'),
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
