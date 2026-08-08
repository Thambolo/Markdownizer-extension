import { getOrCreateUserID } from './identity';
import { mapHttpStatusToUserMessage } from './errors';
import { collectCodeMirrorCaptureInMainWorld } from './codemirror-bridge';
import type { CodeMirrorDocumentCapture } from './codemirror-bridge';

const API_URL = import.meta.env.VITE_API_URL;

interface ConvertSkeletonRequest {
    action: "convert_skeleton";
    payload: {
        html_skeleton: string;
        url: string;
        client_type: "extension";
        extraction_strategy: string;
    };
}

interface BuildZipRequest {
    action: 'build_zip';
    buildId: string;
    payload: {
        markdown: string;
        title: string;
        sourceUrl: string | null;
    };
}

interface ZipStatusRequest {
    action: 'zip:status';
    buildId: string;
}

interface ConversionResponse {
    markdown_skeleton: string;
}

// Service Worker
chrome.runtime.onInstalled.addListener(async (details) => {
    if (details.reason === 'install' || details.reason === 'update') {
        await getOrCreateUserID();
    }
});

interface ReadCodeMirrorCaptureRequest {
    action: 'read_codemirror_capture';
}

// ── Message routing ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((
    request: ConvertSkeletonRequest | ReadCodeMirrorCaptureRequest | BuildZipRequest | ZipStatusRequest,
    sender,
    sendResponse: (response: unknown) => void,
) => {
    if (request.action === 'build_zip') {
        handleBuildZip(request as BuildZipRequest, sendResponse);
        return true;
    }

    if (request.action === 'zip:status') {
        handleZipStatus(request as ZipStatusRequest, sendResponse);
        return true;
    }

    if (request.action === 'read_codemirror_capture') {
        handleReadCodeMirrorCapture(sender, sendResponse);
        return true;
    }

    if (request.action !== 'convert_skeleton') return;

    convertSkeleton((request as ConvertSkeletonRequest).payload)
        .then((data) => sendResponse({ success: true, markdown_skeleton: data.markdown_skeleton }))
        .catch((err: unknown) => {
            console.error('Markdownizer API Error:', err);
            const message = err instanceof Error ? err.message : 'Could not convert page.';
            sendResponse({ success: false, error: message });
        });

    return true;
});

async function handleReadCodeMirrorCapture(
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
): Promise<void> {
    const tabId = sender.tab?.id;
    if (tabId == null) {
        sendResponse({ success: false });
        return;
    }

    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [0] },
            world: 'MAIN',
            func: collectCodeMirrorCaptureInMainWorld,
        });

        const capture: CodeMirrorDocumentCapture | undefined = results?.[0]?.result;
        sendResponse({ success: true, capture: capture ?? null });
    } catch {
        sendResponse({ success: false });
    }
}

async function convertSkeleton(payload: ConvertSkeletonRequest["payload"]): Promise<ConversionResponse> {
    const userID = await getOrCreateUserID();

    let response: Response;
    try {
        response = await fetch(API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-User-ID": userID
            },
            body: JSON.stringify(payload)
        });
    } catch (e) {
        throw new Error("Could not reach server. Check your connection.");
    }

    if (!response.ok) {
        throw new Error(mapHttpStatusToUserMessage(response.status, response.statusText));
    }

    return response.json();
}

async function handleBuildZip(request: BuildZipRequest, sendResponse: (response: unknown) => void): Promise<void> {
    const { buildId, payload } = request;
    const startedAt = Date.now();
    const broadcast = (message: Record<string, unknown>): void => {
        chrome.runtime.sendMessage(message).catch(() => {});
    };
    const writeState = (state: Record<string, unknown>): void => {
        chrome.storage.session.set({ activeZipBuild: { buildId, startedAt, ...state } }).catch(() => {});
    };
    const clearState = async (): Promise<void> => {
        // Compare-and-clear: a newer build may have overwritten
        // activeZipBuild while this one was running, so only remove state
        // that still belongs to THIS build. Never throws: a leftover stale
        // state is cleaned up by the next zip:status handler.
        const stored = await chrome.storage.session.get('activeZipBuild').catch(() => ({}));
        const state = (stored as { activeZipBuild?: { buildId?: string } }).activeZipBuild;
        if (state && state.buildId === buildId) {
            await chrome.storage.session.remove('activeZipBuild').catch(() => {});
        }
    };

    try {
        // Dynamic import: the remark/fflate chunk loads only when a zip is
        // actually built, keeping the convert_skeleton cold path light.
        const { buildAndDownloadZip } = await import('./zip-build-service');
        const result = await buildAndDownloadZip(payload.markdown, payload.title, payload.sourceUrl, {
            onProgress: (p) => {
                if (p.phase === 'fetch') {
                    writeState({ phase: 'fetch', fetched: p.fetched, total: p.total });
                    broadcast({ type: 'zip:progress', buildId, phase: 'fetch', fetched: p.fetched, total: p.total });
                } else {
                    writeState({ phase: 'build', fetched: 0, total: 0 });
                    broadcast({ type: 'zip:progress', buildId, phase: 'build' });
                }
            },
            download: async (dataUrl, filename) => {
                // URL.createObjectURL is not available in service workers;
                // data: URLs are the download mechanism.
                await chrome.downloads.download({ url: dataUrl, filename });
            },
        });
        await clearState();
        broadcast({
            type: 'zip:done',
            buildId,
            downloaded: result.downloaded,
            totalImages: result.totalImages,
            bundledImages: result.bundledImages,
            skippedImages: result.skippedImages,
            filename: result.filename,
        });
        sendResponse({ success: true, ...result });
    } catch (err) {
        await clearState();
        // Friendly user-facing message; the raw error goes to the console.
        console.error('Markdownizer zip build failed:', err);
        const message = 'The download failed. Try again.';
        broadcast({ type: 'zip:error', buildId, error: message });
        sendResponse({ success: false, error: message });
    }
}

async function handleZipStatus(request: ZipStatusRequest, sendResponse: (response: unknown) => void): Promise<void> {
    const stored = await chrome.storage.session.get('activeZipBuild');
    const state = stored.activeZipBuild as
        | { buildId?: string; phase?: string; fetched?: number; total?: number }
        | undefined;
    if (state && state.buildId === request.buildId) {
        sendResponse({
            active: true,
            buildId: state.buildId,
            phase: state.phase === 'build' ? 'build' : 'fetch',
            fetched: state.fetched ?? 0,
            total: state.total ?? 0,
        });
        return;
    }
    if (state) {
        await chrome.storage.session.remove('activeZipBuild').catch(() => {});
    }
    sendResponse({ active: false });
}
