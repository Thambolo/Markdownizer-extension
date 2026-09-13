// zip-build-service.ts - ZIP bundle construction. No chrome API references:
// this module runs inside the hidden offscreen document, which only has the
// runtime extension API. The produced bytes are downloaded directly by the
// offscreen document via a blob anchor.

import { buildZipBlob, type ZipBuildProgress } from './download';

export interface ZipBuildResult {
    downloaded: 'zip' | 'md';
    filename: string;
    totalImages: number;
    bundledImages: number;
    skippedImages: number;
    bytes: Uint8Array<ArrayBuffer>;
}

/**
 * Build the bundle and return the payload bytes plus metadata.
 * Returns the plain .md bytes when nothing bundlable (no images, or none
 * fetchable) - the fallback lives here, not in the caller.
 */
export async function buildZipResult(
    markdown: string,
    title: string,
    sourceUrl: string | null,
    options: { onProgress?: (p: ZipBuildProgress) => void } = {},
): Promise<ZipBuildResult> {
    const result = await buildZipBlob(markdown, title, sourceUrl, { onProgress: options.onProgress });

    if (result.blob) {
        const bytes = new Uint8Array(await result.blob.arrayBuffer());
        return {
            downloaded: 'zip',
            filename: `${title}.zip`,
            totalImages: result.totalImages,
            bundledImages: result.bundledImages,
            skippedImages: result.skippedImages,
            bytes,
        };
    }

    return {
        downloaded: 'md',
        filename: `${title}.md`,
        totalImages: result.totalImages,
        bundledImages: 0,
        skippedImages: result.skippedImages,
        bytes: new TextEncoder().encode(markdown),
    };
}
