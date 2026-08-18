import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

let messageListener: ((msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean | undefined) | undefined;
const sendMessageSpy = vi.fn(async () => {});
const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;
const originalURL = globalThis.URL;

let lastBlob: Blob | null = null;
let lastAnchor: { download: string; href: string; click: ReturnType<typeof vi.fn> } | null = null;
const createObjectURLSpy = vi.fn((blob: Blob) => { lastBlob = blob; return 'blob:mock'; });
const revokeObjectURLSpy = vi.fn();

beforeEach(() => {
    vi.resetModules();
    messageListener = undefined;
    sendMessageSpy.mockClear();
    lastBlob = null;
    lastAnchor = null;
    createObjectURLSpy.mockClear();
    revokeObjectURLSpy.mockClear();
    globalThis.chrome = {
        runtime: {
            onMessage: {
                addListener: vi.fn((listener: typeof messageListener) => { messageListener = listener; }),
            },
            sendMessage: sendMessageSpy,
        },
    } as unknown as typeof chrome;
    globalThis.fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;
    // The offscreen runs in a real document in production; node has none.
    globalThis.document = {
        createElement: vi.fn((tag: string) => {
            if (tag === 'a') {
                lastAnchor = { download: '', href: '', click: vi.fn() };
                return lastAnchor;
            }
            return {} as HTMLElement;
        }),
        body: { appendChild: vi.fn(), removeChild: vi.fn() },
    } as unknown as Document;
    // Proxy, NOT a wholesale replacement: vitest's module runner calls
    // `new URL(...)` on every dynamic import, and zip-download.ts's
    // extensionFor uses the URL constructor. Only the two blob methods are
    // intercepted; everything else (including `construct`) falls through.
    const RealURL = globalThis.URL;
    globalThis.URL = new Proxy(RealURL, {
        get: (target, prop) => {
            if (prop === 'createObjectURL') return createObjectURLSpy;
            if (prop === 'revokeObjectURL') return revokeObjectURLSpy;
            return Reflect.get(target, prop);
        },
    }) as unknown as typeof URL;
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
    globalThis.URL = originalURL;
    vi.restoreAllMocks();
});

describe('offscreen document handler', () => {
    async function load() {
        await import('../src/offscreen/index');
    }

    function dispatch(payload: Record<string, unknown>): Promise<unknown> {
        const responsePromise = new Promise((resolve) => {
            messageListener!(
                { type: 'offscreen:build', buildId: 'b-1', payload },
                {},
                resolve,
            );
        });
        return responsePromise;
    }

    it('builds, downloads the bytes via a blob anchor, and responds metadata-only', async () => {
        await load();
        const response = (await dispatch({ markdown: '![Hero](https://e.com/hero.png)', title: 'page', sourceUrl: 'https://e.com' })) as { ok: boolean };
        expect(response.ok).toBe(true);
        expect(response).toMatchObject({ downloaded: 'zip', filename: 'page.zip', bundledImages: 1 });
        expect(response).not.toHaveProperty('dataUrl');
        // The anchor download: right filename, mime, and the built bytes.
        expect(lastAnchor?.download).toBe('page.zip');
        expect(lastAnchor?.click).toHaveBeenCalled();
        expect(lastBlob?.type).toBe('application/zip');
        const bytes = new Uint8Array(await lastBlob!.arrayBuffer());
        expect(bytes.length).toBeGreaterThan(0);
        // Revoke is deferred (30 s) so the browser can finish streaming.
        expect(revokeObjectURLSpy).not.toHaveBeenCalled();
        const broadcasts = sendMessageSpy.mock.calls.map((c) => c[0]);
        expect(broadcasts.some((m) => m.type === 'zip:progress' && m.buildId === 'b-1')).toBe(true);
        expect(
            broadcasts.some(
                (m) => m.type === 'zip:completed' && m.buildId === 'b-1' && m.ok === true &&
                    m.bundledImages === 1 && m.skippedImages === 0 && m.totalImages === 1,
            ),
        ).toBe(true);
    });

    it('downloads a plain .md via the blob anchor when nothing is bundlable', async () => {
        await load();
        const response = (await dispatch({ markdown: '# hi', title: 'p', sourceUrl: null })) as { ok: boolean; downloaded?: string; filename?: string };
        expect(response.ok).toBe(true);
        expect(response).toMatchObject({ downloaded: 'md', filename: 'p.md' });
        expect(lastAnchor?.download).toBe('p.md');
        expect(lastBlob?.type).toBe('text/markdown');
        const text = new TextDecoder().decode(new Uint8Array(await lastBlob!.arrayBuffer()));
        expect(text).toBe('# hi');
    });

    it('responds { ok: false } and broadcasts completion on build errors', async () => {
        vi.doMock('../src/zip/build-service', async (importOriginal) => {
            const actual = await importOriginal<typeof import('../src/zip/build-service')>();
            return { ...actual, buildZipResult: vi.fn(async () => { throw new Error('zip exploded'); }) };
        });
        try {
            await load();
            const response = (await dispatch({ markdown: '![a](https://e.com/a.png)', title: 'p', sourceUrl: null })) as { ok: boolean; error?: string };
            expect(response.ok).toBe(false);
            expect(response.error).toBe('zip exploded');
            const broadcasts = sendMessageSpy.mock.calls.map((c) => c[0]);
            expect(broadcasts.some((m) => m.type === 'zip:completed' && m.buildId === 'b-1' && m.ok === false)).toBe(true);
            expect(lastAnchor).toBeNull(); // nothing downloaded on failure
        } finally {
            vi.doUnmock('../src/zip/build-service');
        }
    });

    it('ignores messages that are not offscreen:build', async () => {
        await load();
        const result = messageListener!({ type: 'zip:progress', buildId: 'x' }, {}, vi.fn());
        expect(result).toBeUndefined();
        expect(sendMessageSpy).not.toHaveBeenCalled();
    });
});
