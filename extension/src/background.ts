import { getOrCreateUserID } from './identity';
import { mapHttpStatusToUserMessage } from './errors';
import { collectCodeMirrorCaptureInMainWorld } from './codemirror-bridge';
import type { CodeMirrorDocumentCapture } from './codemirror-bridge';
import { bytesToDataUrl } from './base64';
import { readPayload, deletePayload } from './idb-payload';

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
    request: ConvertSkeletonRequest | ReadCodeMirrorCaptureRequest | BuildZipRequest | ZipStatusRequest | ZipCompletedMessage | { type: 'zip:progress'; buildId: string },
    sender,
    sendResponse: (response: unknown) => void,
) => {
    // Type-only messages (broadcasts from the offscreen document or popup).
    if ('type' in request) {
        if (request.type === 'zip:completed' && typeof request.buildId === 'string') {
            void handleZipCompleted(request as ZipCompletedMessage);
            return false;
        }
        if (request.type === 'zip:progress' && typeof request.buildId === 'string') {
            const p = request as { phase?: string; fetched?: number; total?: number };
            chrome.storage.session
                .set({
                    activeZipBuild: {
                        buildId: request.buildId,
                        startedAt: Date.now(),
                        phase: p.phase === 'build' ? 'build' : 'fetch',
                        fetched: p.fetched ?? 0,
                        total: p.total ?? 0,
                    },
                })
                .catch(() => {});
            return false;
        }
        return;
    }

    // Action-based messages (unchanged routing below).
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

// ── Offscreen zip-build orchestration ───────────────────────────────────────

const OFFSCREEN_PATH = 'offscreen.html';

let lifecycle: Promise<void> = Promise.resolve();
let activeBuilds = 0;

/** Builds whose finalization has already been claimed in THIS worker
 * instance. Both the primary response path and the zip:completed recovery
 * path funnel through finalizeBuild; the Set claim makes exactly one of them
 * download (in-memory claim is atomic within an instance, and a restarted
 * instance's recovery cannot collide with the dead instance's response path). */
const completedBuilds = new Set<string>();

/** Serialize offscreen lifecycle operations: a pending close is always awaited
 * before the next create, so no close/create race is possible. */
function enqueueLifecycle(op: () => Promise<void>): Promise<void> {
    const next = lifecycle.then(op, op);
    lifecycle = next.catch(() => {});
    return next;
}

async function offscreenDocumentExists(): Promise<boolean> {
    const contexts = await chrome.runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).catch(() => []);
    return (contexts?.length ?? 0) > 0;
}

function ensureOffscreenDocument(): Promise<void> {
    return enqueueLifecycle(async () => {
        if (await offscreenDocumentExists()) return;
        await chrome.offscreen.createDocument({
            url: chrome.runtime.getURL(OFFSCREEN_PATH),
            reasons: ['BLOBS'],
            justification: 'Builds the page-image ZIP bundle in the background so downloads survive the popup closing.',
        });
    });
}

function closeOffscreenDocumentIfIdle(): Promise<void> {
    return enqueueLifecycle(async () => {
        if (activeBuilds > 0) return;
        await chrome.offscreen.closeDocument().catch(() => {});
    });
}

const broadcast = (message: Record<string, unknown>): void => {
    chrome.runtime.sendMessage(message).catch(() => {});
};

interface ZipDoneMetadata {
    downloaded: 'zip' | 'md';
    filename: string;
    totalImages: number;
    bundledImages: number;
    skippedImages: number;
}

/**
 * Single finalization funnel for a completed build (download + done broadcast
 * + state clear). Exactly one caller proceeds per build: the in-memory Set
 * claim is checked+added synchronously, so the primary response path and the
 * zip:completed recovery path cannot both download within one worker
 * instance; across instances, only the instance whose storage still matches
 * the buildId proceeds (the other finds the state cleared).
 */
async function finalizeBuild(buildId: string, metadata: ZipDoneMetadata): Promise<void> {
    if (completedBuilds.has(buildId)) return;
    completedBuilds.add(buildId);

    await chrome.storage.session.remove('activeZipBuild').catch(() => {});
    try {
        const bytes = await readPayload(buildId);
        const mime = metadata.downloaded === 'md' ? 'text/markdown' : 'application/zip';
        await chrome.downloads.download({ url: bytesToDataUrl(bytes, mime), filename: metadata.filename });
        broadcast({
            type: 'zip:done',
            buildId,
            downloaded: metadata.downloaded,
            totalImages: metadata.totalImages,
            bundledImages: metadata.bundledImages,
            skippedImages: metadata.skippedImages,
            filename: metadata.filename,
        });
    } catch (err) {
        console.error('Markdownizer zip finalization failed:', err);
        broadcast({ type: 'zip:error', buildId, error: 'The download failed. Try again.' });
    } finally {
        await deletePayload(buildId).catch(() => {});
    }
}

