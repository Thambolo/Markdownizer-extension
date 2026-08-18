import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RuntimeMessageListener = (
    request: unknown,
    sender: unknown,
    sendResponse: (response: unknown) => void,
) => boolean | undefined;

interface ZipMessage {
    type?: string;
    action?: string;
    buildId?: string;
    phase?: string;
    fetched?: number;
    total?: number;
    payload?: Record<string, unknown>;
    ok?: boolean;
    error?: string;
    downloaded?: string;
    filename?: string;
    totalImages?: number;
    bundledImages?: number;
    skippedImages?: number;
}

const ZIP_DONE_METADATA = {
    downloaded: 'zip',
    filename: 'page.zip',
    totalImages: 1,
    bundledImages: 1,
    skippedImages: 0,
} as const;

interface Harness {
    listeners: RuntimeMessageListener[];
    broadcasts: ZipMessage[];
    session: Map<string, unknown>;
    offscreenExists: boolean;
    sendMessageImpl: (msg: ZipMessage) => Promise<unknown>;
    createDocument: ReturnType<typeof vi.fn>;
    closeDocument: ReturnType<typeof vi.fn>;
    getContexts: ReturnType<typeof vi.fn>;
    searchDownloads: ReturnType<typeof vi.fn>;
    emit: (message: ZipMessage) => Promise<unknown>;
}

function createHarness(): Harness {
    const session = new Map<string, unknown>();
    const listeners: RuntimeMessageListener[] = [];
    const broadcasts: ZipMessage[] = [];
    const h: Harness = {
        listeners,
        broadcasts,
        session,
        offscreenExists: true,
        sendMessageImpl: async () => undefined,
        createDocument: vi.fn(async () => {}),
        closeDocument: vi.fn(async () => {}),
        getContexts: vi.fn(async () => (h.offscreenExists ? [{ id: 1 }] : [])),
        searchDownloads: vi.fn(async () => []),
        emit: () => Promise.resolve(undefined),
    };
    h.emit = (message: ZipMessage): Promise<unknown> =>
        new Promise((resolve) => {
            let resolved = false;
            const sendResponse = (response: unknown) => {
                if (!resolved) {
                    resolved = true;
                    resolve(response);
                }
            };
            for (const listener of listeners) {
                const keep = listener(message, {}, sendResponse);
                if (keep === true) return; // async response arrives later
            }
            resolve(undefined); // type-only message: fire-and-forget
        });
    return h;
}

function stubChrome(h: Harness): void {
    (globalThis as unknown as { chrome: unknown }).chrome = {
        runtime: {
            onInstalled: { addListener: vi.fn() },
            onMessage: {
                addListener: vi.fn((l: RuntimeMessageListener) => {
                    h.listeners.push(l);
                }),
            },
            sendMessage: vi.fn((msg: ZipMessage) => h.sendMessageImpl(msg)),
            getContexts: h.getContexts,
            getURL: (p: string) => p,
        },
        storage: {
            session: {
                get: async (keys: string | string[]) => {
                    const k = Array.isArray(keys) ? keys[0] : keys;
                    return h.session.has(k) ? { [k]: h.session.get(k) } : {};
                },
                set: async (items: Record<string, unknown>) => {
                    for (const [k, v] of Object.entries(items)) h.session.set(k, v);
                },
                remove: async (keys: string | string[]) => {
                    const k = Array.isArray(keys) ? keys[0] : keys;
                    h.session.delete(k);
                },
            },
            sync: { get: vi.fn(async () => ({ user_id: 'test-user' })), set: vi.fn(async () => {}) },
            local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
        },
        offscreen: { createDocument: h.createDocument, closeDocument: h.closeDocument },
        downloads: { search: h.searchDownloads },
    } as unknown as typeof chrome;
}

