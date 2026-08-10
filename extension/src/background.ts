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
            // Compare-and-write INSIDE the serialized mutation queue: only
            // write when no build owns the state yet or this build still
            // owns it, so a stale build's late progress tick never clobbers
            // a newer build's state (and the queue closes the read-check-
            // write window storage.session cannot CAS).
            void mutateZipBuild(async (current) => {
                if (current && current.buildId !== request.buildId) return;
                await chrome.storage.session
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
            });
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

/** Finalization outcomes per build, keyed by buildId. The Map entry is the
 * atomic claim: the first caller (primary response path or zip:completed
 * recovery path) creates the in-flight promise; any later caller awaits the
 * claimer's ACTUAL outcome, so the response path reports the truth in every
 * interleaving — including when the recovery path settled before the
 * offscreen:build response arrived. Entries live for the instance's
 * lifetime; a restarted instance's recovery cannot collide with the dead
 * instance's response path (storage guard). The claim now guards double
 * zip:done broadcasts (the download itself happens in the offscreen). */
const finalizations = new Map<string, Promise<void>>();

/** Last successful finalize timestamp: the offscreen document must stay
 * alive for a hold window afterwards so an in-flight blob-anchor download
 * can finish streaming (closing the document revokes its object URLs). */
let lastFinalizeAt = 0;
const OFFSCREEN_HOLD_MS = 30_000;

/** Single coalesced re-arm timer for the hold-window retry, so N finalizes
 * inside one window schedule at most one close attempt. */
let holdTimer: ReturnType<typeof setTimeout> | null = null;

interface ActiveZipBuildState {
    buildId?: string;
    phase?: string;
    fetched?: number;
    total?: number;
    startedAt?: number;
}

let zipStateQueue: Promise<void> = Promise.resolve();

/**
 * Serialize every activeZipBuild read-check-write/remove through one queue:
 * storage.session has no CAS, so without this a stale build's mutation can
 * land between another build's read and write. Each op runs with the CURRENT
 * stored state passed in; the queue is per worker instance (a restarted
 * instance's recovery path reads fresh storage and cannot interleave).
 */
function mutateZipBuild(
    op: (current: ActiveZipBuildState | undefined) => void | Promise<void>,
): Promise<void> {
    const next = zipStateQueue.then(async () => {
        const stored = await chrome.storage.session.get('activeZipBuild').catch(() => ({}));
        const current = (stored as { activeZipBuild?: ActiveZipBuildState }).activeZipBuild;
        await op(current);
    });
    zipStateQueue = next.catch(() => {});
    return next;
}

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
        if (Date.now() - lastFinalizeAt < OFFSCREEN_HOLD_MS) {
            // A blob-anchor download from the offscreen document may still be
            // streaming; closing the document would revoke its object URL.
            // Retry after the hold window (single coalesced timer). Best-
            // effort: a service-worker idle-kill mid-hold orphans the
            // document until the next build reuses it (matches handleZipStatus
            // orphan semantics).
            if (holdTimer === null) {
                holdTimer = setTimeout(() => {
                    holdTimer = null;
                    void closeOffscreenDocumentIfIdle();
                }, OFFSCREEN_HOLD_MS);
            }
            return;
        }
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

// ── Download-appearance watchdog ────────────────────────────────────────────
// The offscreen document downloads the payload via a blob-anchor click, which
// reports no failure: a policy-blocked download would otherwise look like
// success. This watchdog verifies a download item actually appeared after a
// finalized build and broadcasts zip:error when none does.
const DOWNLOAD_WATCH_MS = 10_000;
const DOWNLOAD_POLL_MS = 1_000;
/** Download ids that existed before the first build's anchor click in this
 * worker instance. Snapshot ONCE per instance: a per-arrival refresh would
 * race with an overlapping build (its already-clicked item could be absorbed
 * into the snapshot, causing a false zip:error). Every anchor click happens
 * after its own arrival, which is after the first arrival, so every build's
 * item counts as new. */
let knownDownloadIds = new Set<number>();
let downloadSnapshotTaken = false;
/** Single global watchdog: a second arm supersedes (the popup's buildId guard
 * drops any mis-attributed error). */
let downloadWatchTimer: ReturnType<typeof setTimeout> | null = null;

/** Baseline of pre-existing download ids; awaited before the first build
 * dispatches to the offscreen. No-op when the API is missing (e.g. the dist
 * smoke's mocked chrome) or after the first snapshot. */
async function snapshotDownloadIds(): Promise<void> {
    if (downloadSnapshotTaken) return;
    if (!chrome.downloads?.search) return;
    try {
        const items = await chrome.downloads.search({});
        knownDownloadIds = new Set(items.map((i) => i.id));
        downloadSnapshotTaken = true;
    } catch {
        // Leave the snapshot empty; the watchdog treats every item as new.
    }
}

/** Poll for a new (non-interrupted) download item; broadcast zip:error when
 * none appears within the window. Success precedence: any new item that is
 * complete/in_progress wins over unrelated interrupted items. */
function watchDownloadAppearance(buildId: string): void {
    if (!chrome.downloads?.search) return;
    if (downloadWatchTimer !== null) return;
    const deadline = Date.now() + DOWNLOAD_WATCH_MS;
    const poll = (): void => {
        if (Date.now() >= deadline) {
            downloadWatchTimer = null;
            broadcast({ type: 'zip:error', buildId, error: 'The download failed. Try again.' });
            return;
        }
        chrome.downloads
            .search({})
            .then((items) => {
                const fresh = items.filter((i) => !knownDownloadIds.has(i.id));
                if (fresh.some((i) => i.state === 'complete' || i.state === 'in_progress')) {
                    downloadWatchTimer = null; // an item is downloading: success
                    return;
                }
                if (fresh.some((i) => i.state === 'interrupted')) {
                    downloadWatchTimer = null;
                    broadcast({ type: 'zip:error', buildId, error: 'The download failed. Try again.' });
                    return;
                }
                downloadWatchTimer = setTimeout(poll, DOWNLOAD_POLL_MS);
            })
            .catch(() => {
                // Transient API error: keep polling, never a false error.
                downloadWatchTimer = setTimeout(poll, DOWNLOAD_POLL_MS);
            });
    };
    poll();
}

