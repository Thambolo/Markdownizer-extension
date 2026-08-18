import {
    PREVIEW_PORT_NAME,
    type CaptureMode,
    type PreviewEligibilityMessage,
} from '../shared/preview-protocol';
import { waitForContentScript } from './content-script-loader';

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
