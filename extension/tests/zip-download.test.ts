import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    collectImageNodes,
    assignLocalPaths,
    rewriteImageReferences,
    fetchImageBytes,
    downloadAllImages,
    buildReadme,
    buildZipArchive,
    buildZipBlob,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_CONCURRENCY,
} from '../src/zip/download';

describe('collectImageNodes', () => {
    it('finds image nodes with positions', () => {
        const md = '# Title\n\n![Alt text](https://example.com/a.png)';
        const nodes = collectImageNodes(md);
        expect(nodes).toHaveLength(1);
        expect(nodes[0].url).toBe('https://example.com/a.png');
        expect(nodes[0].alt).toBe('Alt text');
        expect(md.slice(nodes[0].start, nodes[0].end)).toBe('![Alt text](https://example.com/a.png)');
    });

    it('ignores image syntax inside code blocks', () => {
        const md = '```\n![not an image](x.png)\n```\n\n![real](https://e.com/r.png)';
        const nodes = collectImageNodes(md);
        expect(nodes).toHaveLength(1);
        expect(nodes[0].url).toBe('https://e.com/r.png');
    });

    it('collects images in document order', () => {
        const md = '![a](https://e.com/1.png)\n\n![b](https://e.com/2.png)';
        const nodes = collectImageNodes(md);
        expect(nodes.map((n) => n.url)).toEqual(['https://e.com/1.png', 'https://e.com/2.png']);
    });
});

describe('assignLocalPaths', () => {
    it('assigns sequential names preserving URL extension', () => {
        const map = assignLocalPaths(['https://e.com/hero.png', 'https://e.com/chart.jpg']);
        expect(map.get('https://e.com/hero.png')).toBe('images/img-001.png');
        expect(map.get('https://e.com/chart.jpg')).toBe('images/img-002.jpg');
    });

    it('dedupes identical URLs', () => {
        const map = assignLocalPaths(['https://e.com/a.png', 'https://e.com/a.png']);
        expect(map.size).toBe(1);
        expect(map.get('https://e.com/a.png')).toBe('images/img-001.png');
    });

    it('falls back to .png for extensionless URLs', () => {
        const map = assignLocalPaths(['https://e.com/photo']);
        expect(map.get('https://e.com/photo')).toBe('images/img-001.png');
    });

    it('derives extension from data: image type', () => {
        const map = assignLocalPaths(['data:image/jpeg;base64,AAAA']);
        expect(map.get('data:image/jpeg;base64,AAAA')).toBe('images/img-001.jpg');
    });
});

describe('rewriteImageReferences', () => {
    it('replaces only image URLs, leaving everything else byte-identical', () => {
        const md = '# Heading\n\n![Cat](https://e.com/cat.png)\n\nSome **bold** text with `![code](x.png)` inside.\n';
        const mapping = new Map([['https://e.com/cat.png', 'images/img-001.png']]);
        const out = rewriteImageReferences(md, mapping);
        expect(out).toBe(
            '# Heading\n\n![Cat](images/img-001.png)\n\nSome **bold** text with `![code](x.png)` inside.\n',
        );
    });

    it('keeps original URL when not in the mapping', () => {
        const md = '![a](https://e.com/a.png)\n\n![b](https://e.com/b.png)';
        const mapping = new Map([['https://e.com/b.png', 'images/img-001.png']]);
        const out = rewriteImageReferences(md, mapping);
        expect(out).toBe('![a](https://e.com/a.png)\n\n![b](images/img-001.png)');
    });

    it('escapes brackets in alt text', () => {
        const md = '![Weird [alt] text](https://e.com/a.png)';
        const mapping = new Map([['https://e.com/a.png', 'images/img-001.png']]);
        const out = rewriteImageReferences(md, mapping);
        expect(out).toBe('![Weird \\[alt\\] text](images/img-001.png)');
    });
});

