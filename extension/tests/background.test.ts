import { beforeEach, describe, expect, it, vi } from 'vitest';

type RuntimeMessageListener = (
    request: unknown,
    sender: unknown,
    sendResponse: (response: unknown) => void
) => boolean | undefined;

// The background reads/deletes the build payload from IndexedDB; the node
// test environment has no real IndexedDB, so mock the payload store.
vi.mock('../src/idb-payload', () => ({
    readPayload: vi.fn(async () => new Uint8Array([1, 2, 3])),
    deletePayload: vi.fn(async () => {}),
}));

describe('Background conversion request flow', () => {
    let messageListener: RuntimeMessageListener | undefined;

    beforeEach(() => {
        vi.resetModules();
        vi.stubEnv('VITE_API_URL', 'https://api-markdownizer.thambolo.com/convert');
        messageListener = undefined;

        global.chrome = {
            runtime: {
                onInstalled: {
                    addListener: vi.fn()
                },
                onMessage: {
                    addListener: vi.fn((listener: RuntimeMessageListener) => {
                        messageListener = listener;
                    })
                }
            },
            storage: {
                sync: {
                    get: vi.fn(async () => ({ user_id: 'test-user-id' })),
                    set: vi.fn(async () => undefined)
                },
                local: {
                    get: vi.fn(async () => ({})),
                    set: vi.fn(async () => undefined)
                }
            }
        } as unknown as typeof chrome;

        global.fetch = vi.fn(async () => new Response(
            JSON.stringify({ markdown_skeleton: '# {{MDZ0}}' }),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }
        ));
    });

    it('sends conversion requests from the background worker without spoofing Origin', async () => {
        await import('../src/background');

        expect(messageListener).toBeDefined();

        const responsePromise = new Promise((resolve) => {
            const keepChannelOpen = messageListener?.(
                {
                    action: 'convert_skeleton',
                    payload: {
                        html_skeleton: '<article>{{MDZ0}}</article>',
                        url: 'https://example.com/private-page',
                        client_type: 'extension',
                        extraction_strategy: 'semantic-html'
                    }
                },
                {},
                resolve
            );

            expect(keepChannelOpen).toBe(true);
        });

        await expect(responsePromise).resolves.toEqual({
            success: true,
            markdown_skeleton: '# {{MDZ0}}'
        });

        expect(fetch).toHaveBeenCalledTimes(1);
        const [url, options] = vi.mocked(fetch).mock.calls[0];
        const request = options as RequestInit;
        const headers = request.headers as Record<string, string>;

        expect(url).toBe('https://api-markdownizer.thambolo.com/convert');
        expect(request.method).toBe('POST');
        expect(headers).toEqual({
            'Content-Type': 'application/json',
            'X-User-ID': 'test-user-id'
        });
        expect(headers).not.toHaveProperty('Origin');
        expect(JSON.parse(request.body as string)).toEqual({
            html_skeleton: '<article>{{MDZ0}}</article>',
            url: 'https://example.com/private-page',
            client_type: 'extension',
            extraction_strategy: 'semantic-html'
        });
    });
});

