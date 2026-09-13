import { getOrCreateUserID } from './identity';
import { collectCodeMirrorCaptureInMainWorld } from '../extraction/codemirror-bridge';
import type { CodeMirrorDocumentCapture } from '../extraction/codemirror-bridge';
import { dispatchMessage, registerMessageHandler } from '../shared/messages';
import type {
    BuildZipMessage,
    ConvertSkeletonMessage,
    ZipCompletedBroadcast,
    ZipProgressBroadcast,
    ZipStatusMessage,
} from '../shared/messages';
import { normalizeZipPhase } from '../zip/protocol';
import { convertSkeleton } from './api-client';
import { zipBuildStore } from './zip/build-store';
import { handleBuildZip, handleZipCompleted, handleZipStatus } from './zip/coordinator';

// Service Worker
chrome.runtime.onInstalled.addListener(async (details) => {
    if (details.reason === 'install' || details.reason === 'update') {
        await getOrCreateUserID();
    }
});

// ── Message routing ──────────────────────────────────────────────────────────
// Every runtime message envelope lives in ../shared/messages; each handler
// below is the previous inline listener body moved verbatim. The entry point
// stays a plain chrome.runtime.onMessage listener so the addListener
// contract (same registration shape, return value true = async keep-open) is
// unchanged. The zip handlers live in ./zip/coordinator; the zip state store
// in ./zip/build-store.

registerMessageHandler('convert_skeleton', (request, _sender, sendResponse) => {
    convertSkeleton((request as ConvertSkeletonMessage).payload)
        .then((data) => sendResponse({ success: true, markdown_skeleton: data.markdown_skeleton }))
        .catch((err: unknown) => {
            console.error('Markdownizer API Error:', err);
            const message = err instanceof Error ? err.message : 'Could not convert page.';
            sendResponse({ success: false, error: message });
        });

    return true;
});

registerMessageHandler('build_zip', (request, _sender, sendResponse) => {
    handleBuildZip(request as BuildZipMessage, sendResponse);
    return true;
});

registerMessageHandler('zip:status', (request, _sender, sendResponse) => {
    handleZipStatus(request as ZipStatusMessage, sendResponse);
    return true;
});

registerMessageHandler('read_codemirror_capture', (_request, sender, sendResponse) => {
    void handleReadCodeMirrorCapture(sender, sendResponse);
    return true;
});

registerMessageHandler('zip:completed', (request) => {
    if (typeof (request as { buildId?: unknown }).buildId !== 'string') return;
    void handleZipCompleted(request as ZipCompletedBroadcast);
    return false;
});

registerMessageHandler('zip:progress', (request) => {
    const p = request as ZipProgressBroadcast;
    if (typeof p.buildId !== 'string') return;
    // Compare-and-write INSIDE the store's serialized mutation queue: only
    // write when no build owns the state yet or this build still owns it, so
    // a stale build's late progress tick never clobbers a newer build's state
    // (and the queue closes the read-check-write window storage.session
    // cannot CAS).
    void zipBuildStore.mutate(async (current) => {
        if (current && current.buildId !== p.buildId) return;
        await chrome.storage.session
            .set({
                activeZipBuild: {
                    buildId: p.buildId,
                    startedAt: Date.now(),
                    phase: normalizeZipPhase(p.phase),
                    fetched: p.fetched ?? 0,
                    total: p.total ?? 0,
                },
            })
            .catch(() => {});
    });
    return false;
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => dispatchMessage(request, sender, sendResponse));

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
