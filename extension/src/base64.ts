// base64.ts - Chunked base64 data-URL encoding (pure; no chrome references).

/**
 * Encode bytes as a base64 data: URL. Chunked (32 KB) to avoid call-stack
 * limits on large payloads. `btoa` is available in service workers, offscreen
 * documents, and the popup. NOTE: URL.createObjectURL is NOT available in
 * service workers, so data: URLs are the download mechanism there.
 */
export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
    }
    return `data:${mime};base64,${btoa(binary)}`;
}
