import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

let messageListener: ((msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean | undefined) | undefined;
const sendMessageSpy = vi.fn(async () => {});
const originalFetch = globalThis.fetch;

beforeEach(() => {
    vi.resetModules();
    messageListener = undefined;
    sendMessageSpy.mockClear();
    globalThis.chrome = {
        runtime: {
            onMessage: {
                addListener: vi.fn((listener: typeof messageListener) => { messageListener = listener; }),
            },
            sendMessage: sendMessageSpy,
        },
    } as unknown as typeof chrome;
    globalThis.fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;
    // The offscreen module imports idb-payload -> real IndexedDB is unavailable in
    // the node test environment; mock it to capture what gets saved.
    vi.doMock('../src/idb-payload', () => ({
        savePayload: vi.fn(async () => {}),
        readPayload: vi.fn(async () => new Uint8Array()),
        deletePayload: vi.fn(async () => {}),
    }));
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
});

describe('offscreen document handler', () => {
    async function load() {
        await import('../src/offscreen');
    }

    it('builds, saves the payload, broadcasts progress, and responds metadata-only', async () => {
        await load();
        const { savePayload } = await import('../src/idb-payload');
        const responsePromise = new Promise((resolve) => {
            messageListener!(
                {
                    type: 'offscreen:build',
                    buildId: 'b-1',
                    payload: { markdown: '![Hero](https://e.com/hero.png)', title: 'page', sourceUrl: 'https://e.com' },
                },
                {},
                resolve,
            );
        });
        const response = (await responsePromise) as { ok: boolean; dataUrl?: unknown };
        expect(response.ok).toBe(true);
        expect(response).not.toHaveProperty('dataUrl'); // payload never in messages
        expect(response).toMatchObject({ downloaded: 'zip', filename: 'page.zip', bundledImages: 1 });
        expect(savePayload).toHaveBeenCalledWith('b-1', expect.any(Uint8Array));
        const broadcasts = sendMessageSpy.mock.calls.map((c) => c[0]);
        expect(broadcasts.some((m) => m.type === 'zip:progress' && m.buildId === 'b-1')).toBe(true);
        expect(broadcasts.some((m) => m.type === 'zip:completed' && m.buildId === 'b-1' && m.ok === true)).toBe(true);
    });

    it('responds { ok: false } and broadcasts completion on build errors', async () => {
        globalThis.fetch = vi.fn(async () => { throw new Error('boom'); }) as unknown as typeof fetch;
        await load();
        const { savePayload } = await import('../src/idb-payload');
        (savePayload as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('idb full'));
        const responsePromise = new Promise((resolve) => {
            messageListener!(
                { type: 'offscreen:build', buildId: 'b-2', payload: { markdown: '![a](https://e.com/a.png)', title: 'p', sourceUrl: null } },
                {},
                resolve,
            );
        });
        const response = (await responsePromise) as { ok: boolean; error?: string };
        expect(response.ok).toBe(false);
        expect(response.error).toBeTruthy();
        const broadcasts = sendMessageSpy.mock.calls.map((c) => c[0]);
        expect(broadcasts.some((m) => m.type === 'zip:completed' && m.buildId === 'b-2' && m.ok === false)).toBe(true);
    });

    it('ignores messages that are not offscreen:build', async () => {
        await load();
        const result = messageListener!({ type: 'zip:progress', buildId: 'x' }, {}, vi.fn());
        expect(result).toBeUndefined();
        expect(sendMessageSpy).not.toHaveBeenCalled();
    });
});