async function handleBuildZip(request: BuildZipRequest, sendResponse: (response: unknown) => void): Promise<void> {
    const { buildId, payload } = request;
    const startedAt = Date.now();
    // Progress writes are monotonic fire-and-forget snapshots; the INITIAL
    // write is awaited below so a fast build cannot clear state before it
    // lands (which would leave a stale activeZipBuild behind forever).
    const writeState = (state: Record<string, unknown>): Promise<void> => {
        return chrome.storage.session
            .set({ activeZipBuild: { buildId, startedAt, ...state } })
            .then(() => undefined, () => undefined);
    };

    if (!chrome.offscreen?.createDocument) {
        const error = 'This browser does not support background ZIP downloads. Update your browser and try again.';
        broadcast({ type: 'zip:error', buildId, error });
        sendResponse({ success: false, error });
        return;
    }

    activeBuilds += 1;
    try {
        await ensureOffscreenDocument();
        await writeState({ phase: 'fetch', fetched: 0, total: 0 });

        const result = (await chrome.runtime.sendMessage({
            type: 'offscreen:build',
            buildId,
            payload,
        })) as
            | { ok: boolean; error?: string; downloaded?: 'zip' | 'md'; filename?: string; totalImages?: number; bundledImages?: number; skippedImages?: number }
            | undefined;

        if (!result?.ok) {
            throw new Error(result?.error || 'The download could not be built.');
        }

        // The payload never travels in messages: it was stored in IndexedDB.
        // The recovery path may already have finalized this build (its
        // zip:completed broadcast can beat the response channel); the Set
        // claim in finalizeBuild makes double downloads impossible.
        await finalizeBuild(buildId, {
            downloaded: result.downloaded ?? 'md',
            filename: result.filename ?? 'download',
            totalImages: result.totalImages ?? 0,
            bundledImages: result.bundledImages ?? 0,
            skippedImages: result.skippedImages ?? 0,
        });
        // Metadata only — never the payload.
        sendResponse({
            success: true,
            downloaded: result.downloaded,
            filename: result.filename,
            totalImages: result.totalImages,
            bundledImages: result.bundledImages,
            skippedImages: result.skippedImages,
        });
    } catch (err) {
        await chrome.storage.session.remove('activeZipBuild').catch(() => {});
        console.error('Markdownizer zip build failed:', err);
        const message = 'The download failed. Try again.';
        broadcast({ type: 'zip:error', buildId, error: message });
        sendResponse({ success: false, error: message });
    } finally {
        await deletePayload(buildId).catch(() => {});
        activeBuilds -= 1;
        await closeOffscreenDocumentIfIdle();
    }
}

interface ZipCompletedMessage {
    type: 'zip:completed';
    buildId: string;
    ok: boolean;
    downloaded?: 'zip' | 'md';
    filename?: string;
    totalImages?: number;
    bundledImages?: number;
    skippedImages?: number;
    error?: string;
}

/**
 * Recovery path: the service worker may have been killed while the offscreen
 * document kept building. Process completion only when storage still matches
 * this buildId (a fresh worker instance), then funnel through finalizeBuild —
 * the Set claim makes it idempotent within an instance, and the storage
 * guard makes it idempotent across instances.
 */
async function handleZipCompleted(message: ZipCompletedMessage): Promise<void> {
    const stored = await chrome.storage.session.get('activeZipBuild').catch(() => ({}));
    const state = (stored as { activeZipBuild?: { buildId?: string } }).activeZipBuild;
    if (!state || state.buildId !== message.buildId) return;

    if (!message.ok) {
        await chrome.storage.session.remove('activeZipBuild').catch(() => {});
        broadcast({ type: 'zip:error', buildId: message.buildId, error: message.error ?? 'The download failed. Try again.' });
        return;
    }
    await finalizeBuild(message.buildId, {
        downloaded: message.downloaded ?? 'md',
        filename: message.filename ?? 'download',
        totalImages: message.totalImages ?? 0,
        bundledImages: message.bundledImages ?? 0,
        skippedImages: message.skippedImages ?? 0,
    });
    // Close through the serialized lifecycle (respects the active counter so
    // a concurrently running build in this instance is never torn down).
    await closeOffscreenDocumentIfIdle();
}

async function handleZipStatus(request: ZipStatusRequest, sendResponse: (response: unknown) => void): Promise<void> {
    const stored = await chrome.storage.session.get('activeZipBuild');
    const state = stored.activeZipBuild as
        | { buildId?: string; phase?: string; fetched?: number; total?: number }
        | undefined;
    if (state && state.buildId === request.buildId) {
        // Orphan check: if no offscreen document exists, the build cannot be
        // running anymore — clear the stale state.
        if (chrome.offscreen?.createDocument) {
            const exists = await offscreenDocumentExists();
            if (!exists) {
                await chrome.storage.session.remove('activeZipBuild').catch(() => {});
                sendResponse({ active: false });
                return;
            }
        }
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
