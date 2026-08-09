// offscreen.ts - Hidden offscreen document that executes ZIP builds.
// Only the chrome.runtime extension API is available here. The produced
// payload bytes are stored in IndexedDB (idb-payload) and never travel in
// runtime messages; the service worker performs the download.

import { buildZipResult } from './zip-build-service';
import { savePayload } from './idb-payload';

interface OffscreenBuildRequest {
    type: 'offscreen:build';
    buildId: string;
    payload: {
        markdown: string;
        title: string;
        sourceUrl: string | null;
    };
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
            await savePayload(buildId, result.bytes);
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
