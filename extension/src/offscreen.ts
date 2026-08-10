// offscreen.ts - Hidden offscreen document that executes ZIP builds.
// Only the chrome.runtime extension API is available here. The produced
// payload bytes are downloaded directly from this document via a blob URL
// + anchor click (data: URLs through chrome.downloads would block the
// browser UI thread for large payloads); the service worker only
// finalizes state and broadcasts.

import { buildZipResult } from './zip-build-service';

interface OffscreenBuildRequest {
    type: 'offscreen:build';
    buildId: string;
    payload: {
        markdown: string;
        title: string;
        sourceUrl: string | null;
    };
}

/**
 * Download bytes as a file via a blob URL + anchor click. Renderer-side
 * download: the browser UI thread stays responsive (a data: URL through
 * chrome.downloads blocks it for seconds on MB-scale payloads). The object
 * URL is revoked after 30 s — the SW defers closing this document for the
 * same window so the download can finish streaming the blob (closing the
 * document would revoke its object URLs).
 */
function triggerBlobDownload(bytes: Uint8Array<ArrayBuffer>, downloaded: 'zip' | 'md', filename: string): void {
    const mime = downloaded === 'zip' ? 'application/zip' : 'text/markdown';
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    const request = message as OffscreenBuildRequest | null;
    if (!request || typeof request !== 'object' || request.type !== 'offscreen:build') return;

    const { buildId, payload } = request;
    const broadcast = (msg: Record<string, unknown>): void => {
        chrome.runtime.sendMessage(msg).catch(() => {});
    };

    void (async () => {
        try {
            const result = await buildZipResult(payload.markdown, payload.title, payload.sourceUrl, {
                onProgress: (p) => {
                    if (p.phase === 'fetch') {
                        broadcast({ type: 'zip:progress', buildId, phase: 'fetch', fetched: p.fetched, total: p.total });
                    } else {
                        broadcast({ type: 'zip:progress', buildId, phase: 'build' });
                    }
                },
            });
            // Download BEFORE responding: the SW closes this document after
            // finalize, so the anchor click must happen while it is alive.
            triggerBlobDownload(result.bytes, result.downloaded, result.filename);
            sendResponse({
                ok: true,
                buildId,
                downloaded: result.downloaded,
                filename: result.filename,
                totalImages: result.totalImages,
                bundledImages: result.bundledImages,
                skippedImages: result.skippedImages,
            });
            // Recovery signal for a service worker that was killed mid-build.
            // Carries the image counts so the recovered zip:done broadcast can
            // reproduce the popup's "Included N of M images" note.
            broadcast({
                type: 'zip:completed',
                buildId,
                ok: true,
                downloaded: result.downloaded,
                filename: result.filename,
                totalImages: result.totalImages,
                bundledImages: result.bundledImages,
                skippedImages: result.skippedImages,
            });
        } catch (err) {
            const error = err instanceof Error ? err.message : 'ZIP build failed.';
            sendResponse({ ok: false, buildId, error });
            broadcast({ type: 'zip:completed', buildId, ok: false, error });
        }
    })();

    return true; // async response
});