describe('fetchImageBytes', () => {
    const originalFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    it('decodes data: URLs without fetching', async () => {
        globalThis.fetch = vi.fn(async () => {
            throw new Error('should not fetch data URLs');
        }) as unknown as typeof fetch;
        const bytes = await fetchImageBytes('data:image/png;base64,aGVsbG8=');
        expect(bytes).not.toBeNull();
        expect(new TextDecoder().decode(bytes!)).toBe('hello');
    });

    it('returns null for blob: URLs', async () => {
        expect(await fetchImageBytes('blob:https://e.com/uuid')).toBeNull();
    });

    it('fetches a URL and returns bytes', async () => {
        globalThis.fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;
        const bytes = await fetchImageBytes('https://e.com/a.png');
        expect(Array.from(bytes!)).toEqual([1, 2, 3]);
    });

    it('returns null for oversized bodies', async () => {
        const big = new Uint8Array(1024).fill(7);
        globalThis.fetch = vi.fn(async () => new Response(big)) as unknown as typeof fetch;
        expect(await fetchImageBytes('https://e.com/big.png', { maxBytes: 100 })).toBeNull();
    });

    it('rejects via content-length header without reading the body', async () => {
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(new Uint8Array(64).fill(1));
                controller.close();
            },
        });
        const response = new Response(stream, { headers: { 'content-length': '9999' } });
        globalThis.fetch = vi.fn(async () => response) as unknown as typeof fetch;

        const result = await fetchImageBytes('https://e.com/huge.png', { maxBytes: 100 });

        expect(result).toBeNull();
        // The body was never consumed: the content-length check fires first.
        expect(response.bodyUsed).toBe(false);
    });

    it('stops streaming mid-body when the cap is exceeded', async () => {
        // Infinite source: without bounded reads the fetch would keep pulling
        // until the timeout aborts it (timeoutMs: 500), so a small pull count
        // proves the cap itself stops the reads.
        let pulls = 0;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulls += 1;
                controller.enqueue(new Uint8Array(64).fill(1));
            },
        });
        const response = new Response(stream);
        globalThis.fetch = vi.fn(async () => response) as unknown as typeof fetch;

        const result = await fetchImageBytes('https://e.com/stream.png', { maxBytes: 128, timeoutMs: 500 });

        expect(result).toBeNull();
        // The cap tripped on the 3rd 64-byte chunk (total 192 > 128): reads stop
        // there instead of draining the infinite source. undici buffers one
        // chunk ahead, so the source sees 4 pulls total; without the bounded
        // reads the count would grow until the 500ms timeout aborts.
        expect(pulls).toBeLessThanOrEqual(4);
        expect(response.bodyUsed).toBe(true);
    });

    it('returns bytes for a streamed body at or under the cap', async () => {
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3]));
                controller.close();
            },
        });
        globalThis.fetch = vi.fn(async () => new Response(stream)) as unknown as typeof fetch;

        const bytes = await fetchImageBytes('https://e.com/streamed.png', { maxBytes: 64 });
        expect(Array.from(bytes!)).toEqual([1, 2, 3]);
    });

    it('returns null when fetch rejects', async () => {
        globalThis.fetch = vi.fn(async () => { throw new Error('network'); }) as unknown as typeof fetch;
        expect(await fetchImageBytes('https://e.com/fail.png')).toBeNull();
    });
});

describe('downloadAllImages', () => {
    const originalFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    it('bundles fetchable urls and skips failures', async () => {
        globalThis.fetch = vi.fn(async (url: string) =>
            url.includes('ok') ? new Response(new Uint8Array([9])) : Promise.reject(new Error('no')),
        ) as unknown as typeof fetch;
        const { bundled, skipped } = await downloadAllImages(['https://e.com/ok.png', 'https://e.com/bad.png']);
        expect(bundled.size).toBe(1);
        expect(skipped).toEqual(['https://e.com/bad.png']);
    });
});