describe('Background zip build orchestration', () => {
    let h: Harness;

    beforeEach(async () => {
        vi.resetModules();
        vi.useFakeTimers();
        vi.stubEnv('VITE_API_URL', 'https://api-markdownizer.thambolo.com/convert');
        h = createHarness();
        h.sendMessageImpl = async (msg: ZipMessage) => {
            if (msg?.type === 'offscreen:build') {
                return { ok: true, buildId: msg.buildId, ...ZIP_DONE_METADATA };
            }
            h.broadcasts.push(msg);
            return undefined;
        };
        stubChrome(h);
        await import('../src/background/index');
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        delete (globalThis as unknown as { chrome?: unknown }).chrome;
    });

    it('build_zip happy path: ensures offscreen, writes then clears state, finalizes with exactly one zip:done', async () => {
        h.offscreenExists = false; // no offscreen document yet → creation path exercised
        const response = await h.emit({
            action: 'build_zip',
            buildId: 'b1',
            payload: { markdown: '# Hi', title: 'page', sourceUrl: null },
        });

        expect(response).toMatchObject({ success: true, downloaded: 'zip', filename: 'page.zip' });
        expect(h.createDocument).toHaveBeenCalledTimes(1);
        expect(h.session.get('activeZipBuild')).toBeUndefined();
        const done = h.broadcasts.filter((m) => m.type === 'zip:done');
        expect(done).toHaveLength(1);
        expect(done[0]).toMatchObject({ buildId: 'b1', downloaded: 'zip', filename: 'page.zip' });
    });

    it('zip:progress from a stale build never clobbers a newer build state', async () => {
        let resolveA!: (v: unknown) => void;
        h.sendMessageImpl = async (msg: ZipMessage) => {
            if (msg?.type === 'offscreen:build') {
                return new Promise((res) => {
                    resolveA = res;
                });
            }
            h.broadcasts.push(msg);
            return undefined;
        };

        const responsePromise = h.emit({
            action: 'build_zip',
            buildId: 'A',
            payload: { markdown: 'x', title: 'p', sourceUrl: null },
        });
        await vi.waitFor(() => {
            expect(h.session.get('activeZipBuild')).toMatchObject({ buildId: 'A' });
        });

        // A stale build's late progress tick must not replace A's state.
        await h.emit({ type: 'zip:progress', buildId: 'stale', phase: 'build', fetched: 3, total: 3 });
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
        expect(h.session.get('activeZipBuild')).toMatchObject({ buildId: 'A' });

        resolveA({ ok: true, buildId: 'A', ...ZIP_DONE_METADATA });
        const response = await responsePromise;
        expect(response).toMatchObject({ success: true });
        await vi.waitFor(() => {
            expect(h.session.get('activeZipBuild')).toBeUndefined();
        });
    });

    it('zip:completed recovery broadcasts zip:done only when storage still matches', async () => {
        h.session.set('activeZipBuild', { buildId: 'A', startedAt: Date.now(), phase: 'fetch', fetched: 0, total: 0 });

        await h.emit({ type: 'zip:completed', buildId: 'A', ok: true, ...ZIP_DONE_METADATA });
        await vi.waitFor(() => {
            expect(h.broadcasts.filter((m) => m.type === 'zip:done')).toHaveLength(1);
        });
        expect(h.session.get('activeZipBuild')).toBeUndefined();

        // Replaying the same completion must not double-broadcast.
        await h.emit({ type: 'zip:completed', buildId: 'A', ok: true, ...ZIP_DONE_METADATA });
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
        expect(h.broadcasts.filter((m) => m.type === 'zip:done')).toHaveLength(1);
    });

    it('zip:completed for a mismatched buildId is ignored', async () => {
        h.session.set('activeZipBuild', { buildId: 'B', startedAt: Date.now(), phase: 'fetch', fetched: 0, total: 0 });

        await h.emit({ type: 'zip:completed', buildId: 'A', ok: true, ...ZIP_DONE_METADATA });
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
        expect(h.broadcasts.filter((m) => m.type === 'zip:done')).toHaveLength(0);
        expect(h.session.get('activeZipBuild')).toMatchObject({ buildId: 'B' });
    });

    it('zip:completed failure path broadcasts zip:error and clears owned state', async () => {
        h.session.set('activeZipBuild', { buildId: 'A', startedAt: Date.now(), phase: 'build', fetched: 0, total: 0 });

        await h.emit({ type: 'zip:completed', buildId: 'A', ok: false, error: 'boom' });
        await vi.waitFor(() => {
            expect(h.broadcasts.filter((m) => m.type === 'zip:error')).toHaveLength(1);
        });
        expect(h.broadcasts.find((m) => m.type === 'zip:error')).toMatchObject({ buildId: 'A', error: 'boom' });
        expect(h.session.get('activeZipBuild')).toBeUndefined();
    });

    it('zip:status reports an active build with phase and counters', async () => {
        h.session.set('activeZipBuild', { buildId: 'A', startedAt: Date.now(), phase: 'build', fetched: 2, total: 5 });

        const response = await h.emit({ action: 'zip:status', buildId: 'A' });
        expect(response).toMatchObject({ active: true, buildId: 'A', phase: 'build', fetched: 2, total: 5 });
    });

    it('zip:status clears orphan state when no offscreen document exists', async () => {
        h.offscreenExists = false;
        h.session.set('activeZipBuild', { buildId: 'A', startedAt: Date.now(), phase: 'fetch', fetched: 0, total: 0 });

        const response = await h.emit({ action: 'zip:status', buildId: 'A' });
        expect(response).toEqual({ active: false });
        expect(h.session.get('activeZipBuild')).toBeUndefined();
    });

    it('zip:status for a mismatched build clears stale state and reports inactive', async () => {
        h.session.set('activeZipBuild', { buildId: 'A', startedAt: Date.now(), phase: 'fetch', fetched: 0, total: 0 });

        const response = await h.emit({ action: 'zip:status', buildId: 'ZZZ' });
        expect(response).toEqual({ active: false });
        expect(h.session.get('activeZipBuild')).toBeUndefined();
    });

    it('build_zip failure broadcasts zip:error, clears owned state, and responds failure', async () => {
        h.sendMessageImpl = async (msg: ZipMessage) => {
            if (msg?.type === 'offscreen:build') return { ok: false, error: 'ZIP build failed.' };
            h.broadcasts.push(msg);
            return undefined;
        };

        const response = await h.emit({
            action: 'build_zip',
            buildId: 'A',
            payload: { markdown: 'x', title: 'p', sourceUrl: null },
        });
        expect(response).toEqual({ success: false, error: 'The download failed. Try again.' });
        expect(h.broadcasts.filter((m) => m.type === 'zip:error')).toHaveLength(1);
        expect(h.session.get('activeZipBuild')).toBeUndefined();
    });

    it('build_zip reports unsupported browsers without creating a document', async () => {
        delete (globalThis as unknown as { chrome: { offscreen: { createDocument?: unknown } } }).chrome.offscreen.createDocument;

        const response = await h.emit({
            action: 'build_zip',
            buildId: 'A',
            payload: { markdown: 'x', title: 'p', sourceUrl: null },
        });
        expect(response).toMatchObject({ success: false });
        expect(h.createDocument).not.toHaveBeenCalled();
        expect(h.broadcasts.filter((m) => m.type === 'zip:error')).toHaveLength(1);
    });

    it('watchdog broadcasts zip:error when no download item appears', async () => {
        h.searchDownloads.mockResolvedValue([]);

        const responsePromise = h.emit({
            action: 'build_zip',
            buildId: 'A',
            payload: { markdown: 'x', title: 'p', sourceUrl: null },
        });
        await vi.advanceTimersByTimeAsync(11_000);
        const response = await responsePromise;
        expect(response).toMatchObject({ success: true });
        const errors = h.broadcasts.filter((m) => m.type === 'zip:error');
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ buildId: 'A' });
    });

    it('watchdog stays quiet when a download item appears in progress', async () => {
        // Snapshot at build arrival must NOT absorb the item (it would make
        // the watchdog treat id 42 as pre-existing and error at the deadline).
        h.searchDownloads
            .mockResolvedValueOnce([]) // snapshotDownloadIds() before the build
            .mockResolvedValue([{ id: 42, state: 'in_progress' }]); // watchdog polls

        const responsePromise = h.emit({
            action: 'build_zip',
            buildId: 'A',
            payload: { markdown: 'x', title: 'p', sourceUrl: null },
        });
        await vi.advanceTimersByTimeAsync(11_000);
        await responsePromise;
        expect(h.broadcasts.filter((m) => m.type === 'zip:error')).toHaveLength(0);
    });

    it('offscreen document close is deferred during the 30s hold window', async () => {
        h.offscreenExists = false; // no offscreen document yet → creation path exercised
        const responsePromise = h.emit({
            action: 'build_zip',
            buildId: 'A',
            payload: { markdown: 'x', title: 'p', sourceUrl: null },
        });
        await vi.advanceTimersByTimeAsync(1_000);
        await responsePromise;
        expect(h.createDocument).toHaveBeenCalledTimes(1);
        expect(h.closeDocument).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(31_000);
        expect(h.closeDocument).toHaveBeenCalledTimes(1);
    });
});
