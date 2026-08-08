import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAndDownloadZip, bytesToDataUrl } from '../src/zip-build-service';

describe('bytesToDataUrl', () => {
    it('encodes bytes as a base64 data URL', () => {
        const url = bytesToDataUrl(new TextEncoder().encode('hello'), 'text/plain');
        expect(url).toBe('data:text/plain;base64,aGVsbG8=');
    });
});

describe('buildAndDownloadZip', () => {
    const originalFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    it('downloads a zip via the injected downloader when images bundle', async () => {
        globalThis.fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;
        const download = vi.fn(async () => {});
        const progress: string[] = [];
        const result = await buildAndDownloadZip('![Hero](https://e.com/hero.png)', 'page', 'https://e.com', {
            download,
            onProgress: (p) => progress.push(p.phase),
        });
        expect(result.downloaded).toBe('zip');
        expect(result.filename).toBe('page.zip');
        expect(result.totalImages).toBe(1);
        expect(result.bundledImages).toBe(1);
        expect(download).toHaveBeenCalledTimes(1);
        const [dataUrl, filename] = download.mock.calls[0] as [string, string];
        expect(filename).toBe('page.zip');
        expect(dataUrl.startsWith('data:application/zip;base64,')).toBe(true);
        expect(progress).toEqual(['fetch', 'build']);
    });

    it('falls back to a markdown download when nothing bundles', async () => {
        globalThis.fetch = vi.fn(async () => { throw new Error('down'); }) as unknown as typeof fetch;
        const download = vi.fn(async () => {});
        const result = await buildAndDownloadZip('![a](https://e.com/a.png)', 'page', null, { download });
        expect(result.downloaded).toBe('md');
        expect(result.filename).toBe('page.md');
        expect(download).toHaveBeenCalledTimes(1);
        const [dataUrl, filename] = download.mock.calls[0] as [string, string];
        expect(filename).toBe('page.md');
        expect(dataUrl.startsWith('data:text/markdown;base64,')).toBe(true);
    });

    it('throws when the downloader rejects', async () => {
        globalThis.fetch = vi.fn(async () => new Response(new Uint8Array([1]))) as unknown as typeof fetch;
        const download = vi.fn(async () => { throw new Error('shelf full'); });
        await expect(
            buildAndDownloadZip('![a](https://e.com/a.png)', 'page', null, { download }),
        ).rejects.toThrow('shelf full');
    });
});