describe('downloadAllImages pool', () => {
    const originalFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    it('bundles in-flight images and skips the rest once the total cap is reached', async () => {
        const chunk = new Uint8Array(10).fill(1);
        globalThis.fetch = vi.fn(async () => new Response(chunk)) as unknown as typeof fetch;
        const { bundled, skipped } = await downloadAllImages(
            ['https://e.com/a.png', 'https://e.com/b.png', 'https://e.com/c.png'],
            { maxTotalBytes: 15 },
        );
        // All three start concurrently; a and b complete under the cap, c after it.
        expect(bundled.size).toBe(2);
        expect(skipped).toEqual(['https://e.com/c.png']);
    });

    it('skips the URL-order tail once the cap is reached (concurrency 1)', async () => {
        const chunk = new Uint8Array(10).fill(1);
        globalThis.fetch = vi.fn(async () => new Response(chunk)) as unknown as typeof fetch;
        const { bundled, skipped } = await downloadAllImages(
            ['https://e.com/a.png', 'https://e.com/b.png', 'https://e.com/c.png'],
            { maxTotalBytes: 15, concurrency: 1 },
        );
        // Concurrency 1, cap 15, 10-byte chunks: a bundles (10 < 15), b STARTS
        // (loop-top check passes at 10 < 15) and bundles at completion
        // (10 < 15 still), c is skipped at the next loop-top check (20 >= 15).
        expect(bundled.size).toBe(2);
        expect(skipped).toEqual(['https://e.com/c.png']);
    });

    it('bounds parallelism to the concurrency option', async () => {
        const urls = Array.from({ length: 6 }, (_, i) => `https://e.com/${i}.png`);
        let inFlight = 0;
        let peak = 0;
        let release: (() => void) | null = null;
        const gate = new Promise<void>((r) => { release = r; });
        globalThis.fetch = vi.fn(async () => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await gate;
            inFlight -= 1;
            return new Response(new Uint8Array([1]));
        }) as unknown as typeof fetch;
        const pending = downloadAllImages(urls, { concurrency: 3 });
        // Let all workers start and fetch; then release the gate.
        await new Promise((r) => setTimeout(r, 20));
        release!();
        const { bundled } = await pending;
        expect(peak).toBe(3);
        expect(bundled.size).toBe(6);
    });

    it('emits progress after each completed fetch', async () => {
        globalThis.fetch = vi.fn(async () => new Response(new Uint8Array([1]))) as unknown as typeof fetch;
        const seen: Array<{ fetched: number; total: number }> = [];
        await downloadAllImages(
            ['https://e.com/a.png', 'https://e.com/b.png'],
            { onProgress: (p) => seen.push(p) },
        );
        expect(seen).toEqual([
            { fetched: 1, total: 2 },
            { fetched: 2, total: 2 },
        ]);
    });

    it('orders bundled images by URL position, not fetch completion order', async () => {
        // Gate the FIRST url until the other two have completed: bundled
        // insertion order must follow the URL list, not fetch timing.
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
        globalThis.fetch = vi.fn(async (url: string) => {
            if (url === 'https://e.com/a.png') await firstGate;
            return new Response(new Uint8Array([7]));
        }) as unknown as typeof fetch;

        const urls = ['https://e.com/a.png', 'https://e.com/b.png', 'https://e.com/c.png'];
        const pending = downloadAllImages(urls, { concurrency: 3 });

        // b and c start and finish first; a stays gated.
        await vi.waitFor(() => {
            expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(3);
        });
        await new Promise((r) => setTimeout(r, 10));
        releaseFirst();

        const { bundled, skipped } = await pending;
        expect(Array.from(bundled.keys())).toEqual([
            'https://e.com/a.png',
            'https://e.com/b.png',
            'https://e.com/c.png',
        ]);
        expect(skipped).toEqual([]);
    });

    it('orders skipped URLs by URL position when completions are out of order', async () => {
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
        globalThis.fetch = vi.fn(async (url: string) => {
            if (url === 'https://e.com/a.png') {
                await firstGate;
                throw new Error('fail');
            }
            if (url === 'https://e.com/b.png') throw new Error('fail');
            return new Response(new Uint8Array([7]));
        }) as unknown as typeof fetch;

        const urls = ['https://e.com/a.png', 'https://e.com/b.png', 'https://e.com/c.png'];
        const pending = downloadAllImages(urls, { concurrency: 3 });

        await vi.waitFor(() => {
            expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(3);
        });
        await new Promise((r) => setTimeout(r, 10));
        releaseFirst();

        const { bundled, skipped } = await pending;
        expect(Array.from(bundled.keys())).toEqual(['https://e.com/c.png']);
        // b failed before a did, but skipped must follow URL order.
        expect(skipped).toEqual(['https://e.com/a.png', 'https://e.com/b.png']);
    });

    it('defaults to 10s timeout and 6-way concurrency', () => {
        expect(DEFAULT_TIMEOUT_MS).toBe(10_000);
        expect(DEFAULT_CONCURRENCY).toBe(6);
    });
});

