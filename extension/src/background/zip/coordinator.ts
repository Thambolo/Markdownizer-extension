// coordinator.ts — the background's zip-build orchestration (P6): the four
// message handlers plus the single finalization funnel. The claim-dedup Map
// lives here with finalizeBuild (not in the lifecycle module): the Map entry
// is the atomic claim that makes the primary response path and the
// zip:completed recovery path converge on exactly one zip:done broadcast per
// build within a worker instance.

import type {
    BuildZipMessage,
    ZipCompletedBroadcast,
    ZipStatusMessage,
} from '../../shared/messages';
import { normalizeZipPhase, withZipDoneDefaults } from '../../zip/protocol';
import type { ActiveZipBuildState, ZipDoneMetadata } from '../../zip/protocol';
import { zipBuildStore } from './build-store';
import {
    beginBuild,
    closeOffscreenDocumentIfIdle,
    endBuild,
    ensureOffscreenDocument,
    markBuildFinalized,
    offscreenDocumentExists,
} from './offscreen-lifecycle';
import { snapshotDownloadIds, watchDownloadAppearance } from './download-watchdog';

const broadcast = (message: Record<string, unknown>): void => {
    chrome.runtime.sendMessage(message).catch(() => {});
};

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
        // Compare-and-clear INSIDE the store's serialized queue: remove the
        // active state only when it still belongs to this build, so a newer
        // build's state survives.
        await zipBuildStore.clearIfOwned(buildId);
        broadcast({
            type: 'zip:done',
            buildId,
            downloaded: metadata.downloaded,
            totalImages: metadata.totalImages,
            bundledImages: metadata.bundledImages,
            skippedImages: metadata.skippedImages,
            filename: metadata.filename,
        });
        markBuildFinalized();
        watchDownloadAppearance(buildId);
    })();

    finalizations.set(buildId, promise);
    return promise;
}

export async function handleBuildZip(request: BuildZipMessage, sendResponse: (response: unknown) => void): Promise<void> {
    const { buildId, payload } = request;
    const startedAt = Date.now();
    // Progress writes are monotonic fire-and-forget snapshots; the INITIAL
    // write is awaited below so a fast build cannot clear state before it
    // lands (which would leave a stale activeZipBuild behind forever). The
    // write runs INSIDE the store's serialized queue, still unconditionally —
    // the "newest build claims state" transition, made atomic against every
    // other activeZipBuild mutation.
    const writeState = (state: Partial<Omit<ActiveZipBuildState, 'buildId' | 'startedAt'>>): Promise<void> => {
        return zipBuildStore.claim({ buildId, startedAt, ...state });
    };

    if (!chrome.offscreen?.createDocument) {
        const error = 'This browser does not support background ZIP downloads. Update your browser and try again.';
        broadcast({ type: 'zip:error', buildId, error });
        sendResponse({ success: false, error });
        return;
    }

    beginBuild();
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
        await finalizeBuild(buildId, withZipDoneDefaults({
            downloaded: result.downloaded,
            filename: result.filename,
            totalImages: result.totalImages,
            bundledImages: result.bundledImages,
            skippedImages: result.skippedImages,
        }));
        sendResponse({
            success: true,
            downloaded: result.downloaded,
            filename: result.filename,
            totalImages: result.totalImages,
            bundledImages: result.bundledImages,
            skippedImages: result.skippedImages,
        });
    } catch (err) {
        // Compare-and-clear INSIDE the store's serialized queue: remove the
        // active state only when it still belongs to this build (mirrors
        // finalizeBuild), so a newer build's in-progress state survives an
        // older build's failure.
        await zipBuildStore.clearIfOwned(buildId);
        console.error('Markdownizer zip build failed:', err);
        const message = 'The download failed. Try again.';
        broadcast({ type: 'zip:error', buildId, error: message });
        sendResponse({ success: false, error: message });
    } finally {
        endBuild();
        await closeOffscreenDocumentIfIdle();
    }
}

/**
 * Recovery path: the service worker may have been killed while the offscreen
 * document kept building. Process completion only when storage still matches
 * this buildId (a fresh worker instance), then funnel through finalizeBuild —
 * the Map claim makes it idempotent within an instance, and the storage
 * guard makes it idempotent across instances.
 */
export async function handleZipCompleted(message: ZipCompletedBroadcast): Promise<void> {
    // Read-only early return (no mutation, so it stays outside the queue);
    // every mutation below runs as a queued compare-and-clear.
    const state = await zipBuildStore.get();
    if (!state || state.buildId !== message.buildId) return;

    if (!message.ok) {
        await zipBuildStore.clearIfOwned(message.buildId);
        broadcast({ type: 'zip:error', buildId: message.buildId, error: message.error ?? 'The download failed. Try again.' });
        // No response-path finally runs here (this branch handles the
        // SW-restart failure case), so close the document explicitly.
        await closeOffscreenDocumentIfIdle();
        return;
    }
    await finalizeBuild(message.buildId, withZipDoneDefaults({
        downloaded: message.downloaded,
        filename: message.filename,
        totalImages: message.totalImages,
        bundledImages: message.bundledImages,
        skippedImages: message.skippedImages,
    }));
    // Close through the serialized lifecycle (respects the active counter so
    // a concurrently running build in this instance is never torn down).
    await closeOffscreenDocumentIfIdle();
}

export async function handleZipStatus(request: ZipStatusMessage, sendResponse: (response: unknown) => void): Promise<void> {
    // The read-check-remove runs INSIDE the store's serialized queue so the
    // orphan clear (and the mismatched-build clear below) cannot interleave
    // with another build's claim. The clears stay DIRECT storage calls (not
    // clearIfOwned): this whole body is already one queued op, and a nested
    // queued call would deadlock the store's queue.
    await zipBuildStore.mutate(async (state) => {
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
                phase: normalizeZipPhase(state.phase),
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