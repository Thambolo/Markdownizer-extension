// zip-build-service.ts - Service-worker orchestration for the ZIP bundle.
// No `chrome.*` references: the downloader and progress callbacks are injected
// so this module is unit-testable with plain mocks.

import { buildZipBlob, type ZipBuildProgress } from './popup/zip-download';

export interface ZipDownloadResult {
    downloaded: 'zip' | 'md';
    filename: string;
    totalImages: number;
    bundledImages: number;
    skippedImages: number;
}

export interface ZipBuildCallbacks {
    onProgress?: (p: ZipBuildProgress) => void;
    download: (dataUrl: string, filename: string) => Promise<void>;
}

/**
 * Build the bundle and hand the result to the injected downloader.
 * Returns the plain .md result when nothing bundlable (no images, or none
 * fetchable) - the fallback lives here, not in the popup.
 */
export async function buildAndDownloadZip(
    markdown: string,
    title: string,
    sourceUrl: string | null,
    callbacks: ZipBuildCallbacks,
): Promise<ZipDownloadResult> {
    const result = await buildZipBlob(markdown, title, sourceUrl, { onProgress: callbacks.onProgress });

    if (result.blob) {
        const bytes = new Uint8Array(await result.blob.arrayBuffer());
        await callbacks.download(bytesToDataUrl(bytes, 'application/zip'), `${title}.zip`);
        return {
            downloaded: 'zip',
            filename: `${title}.zip`,
            totalImages: result.totalImages,
            bundledImages: result.bundledImages,
            skippedImages: result.skippedImages,
        };
    }

    const mdBytes = new TextEncoder().encode(markdown);
    await callbacks.download(bytesToDataUrl(mdBytes, 'text/markdown'), `${title}.md`);
    return {
        downloaded: 'md',
        filename: `${title}.md`,
        totalImages: result.totalImages,
        bundledImages: 0,
        skippedImages: result.skippedImages,
    };
}

/**
 * Encode bytes as a base64 data: URL. Chunked (32 KB) to avoid call-stack
 * limits on large payloads. `btoa` is available in service workers.
 * NOTE: URL.createObjectURL is NOT available in service workers, so data:
 * URLs are the download mechanism there.
 */
export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
    }
    return `data:${mime};base64,${btoa(binary)}`;
}
