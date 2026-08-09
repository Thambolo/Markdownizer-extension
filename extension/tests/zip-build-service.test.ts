import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildZipResult } from '../src/zip-build-service';
import { bytesToDataUrl } from '../src/base64';

describe('bytesToDataUrl', () => {
    it('encodes bytes as a base64 data URL', () => {
        const url = bytesToDataUrl(new TextEncoder().encode('hello'), 'text/plain');
        expect(url).toBe('data:text/plain;base64,aGVsbG8=');
    });

    it('re-exports bytesToDataUrl from zip-build-service for compatibility', async () => {
        const mod = await import('../src/zip-build-service');
        expect(typeof mod.bytesToDataUrl).toBe('function');
    });
});

describe('buildZipResult', () => {
    const originalFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    it('returns zip bytes and metadata when images bundle', async () => {
        globalThis.fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;
        const progress: string[] = [];
        const result = await buildZipResult('![Hero](https://e.com/hero.png)', 'page', 'https://e.com', {
            onProgress: (p) => progress.push(p.phase),
        });
        expect(result.downloaded).toBe('zip');
        expect(result.filename).toBe('page.zip');
        expect(result.totalImages).toBe(1);
        expect(result.bundledImages).toBe(1);
        expect(result.skippedImages).toBe(0);
        expect(result.bytes.length).toBeGreaterThan(0);
        expect(progress).toEqual(['fetch', 'build']);
        // The bytes are a valid zip: decode and inspect.
        const { unzipSync, strFromU8 } = await import('fflate');
        const files = unzipSync(result.bytes);
        expect(strFromU8(files['README.md'])).toContain('https://e.com');
    });

    it('falls back to markdown bytes when nothing bundles', async () => {
        globalThis.fetch = vi.fn(async () => { throw new Error('down'); }) as unknown as typeof fetch;
        const result = await buildZipResult('![a](https://e.com/a.png)', 'page', null);
        expect(result.downloaded).toBe('md');
        expect(result.filename).toBe('page.md');
        expect(new TextDecoder().decode(result.bytes)).toBe('![a](https://e.com/a.png)');
        expect(result.bundledImages).toBe(0);
        expect(result.skippedImages).toBe(1);
    });

    it('has no chrome references in the module graph', async () => {
        const fs = await import('node:fs');
        const source = fs.readFileSync(new URL('../src/zip-build-service.ts', import.meta.url), 'utf8');
        expect(source).not.toMatch(/chrome\./);
        const base64Source = fs.readFileSync(new URL('../src/base64.ts', import.meta.url), 'utf8');
        expect(base64Source).not.toMatch(/chrome\./);
    });
});
