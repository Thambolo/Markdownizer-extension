// offscreen-lifecycle.ts — creates/recycles the hidden offscreen document that
// builds the ZIP bundle (P6). All lifecycle operations run on one serialized
// queue so a pending close is always awaited before the next create (no
// close/create race). The active-build counter and the finalize hold window
// that keep the document alive live here; the coordinator drives them via
// beginBuild/endBuild/markBuildFinalized.

const OFFSCREEN_PATH = 'offscreen.html';

let lifecycle: Promise<void> = Promise.resolve();
let activeBuilds = 0;

/** Last successful finalize timestamp: the offscreen document must stay
 * alive for a hold window afterwards so an in-flight blob-anchor download
 * can finish streaming (closing the document revokes its object URLs). */
let lastFinalizeAt = 0;
const OFFSCREEN_HOLD_MS = 30_000;

/** Single coalesced re-arm timer for the hold-window retry, so N finalizes
 * inside one window schedule at most one close attempt. */
let holdTimer: ReturnType<typeof setTimeout> | null = null;

/** Serialize offscreen lifecycle operations: a pending close is always awaited
 * before the next create, so no close/create race is possible. */
function enqueueLifecycle(op: () => Promise<void>): Promise<void> {
    const next = lifecycle.then(op, op);
    lifecycle = next.catch(() => {});
    return next;
}

export async function offscreenDocumentExists(): Promise<boolean> {
    const contexts = await chrome.runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).catch(() => []);
    return (contexts?.length ?? 0) > 0;
}

export function ensureOffscreenDocument(): Promise<void> {
    return enqueueLifecycle(async () => {
        if (await offscreenDocumentExists()) return;
        await chrome.offscreen.createDocument({
            url: chrome.runtime.getURL(OFFSCREEN_PATH),
            reasons: ['BLOBS'],
            justification: 'Builds the page-image ZIP bundle in the background so downloads survive the popup closing.',
        });
    });
}

export function closeOffscreenDocumentIfIdle(): Promise<void> {
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

/** Active-build counter increment: the coordinator calls this on entry to
 * handleBuildZip (before the try) and endBuild() in its finally, so
 * `activeBuilds` stays module-private. */
export function beginBuild(): void {
    activeBuilds += 1;
}

export function endBuild(): void {
    activeBuilds -= 1;
}

/** Record a successful finalize so closeOffscreenDocumentIfIdle() keeps the
 * document alive through the hold window. */
export function markBuildFinalized(): void {
    lastFinalizeAt = Date.now();
}