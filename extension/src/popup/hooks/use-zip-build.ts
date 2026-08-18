import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { ZipDoneBroadcast, ZipErrorBroadcast, ZipProgressBroadcast } from '../../shared/messages';
import { normalizeZipPhase, type ActiveZipBuildState } from '../../zip/protocol';

interface ZipBuildState {
    buildId: string;
    phase: 'fetch' | 'build';
    fetched: number;
    total: number;
}

/** Zip build lifecycle: broadcast relay (progress strip + download notes),
 * in-flight restore on popup reopen, and the build_zip request. Owns the
 * "Downloaded!" flash state shared with useConversion's downloadFile. */
export function useZipBuild() {
    const [zipBuild, setZipBuildStateRaw] = useState<ZipBuildState | null>(null);
    const zipBuildRef = useRef<ZipBuildState | null>(null);
    // The most recent zip build's id. Unlike zipBuildRef (nulled on zip:done so
    // the progress strip clears), this survives zip:done so a delayed zip:error
    // from the download-appearance watchdog can still render. Nulled on a new
    // build start, on zip:error, and on unmount.
    const lastBuildIdRef = useRef<string | null>(null);
    const setZipBuildState = useCallback((next: ZipBuildState | null) => {
        zipBuildRef.current = next;
        setZipBuildStateRaw(next);
    }, []);

    const [imagesNote, setImagesNote] = useState('');
    const [downloaded, setDownloaded] = useState(false);

    // Relay zip build broadcasts from the service worker (zip:progress /
    // zip:done / zip:error) into the progress strip and download notes. Only
    // messages for the popup's own buildId are accepted; the buildId is read
    // through a ref so the listener never goes stale across renders.
    useEffect(() => {
        const handleMessage = (message: unknown) => {
            const msg = message as { type?: string; buildId?: string } | null;
            if (!msg || typeof msg !== 'object' || typeof msg.buildId !== 'string') return;
            if (msg.buildId !== (zipBuildRef.current?.buildId ?? lastBuildIdRef.current)) return;

            if (msg.type === 'zip:progress') {
                const p = msg as ZipProgressBroadcast;
                const current = zipBuildRef.current;
                if (!current) return;
                setZipBuildState({
                    ...current,
                    phase: normalizeZipPhase(p.phase),
                    fetched: p.fetched ?? current.fetched,
                    total: p.total ?? current.total,
                });
            } else if (msg.type === 'zip:done') {
                const d = msg as ZipDoneBroadcast;
                setZipBuildState(null);
                setDownloaded(true);
                setTimeout(() => setDownloaded(false), 2000);
                const bundled = d.bundledImages ?? 0;
                const total = d.totalImages ?? 0;
                const skipped = d.skippedImages ?? 0;
                if (d.downloaded === 'md' && total > 0) {
                    setImagesNote('Images unavailable - downloaded .md only');
                } else if (bundled > 0) {
                    setImagesNote(skipped > 0 ? `Included ${bundled} of ${total} images` : `Included ${bundled} images`);
                }
            } else if (msg.type === 'zip:error') {
                const e = msg as ZipErrorBroadcast;
                lastBuildIdRef.current = null;
                setZipBuildState(null);
                setImagesNote(e.error ?? 'Image bundling failed');
            }
        };
        chrome.runtime.onMessage.addListener(handleMessage);
        return () => {
            lastBuildIdRef.current = null;
            chrome.runtime.onMessage.removeListener(handleMessage);
        };
        // Mount-only listener: stable setters and refs only.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Restore an in-flight zip build when the popup reopens: show the stored
    // storage.session snapshot immediately, then refresh it (or hide the strip)
    // with a zip:status liveness ping to the service worker.
    useEffect(() => {
        let cancelled = false;
        const restore = async () => {
            try {
                const stored = await chrome.storage.session.get('activeZipBuild');
                const state = stored.activeZipBuild as ActiveZipBuildState | undefined;
                if (!state?.buildId || cancelled) return;
                setZipBuildState({
                    buildId: state.buildId,
                    phase: normalizeZipPhase(state.phase),
                    fetched: state.fetched ?? 0,
                    total: state.total ?? 0,
                });
                lastBuildIdRef.current = state.buildId;
                const response = await chrome.runtime.sendMessage({ action: 'zip:status', buildId: state.buildId });
                if (cancelled) return;
                if (response?.active) {
                    setZipBuildState({
                        buildId: response.buildId,
                        phase: normalizeZipPhase(response.phase),
                        fetched: response.fetched ?? 0,
                        total: response.total ?? 0,
                    });
                    lastBuildIdRef.current = response.buildId;
                } else {
                    setZipBuildState(null);
                }
            } catch {
                if (!cancelled) setZipBuildState(null);
            }
        };
        restore();
        return () => {
            cancelled = true;
        };
        // Mount-only restore: refs and stable setters only.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const downloadWithImages = useCallback(async (markdownText: string, safeTitle: string, sourceUrl?: string) => {
        const buildId = crypto.randomUUID();
        lastBuildIdRef.current = buildId;
        setImagesNote('');
        setZipBuildState({ buildId, phase: 'fetch', fetched: 0, total: 0 });
        try {
            await chrome.runtime.sendMessage({
                action: 'build_zip',
                buildId,
                payload: { markdown: markdownText, title: safeTitle, sourceUrl: sourceUrl ?? null },
            });
        } catch {
            // The done/error broadcast messages drive the UI; a dead response
            // channel (e.g. popup about to close) is not an error. Clear the
            // strip so the pill cannot wedge on "Bundling images…" and the
            // action buttons cannot stay disabled if the build never starts.
            setZipBuildState(null);
        }
    }, [setZipBuildState]);

    return {
        zipBuild,
        isBundling: zipBuild !== null,
        imagesNote,
        setImagesNote,
        downloaded,
        setDownloaded,
        downloadWithImages,
    };
}
