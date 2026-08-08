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
} from '../src/popup/zip-download';

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

    it('stops bundling once the total cap is reached', async () => {
        const chunk = new Uint8Array(10).fill(1);
        globalThis.fetch = vi.fn(async () => new Response(chunk)) as unknown as typeof fetch;
        const { bundled, skipped } = await downloadAllImages(
            ['https://e.com/a.png', 'https://e.com/b.png', 'https://e.com/c.png'],
            { maxTotalBytes: 15 },
        );
        expect(bundled.size).toBe(1);
        expect(skipped).toEqual(['https://e.com/b.png', 'https://e.com/c.png']);
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