describe('buildZipBlob progress', () => {
    const originalFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    it('emits fetch progress and a build phase', async () => {
        globalThis.fetch = vi.fn(async () => new Response(new Uint8Array([4, 5]))) as unknown as typeof fetch;
        const seen: Array<{ phase: string; fetched?: number; total?: number }> = [];
        const result = await buildZipBlob(
            '![a](https://e.com/a.png)\n\n![b](https://e.com/b.png)',
            'page',
            null,
            { onProgress: (p) => seen.push(p) },
        );
        expect(result.blob).not.toBeNull();
        expect(seen).toEqual([
            { phase: 'fetch', fetched: 1, total: 2 },
            { phase: 'fetch', fetched: 2, total: 2 },
            { phase: 'build' },
        ]);
    });
});

import { unzipSync, strFromU8 } from 'fflate';

/**
 * Parse the ZIP central directory and return each entry's compression method
 * (0 = STORE, 8 = DEFLATE). Robust regardless of data-descriptor flags, which
 * only affect local headers. The EOCD record is the last one in the buffer.
 */
function compressionMethods(zipBytes: Uint8Array): Map<string, number> {
    const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
    const methods = new Map<string, number>();

    // EOCD: signature "PK\x05\x06", fixed 22 bytes before any archive comment.
    let eocd = -1;
    for (let i = zipBytes.byteLength - 22; i >= 0; i -= 1) {
        if (view.getUint32(i, true) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd === -1) throw new Error('End-Of-Central-Directory record not found');

    const entryCount = view.getUint16(eocd + 10, true);
    const centralOffset = view.getUint32(eocd + 16, true);

    let offset = centralOffset;
    for (let i = 0; i < entryCount; i += 1) {
        if (view.getUint32(offset, true) !== 0x02014b50) {
            throw new Error(`Unexpected central directory entry signature at ${offset}`);
        }
        const method = view.getUint16(offset + 10, true);
        const nameLen = view.getUint16(offset + 28, true);
        const extraLen = view.getUint16(offset + 30, true);
        const commentLen = view.getUint16(offset + 32, true);
        const name = new TextDecoder().decode(zipBytes.slice(offset + 46, offset + 46 + nameLen));
        methods.set(name, method);
        offset += 46 + nameLen + extraLen + commentLen;
    }
    return methods;
}

describe('buildReadme', () => {
    it('documents the primary file, relative paths, and file listing', () => {
        const readme = buildReadme({
            title: 'react_docs',
            sourceUrl: 'https://react.dev/learn',
            markdownFilename: 'react_docs.md',
            images: [
                { localPath: 'images/img-001.png', bytes: new Uint8Array([1]) },
                { localPath: 'images/img-002.jpg', bytes: new Uint8Array([2]) },
            ],
        });
        expect(readme).toContain('react_docs.md');
        expect(readme).toContain('images/img-001.png');
        expect(readme).toContain('images/img-002.jpg');
        expect(readme).toContain('https://react.dev/learn');
    });
});

describe('buildZipArchive', () => {
    it('creates a zip with README, markdown (deflated), and stored images', () => {
        const markdown = '# Hello'.repeat(50);
        const zip = buildZipArchive({
            readme: 'README',
            markdown,
            markdownFilename: 'page.md',
            images: [{ localPath: 'images/img-001.png', bytes: new Uint8Array([1, 2, 3]) }],
        });
        const files = unzipSync(zip);
        expect(Object.keys(files).sort()).toEqual(['README.md', 'images/img-001.png', 'page.md']);
        expect(strFromU8(files['README.md'])).toBe('README');
        expect(strFromU8(files['page.md'])).toBe(markdown);
        expect(Array.from(files['images/img-001.png'])).toEqual([1, 2, 3]);
        // Stored image: exact byte length in the archive entry
        expect(files['images/img-001.png'].byteLength).toBe(3);
        // Compression methods read from the central directory: images STORED,
        // README/markdown DEFLATED. This is the only check that can tell
        // STORE apart from DEFLATE (decompressed lengths match either way).
        const methods = compressionMethods(zip);
        expect(methods.get('images/img-001.png')).toBe(0);
        expect(methods.get('README.md')).toBe(8);
        expect(methods.get('page.md')).toBe(8);
    });
});

describe('buildZipBlob', () => {
    const originalFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    it('returns null when the markdown has no images', async () => {
        const result = await buildZipBlob('# No images here', 'page', null);
        expect(result.blob).toBeNull();
        expect(result.totalImages).toBe(0);
    });

    it('returns null when no images could be fetched', async () => {
        globalThis.fetch = vi.fn(async () => { throw new Error('down'); }) as unknown as typeof fetch;
        const result = await buildZipBlob('![a](https://e.com/a.png)', 'page', null);
        expect(result.blob).toBeNull();
        expect(result.bundledImages).toBe(0);
        expect(result.skippedImages).toBe(1);
    });

    it('builds a zip with rewritten markdown', async () => {
        globalThis.fetch = vi.fn(async () => new Response(new Uint8Array([4, 5]))) as unknown as typeof fetch;
        const result = await buildZipBlob(
            'Intro\n\n![Hero](https://e.com/hero.png)\n\n![Hero](https://e.com/hero.png)\n',
            'page',
            'https://e.com',
        );
        expect(result.blob).not.toBeNull();
        expect(result.totalImages).toBe(1);
        expect(result.bundledImages).toBe(1);
        expect(result.skippedImages).toBe(0);
        const zip = unzipSync(new Uint8Array(await result.blob!.arrayBuffer()));
        const md = strFromU8(zip['page.md']);
        expect(md).toContain('![Hero](images/img-001.png)');
        // Deduped: single fetch of hero.png
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(Object.keys(zip).some((k) => k.startsWith('images/'))).toBe(true);
    });

    it('keeps original URLs for images that failed to fetch', async () => {
        globalThis.fetch = vi.fn(async (url: string) =>
            url.includes('ok') ? new Response(new Uint8Array([1])) : Promise.reject(new Error('x')),
        ) as unknown as typeof fetch;
        const result = await buildZipBlob('![Ok](https://e.com/ok.png)\n\n![Bad](https://e.com/bad.png)', 'page', null);
        expect(result.blob).not.toBeNull();
        expect(result.bundledImages).toBe(1);
        expect(result.skippedImages).toBe(1);
        const zip = unzipSync(new Uint8Array(await result.blob!.arrayBuffer()));
        const md = strFromU8(zip['page.md']);
        // Fetched image is rewritten to its local path.
        expect(md).toContain('![Ok](images/img-001.png)');
        // Failed image keeps its original URL - no dangling local path.
        expect(md).toContain('![Bad](https://e.com/bad.png)');
        expect(md).not.toContain('images/img-002.png');
        // Exactly one image entry in the archive: the one that fetched.
        const imageEntries = Object.keys(zip).filter((k) => k.startsWith('images/'));
        expect(imageEntries).toHaveLength(1);
    });
});