describe('CodeMirror MAIN-world capture', () => {
    let messageListener: RuntimeMessageListener | undefined;
    let executeScriptMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.resetModules();
        vi.stubEnv('VITE_API_URL', 'https://api-markdownizer.thambolo.com/convert');
        messageListener = undefined;
        executeScriptMock = vi.fn();

        global.chrome = {
            runtime: {
                onInstalled: {
                    addListener: vi.fn()
                },
                onMessage: {
                    addListener: vi.fn((listener: RuntimeMessageListener) => {
                        messageListener = listener;
                    })
                }
            },
            scripting: {
                executeScript: executeScriptMock,
            },
            storage: {
                sync: {
                    get: vi.fn(async () => ({ user_id: 'test-user-id' })),
                    set: vi.fn(async () => undefined)
                },
                local: {
                    get: vi.fn(async () => ({})),
                    set: vi.fn(async () => undefined)
                }
            }
        } as unknown as typeof chrome;

        global.fetch = vi.fn(async () => new Response(
            JSON.stringify({ markdown_skeleton: '# {{MDZ0}}' }),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }
        ));
    });

    it('calls chrome.scripting.executeScript with MAIN world and frameIds:[0]', async () => {
        const mockCapture = {
            editors: [{ path: [0], value: 'editor content' }],
            frames: {},
        };
        executeScriptMock.mockResolvedValue([{ result: mockCapture }]);

        await import('../src/background');

        const responsePromise = new Promise((resolve) => {
            messageListener?.(
                { action: 'read_codemirror_capture' },
                { tab: { id: 42 } },
                resolve,
            );
        });

        const result = await responsePromise;
        expect(result).toEqual({ success: true, capture: mockCapture });
        expect(executeScriptMock).toHaveBeenCalledTimes(1);
        expect(executeScriptMock).toHaveBeenCalledWith({
            target: { tabId: 42, frameIds: [0] },
            world: 'MAIN',
            func: expect.any(Function),
        });
    });

    it('returns failure when sender has no tab id', async () => {
        await import('../src/background');

        const responsePromise = new Promise((resolve) => {
            messageListener?.(
                { action: 'read_codemirror_capture' },
                {},
                resolve,
            );
        });

        await expect(responsePromise).resolves.toEqual({ success: false });
        expect(executeScriptMock).not.toHaveBeenCalled();
    });

    it('returns failure when executeScript rejects', async () => {
        executeScriptMock.mockRejectedValue(new Error('Cannot access tab'));

        await import('../src/background');

        const responsePromise = new Promise((resolve) => {
            messageListener?.(
                { action: 'read_codemirror_capture' },
                { tab: { id: 99 } },
                resolve,
            );
        });

        await expect(responsePromise).resolves.toEqual({ success: false });
    });

    it('returns null capture when executeScript returns empty result', async () => {
        executeScriptMock.mockResolvedValue([]);

        await import('../src/background');

        const responsePromise = new Promise((resolve) => {
            messageListener?.(
                { action: 'read_codemirror_capture' },
                { tab: { id: 42 } },
                resolve,
            );
        });

        await expect(responsePromise).resolves.toEqual({ success: true, capture: null });
    });
});