/**
 * Single finalization funnel for a completed build (done broadcast + state
 * clear). The payload was already downloaded by the offscreen document; this
 * only clears the tracked state and tells the popup the download started.
 * Exactly one caller proceeds per build: the first caller claims by creating
 * the Map entry synchronously, so the primary response path and the
 * zip:completed recovery path cannot both broadcast within one worker
 * instance; across instances, only the instance whose storage still matches
 * the buildId proceeds (the other finds the state cleared).
 */
async function finalizeBuild(buildId: string, metadata: ZipDoneMetadata): Promise<void> {
    const claimed = finalizations.get(buildId);
    if (claimed) return claimed;

    const promise = (async (): Promise<void> => {
        // Compare-and-clear INSIDE the serialized queue: remove the active
        // state only when it still belongs to this build, so a newer
        // build's state survives.
        await mutateZipBuild(async (current) => {
            if (current?.buildId === buildId) {
                await chrome.storage.session.remove('activeZipBuild').catch(() => {});
            }
        });
        broadcast({
            type: 'zip:done',
            buildId,
            downloaded: metadata.downloaded,
            totalImages: metadata.totalImages,
            bundledImages: metadata.bundledImages,
            skippedImages: metadata.skippedImages,
            filename: metadata.filename,
        });
        lastFinalizeAt = Date.now();
        watchDownloadAppearance(buildId);
    })();

    finalizations.set(buildId, promise);
    return promise;
}

async function handleBuildZip(request: BuildZipRequest, sendResponse: (response: unknown) => void): Promise<void> {
    const { buildId, payload } = request;
    const startedAt = Date.now();
    // Progress writes are monotonic fire-and-forget snapshots; the INITIAL
    // write is awaited below so a fast build cannot clear state before it
    // lands (which would leave a stale activeZipBuild behind forever). The
    // write runs INSIDE the serialized queue, still unconditionally — the
    // "newest build claims state" transition, made atomic against every
    // other activeZipBuild mutation.
    const writeState = (state: Record<string, unknown>): Promise<void> => {
        return mutateZipBuild(() =>
            chrome.storage.session
                .set({ activeZipBuild: { buildId, startedAt, ...state } })
                .catch(() => {}),
        );
    };

    if (!chrome.offscreen?.createDocument) {
        const error = 'This browser does not support background ZIP downloads. Update your browser and try again.';
        broadcast({ type: 'zip:error', buildId, error });
        sendResponse({ success: false, error });
        return;
    }

    activeBuilds += 1;
    try {
        await snapshotDownloadIds();
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

        // The payload never travels in messages: the offscreen downloads the
        // built bytes directly via a blob anchor.
        // The offscreen already downloaded the payload; finalize only
        // clears state and broadcasts zip:done. Metadata only — never the
        // payload.
        await finalizeBuild(buildId, {
            downloaded: result.downloaded ?? 'md',
            filename: result.filename ?? 'download',
            totalImages: result.totalImages ?? 0,
            bundledImages: result.bundledImages ?? 0,
            skippedImages: result.skippedImages ?? 0,
        });
        sendResponse({
            success: true,
            downloaded: result.downloaded,
            filename: result.filename,
            totalImages: result.totalImages,
            bundledImages: result.bundledImages,
            skippedImages: result.skippedImages,
        });
    } catch (err) {
        // Compare-and-clear INSIDE the serialized queue: remove the active
        // state only when it still belongs to this build (mirrors
        // finalizeBuild), so a newer build's in-progress state survives an
        // older build's failure.
        await mutateZipBuild(async (current) => {
            if (current?.buildId === buildId) {
                await chrome.storage.session.remove('activeZipBuild').catch(() => {});
            }
        });
        console.error('Markdownizer zip build failed:', err);
        const message = 'The download failed. Try again.';
        broadcast({ type: 'zip:error', buildId, error: message });
        sendResponse({ success: false, error: message });
    } finally {
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
 * the Map claim makes it idempotent within an instance, and the storage
 * guard makes it idempotent across instances.
 */
async function handleZipCompleted(message: ZipCompletedMessage): Promise<void> {
    // Read-only early return (no mutation, so it stays outside the queue);
    // every mutation below runs as a queued compare-and-clear.
    const stored = await chrome.storage.session.get('activeZipBuild').catch(() => ({}));
    const state = (stored as { activeZipBuild?: { buildId?: string } }).activeZipBuild;
    if (!state || state.buildId !== message.buildId) return;

    if (!message.ok) {
        await mutateZipBuild(async (current) => {
            if (current?.buildId === message.buildId) {
                await chrome.storage.session.remove('activeZipBuild').catch(() => {});
            }
        });
        broadcast({ type: 'zip:error', buildId: message.buildId, error: message.error ?? 'The download failed. Try again.' });
        // No response-path finally runs here (this branch handles the
        // SW-restart failure case), so close the document explicitly.
        await closeOffscreenDocumentIfIdle();
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
    // The read-check-remove runs INSIDE the serialized queue so the orphan
    // clear (and the mismatched-build clear below) cannot interleave with
    // another build's claim.
    await mutateZipBuild(async (state) => {
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
    });
}
