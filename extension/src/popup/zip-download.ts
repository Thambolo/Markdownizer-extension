// zip-download.ts - Bundle page images with the Markdown file into a ZIP.

import { remark } from 'remark';

interface MdastNode {
    type: string;
    url?: string;
    alt?: string | null;
    children?: MdastNode[];
    position?: {
        start: { offset?: number | null };
        end: { offset?: number | null };
    };
}

export interface ImageRef {
    url: string;
    alt: string;
    start: number; // char offset of the full image node "![alt](url)"
    end: number;   // char offset just past the node
}

/** Parse the markdown and collect image nodes in document order. */
export function collectImageNodes(markdown: string): ImageRef[] {
    const tree = remark().parse(markdown) as unknown as MdastNode;
    const nodes: ImageRef[] = [];
    const walk = (node: MdastNode): void => {
        if (
            node.type === 'image' &&
            node.position?.start.offset != null &&
            node.position?.end.offset != null
        ) {
            nodes.push({
                url: node.url ?? '',
                alt: typeof node.alt === 'string' ? node.alt : '',
                start: node.position.start.offset,
                end: node.position.end.offset,
            });
        }
        node.children?.forEach(walk);
    };
    walk(tree);
    return nodes;
}

/** Derive a file extension from a URL or data: MIME type; fallback .png. */
function extensionFor(url: string): string {
    if (url.startsWith('data:')) {
        const match = url.match(/^data:image\/([a-zA-Z0-9.+-]+)/);
        if (match) {
            const type = match[1].toLowerCase();
            return type === 'jpeg' ? '.jpg' : `.${type}`;
        }
        return '.png';
    }
    try {
        const path = new URL(url).pathname;
        const match = path.match(/\.([a-zA-Z0-9]{1,5})$/);
        if (match) return `.${match[1].toLowerCase()}`;
    } catch {
        // invalid URL - fall through
    }
    return '.png';
}

/** Assign each unique URL a local path images/img-NNN.ext, in first-seen order. */
export function assignLocalPaths(urls: string[]): Map<string, string> {
    const seen = new Set<string>();
    const map = new Map<string, string>();
    let counter = 0;
    for (const url of urls) {
        if (seen.has(url)) continue;
        seen.add(url);
        counter += 1;
        map.set(url, `images/img-${String(counter).padStart(3, '0')}${extensionFor(url)}`);
    }
    return map;
}

function escapeAlt(alt: string): string {
    return alt.replace(/[[\]]/g, (c) => `\\${c}`);
}

/**
 * Rewrite image references to local paths using mdast positions.
 * Only image-node ranges change; all other text is preserved verbatim.
 */
export function rewriteImageReferences(markdown: string, mapping: Map<string, string>): string {
    const nodes = collectImageNodes(markdown);
    const parts: string[] = [];
    let cursor = 0;
    for (const node of nodes) {
        if (node.start < cursor) continue;
        const local = mapping.get(node.url);
        if (!local) continue;
        parts.push(markdown.slice(cursor, node.start));
        parts.push(`![${escapeAlt(node.alt)}](${local})`);
        cursor = node.end;
    }
    parts.push(markdown.slice(cursor));
    return parts.join('');
}

export interface DownloadCaps {
    timeoutMs?: number;
    maxBytesPerImage?: number;
    maxTotalBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES_PER_IMAGE = 15 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 60 * 1024 * 1024;

/**
 * Fetch one image's bytes. Returns null when the image is unfetchable
 * (blob: URLs), too large, or the request fails or times out.
 */
export async function fetchImageBytes(
    url: string,
    options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<Uint8Array | null> {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES_PER_IMAGE } = options;

    if (url.startsWith('blob:')) return null;

    try {
        if (url.startsWith('data:')) {
            // Decode locally; data: URLs must never hit the network.
            const bytes = decodeDataUrl(url);
            return bytes !== null && bytes.byteLength <= maxBytes ? bytes : null;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, { signal: controller.signal });
            if (!response.ok) return null;
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.byteLength > maxBytes) return null;
            return bytes;
        } finally {
            clearTimeout(timer);
        }
    } catch {
        return null;
    }
}

/**
 * Decode a data: URL payload into bytes without touching the network.
 * Handles base64 payloads and percent-encoded text; returns null when
 * the payload is malformed.
 */
function decodeDataUrl(url: string): Uint8Array | null {
    const comma = url.indexOf(',');
    if (comma === -1) return null;
    const meta = url.slice(5, comma);
    const payload = url.slice(comma + 1);
    try {
        if (/;base64$/i.test(meta)) {
            const binary = atob(payload);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
            return bytes;
        }
        return new TextEncoder().encode(decodeURIComponent(payload));
    } catch {
        return null;
    }
}

/**
 * Fetch all unique image URLs, honoring per-image and total byte caps.
 * `urls` must be deduped by the caller (assignLocalPaths input order).
 */
export async function downloadAllImages(
    urls: string[],
    caps: DownloadCaps = {},
): Promise<{ bundled: Map<string, Uint8Array>; skipped: string[] }> {
    const maxBytesPerImage = caps.maxBytesPerImage ?? DEFAULT_MAX_BYTES_PER_IMAGE;
    const maxTotalBytes = caps.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    const bundled = new Map<string, Uint8Array>();
    const skipped: string[] = [];
    let total = 0;

    for (const url of urls) {
        if (total >= maxTotalBytes) {
            skipped.push(url);
            continue;
        }
        const bytes = await fetchImageBytes(url, { timeoutMs: caps.timeoutMs, maxBytes: maxBytesPerImage });
        if (!bytes) {
            skipped.push(url);
            continue;
        }
        if (total + bytes.byteLength > maxTotalBytes) {
            skipped.push(url);
            continue;
        }
        total += bytes.byteLength;
        bundled.set(url, bytes);
    }
    return { bundled, skipped };
}