describe('Background offscreen zip build flow', () => {
    // Reuse the message-listener capture + sessionData pattern from the
    // existing zip describe; runtime.sendMessage resolves with metadata:
    //   { ok: true, buildId, downloaded: 'zip', filename: 'page.zip',
    //     totalImages: 1, bundledImages: 1, skippedImages: 0 }
    let messageListener: RuntimeMessageListener | undefined;
    let sendMessageSpy: ReturnType<typeof vi.fn>;
    let sessionData: Record<string, unknown>;
    let downloadsDownload: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.resetModules();
        vi.stubEnv('VITE_API_URL', 'https://api-markdownizer.thambolo.com/convert');
        messageListener = undefined;
        sendMessageSpy = vi.fn(async (message: { buildId?: string }) => ({
            ok: true,
            buildId: message?.buildId,
            downloaded: 'zip',
            filename: 'page.zip',
            totalImages: 1,
            bundledImages: 1,
            skippedImages: 0,
        }));
        downloadsDownload = vi.fn(async () => 'download-id');
        sessionData = {};

        global.chrome = {
            runtime: {
                onInstalled: { addListener: vi.fn() },
                onMessage: {
                    addListener: vi.fn((listener: RuntimeMessageListener) => {
                        messageListener = listener;
                    }),
                },
                sendMessage: sendMessageSpy,
                getContexts: vi.fn(async () => []),
                getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
            },
            offscreen: {
                createDocument: vi.fn(async () => {}),
                closeDocument: vi.fn(async () => {}),
            },
            downloads: {
                download: downloadsDownload,
            },
            storage: {
                sync: {
                    get: vi.fn(async () => ({ user_id: 'test-user-id' })),
                    set: vi.fn(async () => undefined),
                },
                local: {
                    get: vi.fn(async () => ({})),
                    set: vi.fn(async () => undefined),
                },
                session: {
                    get: vi.fn(async (keys: string | string[]) => {
                        const key = Array.isArray(keys) ? keys[0] : keys;
                        return key in sessionData ? { [key]: sessionData[key] } : {};
                    }),
                    set: vi.fn(async (items: Record<string, unknown>) => {
                        Object.assign(sessionData, items);
                    }),
                    remove: vi.fn(async (keys: string | string[]) => {
                        const list = Array.isArray(keys) ? keys : [keys];
                        for (const key of list) delete sessionData[key];
                    }),
                },
            },
        } as unknown as typeof chrome;

        global.fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;
        global.btoa = (input: string) => Buffer.from(input, 'binary').toString('base64');
    });

    it('orchestrates offscreen build, downloads the payload, responds metadata-only', async () => {
        await import('../src/background');
        chrome.offscreen.createDocument.mockClear();
        chrome.runtime.getContexts.mockResolvedValue([]); // no document yet -> create
        const responsePromise = new Promise((resolve) => {
            messageListener!(
                { action: 'build_zip', buildId: 'b-1', payload: { markdown: '![Hero](https://e.com/hero.png)', title: 'page', sourceUrl: 'https://e.com' } },
                {},
                resolve,
            );
        });
        const response = await responsePromise;
        expect(response).not.toHaveProperty('bytes');
        expect(response).not.toHaveProperty('dataUrl');
        expect(response).toMatchObject({ success: true, downloaded: 'zip', filename: 'page.zip', bundledImages: 1 });
        expect(chrome.offscreen.createDocument).toHaveBeenCalledWith(
            expect.objectContaining({ url: expect.stringContaining('offscreen.html'), reasons: ['BLOBS'] }),
        );
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'offscreen:build', buildId: 'b-1' }),
        );
        const { readPayload } = await import('../src/idb-payload');
        expect(readPayload).toHaveBeenCalledWith('b-1');
        const [downloadArgs] = downloadsDownload.mock.calls[0] as [{ url: string; filename: string }];
        expect(downloadArgs.filename).toBe('page.zip');
        expect(downloadArgs.url.startsWith('data:application/zip;base64,')).toBe(true);
        expect(sessionData.activeZipBuild).toBeUndefined();
        const doneMsgs = sendMessageSpy.mock.calls.map((c) => c[0]).filter((m) => m.type === 'zip:done');
        expect(doneMsgs.some((m) => m.buildId === 'b-1')).toBe(true);
        expect(chrome.offscreen.closeDocument).toHaveBeenCalled();
    });

    it('reuses an existing offscreen document', async () => {
        await import('../src/background');
        chrome.runtime.getContexts.mockResolvedValue([{ contextType: 'OFFSCREEN_DOCUMENT' }]);
        const responsePromise = new Promise((resolve) => {
            messageListener!(
                { action: 'build_zip', buildId: 'b-2', payload: { markdown: '![a](https://e.com/a.png)', title: 'p', sourceUrl: null } },
                {},
                resolve,
            );
        });
        await responsePromise;
        expect(chrome.offscreen.createDocument).not.toHaveBeenCalled();
    });

    it('fails gracefully when the offscreen API is unsupported', async () => {
        await import('../src/background');
        delete (global.chrome as { offscreen?: unknown }).offscreen;
        const responsePromise = new Promise((resolve) => {
            messageListener!(
                { action: 'build_zip', buildId: 'b-3', payload: { markdown: '# hi', title: 'p', sourceUrl: null } },
                {},
                resolve,
            );
        });
        const response = await responsePromise;
        expect(response).toMatchObject({ success: false });
        expect(sendMessageSpy.mock.calls.some((c) => c[0].type === 'zip:error' && c[0].buildId === 'b-3')).toBe(true);
    });

    it('relays offscreen zip:progress broadcasts to storage.session', async () => {
        await import('../src/background');
        messageListener!({ type: 'zip:progress', buildId: 'b-4', phase: 'fetch', fetched: 3, total: 10 }, {}, vi.fn());
        expect(sessionData.activeZipBuild).toMatchObject({ buildId: 'b-4', phase: 'fetch', fetched: 3, total: 10 });
    });

    it('zip:completed recovery downloads only for a matching buildId (idempotent)', async () => {
        await import('../src/background');
        sessionData.activeZipBuild = { buildId: 'b-live', phase: 'build', fetched: 0, total: 0, startedAt: 1 };
        const { deletePayload } = await import('../src/idb-payload');
        messageListener!({ type: 'zip:completed', buildId: 'b-live', ok: true, downloaded: 'zip', filename: 'page.zip', totalImages: 2, bundledImages: 2, skippedImages: 0 }, {}, vi.fn());
        // The handler is dispatched fire-and-forget; flush the microtask chain
        // before asserting the download/state effects.
        await new Promise((r) => setTimeout(r, 0));
        expect(downloadsDownload).toHaveBeenCalledTimes(1);
        expect(deletePayload).toHaveBeenCalledWith('b-live');
        expect(sessionData.activeZipBuild).toBeUndefined();
        // The recovered zip:done broadcast carries the image counts for the popup note.
        const doneMsgs = sendMessageSpy.mock.calls.map((c) => c[0]).filter((m) => m.type === 'zip:done');
        expect(doneMsgs[0]).toMatchObject({ buildId: 'b-live', bundledImages: 2, totalImages: 2 });
        // A duplicate broadcast (storage already cleared) must be ignored.
        downloadsDownload.mockClear();
        messageListener!({ type: 'zip:completed', buildId: 'b-live', ok: true, downloaded: 'zip', filename: 'page.zip', totalImages: 2, bundledImages: 2, skippedImages: 0 }, {}, vi.fn());
        await new Promise((r) => setTimeout(r, 0));
        expect(downloadsDownload).not.toHaveBeenCalled();
    });

    it('does not double-download when recovery finalizes before the response path', async () => {
        await import('../src/background');
        // Hold ONLY the offscreen:build response open so the recovery
        // broadcast can land first. (The recovery path's zip:done broadcast
        // also calls runtime.sendMessage — if it were held too, it would
        // overwrite releaseResponse and the response path would hang.)
        let releaseResponse: (r: unknown) => void = () => {};
        chrome.runtime.sendMessage.mockImplementation((message: { type?: string }) =>
            message?.type === 'offscreen:build'
                ? new Promise((resolve) => { releaseResponse = resolve; })
                : Promise.resolve({ ok: true, buildId: 'b-race', downloaded: 'zip', filename: 'page.zip', totalImages: 1, bundledImages: 1, skippedImages: 0 }),
        );
        sessionData.activeZipBuild = { buildId: 'b-race', phase: 'build', fetched: 0, total: 0, startedAt: 1 };
        const responsePromise = new Promise((resolve) => {
            messageListener!(
                { action: 'build_zip', buildId: 'b-race', payload: { markdown: '![a](https://e.com/a.png)', title: 'p', sourceUrl: null } },
                {},
                resolve,
            );
        });
        await new Promise((r) => setTimeout(r, 10)); // let the handler reach the sendMessage await
        // Recovery finalizes first (storage matches).
        messageListener!({ type: 'zip:completed', buildId: 'b-race', ok: true, downloaded: 'zip', filename: 'page.zip', totalImages: 1, bundledImages: 1, skippedImages: 0 }, {}, vi.fn());
        await new Promise((r) => setTimeout(r, 10));
        expect(downloadsDownload).toHaveBeenCalledTimes(1);
        // Now the response path resolves: the Set claim must prevent a second download.
        releaseResponse({ ok: true, buildId: 'b-race', downloaded: 'zip', filename: 'page.zip', totalImages: 1, bundledImages: 1, skippedImages: 0 });
        const response = await responsePromise;
        expect(response).toMatchObject({ success: true });
        expect(downloadsDownload).toHaveBeenCalledTimes(1); // still exactly one
    });

    it('zip:status clears stale state when no offscreen document exists', async () => {
        await import('../src/background');
        sessionData.activeZipBuild = { buildId: 'b-stale', phase: 'fetch', fetched: 1, total: 2, startedAt: 1 };
        chrome.runtime.getContexts.mockResolvedValue([]); // orphaned: no document
        const statusPromise = new Promise((resolve) => {
            messageListener!({ action: 'zip:status', buildId: 'b-stale' }, {}, resolve);
        });
        const status = await statusPromise;
        expect(status).toMatchObject({ active: false });
        expect(sessionData.activeZipBuild).toBeUndefined();
    });
});
