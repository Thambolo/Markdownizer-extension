import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

type RuntimeMessageListener = (
    request: unknown,
    sender: unknown,
    sendResponse: (response: unknown) => void
) => boolean | undefined;

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
        await import('../src/background/index');

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

        await import('../src/background/index');

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
        await import('../src/background/index');

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

        await import('../src/background/index');

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

        await import('../src/background/index');

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
                search: vi.fn(async () => [{ id: -1, state: 'in_progress' }]),
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
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('orchestrates offscreen build, responds metadata-only, defers the offscreen close', async () => {
        vi.useFakeTimers();
        await import('../src/background/index');
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
        // The SW no longer downloads; it only finalizes state and broadcasts.
        expect(chrome.downloads.download).not.toHaveBeenCalled();
        expect(sessionData.activeZipBuild).toBeUndefined();
        const doneMsgs = sendMessageSpy.mock.calls.map((c) => c[0]).filter((m) => m.type === 'zip:done');
        expect(doneMsgs.some((m) => m.buildId === 'b-1')).toBe(true);
        // The document stays open so an in-flight blob download can finish;
        // it closes after the 30 s hold window.
        expect(chrome.offscreen.closeDocument).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(31_000);
        expect(chrome.offscreen.closeDocument).toHaveBeenCalled();
        vi.useRealTimers();
    });

    it('reuses an existing offscreen document', async () => {
        await import('../src/background/index');
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
        await import('../src/background/index');
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
        await import('../src/background/index');
        messageListener!({ type: 'zip:progress', buildId: 'b-4', phase: 'fetch', fetched: 3, total: 10 }, {}, vi.fn());
        // The relay compares against the current state first (async read),
        // so flush the microtask chain before asserting.
        await new Promise((r) => setTimeout(r, 0));
        expect(sessionData.activeZipBuild).toMatchObject({ buildId: 'b-4', phase: 'fetch', fetched: 3, total: 10 });
    });

    it('zip:completed recovery broadcasts zip:done only for a matching buildId (idempotent)', async () => {
        await import('../src/background/index');
        sessionData.activeZipBuild = { buildId: 'b-live', phase: 'build', fetched: 0, total: 0, startedAt: 1 };
        messageListener!({ type: 'zip:completed', buildId: 'b-live', ok: true, downloaded: 'zip', filename: 'page.zip', totalImages: 2, bundledImages: 2, skippedImages: 0 }, {}, vi.fn());
        // The handler is dispatched fire-and-forget; flush the microtask chain
        // before asserting the broadcast/state effects.
        await new Promise((r) => setTimeout(r, 0));
        expect(chrome.downloads.download).not.toHaveBeenCalled();
        expect(sessionData.activeZipBuild).toBeUndefined();
        // The recovered zip:done broadcast carries the image counts for the popup note.
        const doneMsgs = sendMessageSpy.mock.calls.map((c) => c[0]).filter((m) => m.type === 'zip:done');
        expect(doneMsgs[0]).toMatchObject({ buildId: 'b-live', bundledImages: 2, totalImages: 2 });
        // A duplicate broadcast (storage already cleared) must be ignored.
        messageListener!({ type: 'zip:completed', buildId: 'b-live', ok: true, downloaded: 'zip', filename: 'page.zip', totalImages: 2, bundledImages: 2, skippedImages: 0 }, {}, vi.fn());
        await new Promise((r) => setTimeout(r, 0));
        expect(sendMessageSpy.mock.calls.map((c) => c[0]).filter((m) => m.type === 'zip:done')).toHaveLength(1);
    });

    it('does not double-finalize when recovery finalizes before the response path', async () => {
        await import('../src/background/index');
        // Hold ONLY the offscreen:build response open so the recovery
        // broadcast can land first.
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
        const doneCount = () => sendMessageSpy.mock.calls.map((c) => c[0]).filter((m) => m.type === 'zip:done' && m.buildId === 'b-race').length;
        expect(doneCount()).toBe(1); // recovery broadcast it once
        // Now the response path resolves: the Map claim must prevent a second finalize.
        releaseResponse({ ok: true, buildId: 'b-race', downloaded: 'zip', filename: 'page.zip', totalImages: 1, bundledImages: 1, skippedImages: 0 });
        const response = await responsePromise;
        expect(response).toMatchObject({ success: true });
        expect(doneCount()).toBe(1); // still exactly one zip:done
        expect(chrome.downloads.download).not.toHaveBeenCalled();
    });

    it('responds success: false when the offscreen build fails', async () => {
        await import('../src/background/index');
        chrome.runtime.sendMessage.mockImplementation((message: { type?: string }) =>
            message?.type === 'offscreen:build'
                ? Promise.resolve({ ok: false, error: 'build exploded' })
                : Promise.resolve({ ok: true, buildId: 'b-fail', downloaded: 'zip', filename: 'page.zip', totalImages: 1, bundledImages: 1, skippedImages: 0 }),
        );
        const responsePromise = new Promise((resolve) => {
            messageListener!(
                { action: 'build_zip', buildId: 'b-fail', payload: { markdown: '![a](https://e.com/a.png)', title: 'p', sourceUrl: null } },
                {},
                resolve,
            );
        });
        const response = await responsePromise;
        expect(response).toMatchObject({ success: false });
        const errorMsgs = sendMessageSpy.mock.calls.map((c) => c[0]).filter((m) => m.type === 'zip:error');
        expect(errorMsgs.some((m) => m.buildId === 'b-fail')).toBe(true);
        expect(sessionData.activeZipBuild).toBeUndefined();
        expect(chrome.downloads.download).not.toHaveBeenCalled();
    });

    it('zip:status reports active while a matching offscreen document exists', async () => {
        await import('../src/background/index');
        sessionData.activeZipBuild = { buildId: 'b-live2', phase: 'build', fetched: 0, total: 0, startedAt: 1 };
        chrome.runtime.getContexts.mockResolvedValue([{ contextType: 'OFFSCREEN_DOCUMENT' }]);
        const statusPromise = new Promise((resolve) => {
            messageListener!({ action: 'zip:status', buildId: 'b-live2' }, {}, resolve);
        });
        const status = await statusPromise;
        expect(status).toMatchObject({ active: true, buildId: 'b-live2' });
        expect(sessionData.activeZipBuild).toBeDefined();
    });

    it('zip:status clears stale state when no offscreen document exists', async () => {
        await import('../src/background/index');
        sessionData.activeZipBuild = { buildId: 'b-stale', phase: 'fetch', fetched: 1, total: 2, startedAt: 1 };
        chrome.runtime.getContexts.mockResolvedValue([]); // orphaned: no document
        const statusPromise = new Promise((resolve) => {
            messageListener!({ action: 'zip:status', buildId: 'b-stale' }, {}, resolve);
        });
        const status = await statusPromise;
        expect(status).toMatchObject({ active: false });
        expect(sessionData.activeZipBuild).toBeUndefined();
    });

    it("stale build progress does not clobber a newer build's state", async () => {
        await import('../src/background/index');
        sessionData.activeZipBuild = { buildId: 'b-new', phase: 'fetch', fetched: 1, total: 5, startedAt: 1 };
        // A late progress tick from an older build must be ignored: the
        // state now belongs to b-new.
        messageListener!({ type: 'zip:progress', buildId: 'b-old', phase: 'fetch', fetched: 9, total: 9 }, {}, vi.fn());
        await new Promise((r) => setTimeout(r, 0));
        expect(sessionData.activeZipBuild).toMatchObject({ buildId: 'b-new', phase: 'fetch', fetched: 1, total: 5 });
        // Progress from the owning build still updates the state.
        messageListener!({ type: 'zip:progress', buildId: 'b-new', phase: 'fetch', fetched: 3, total: 5 }, {}, vi.fn());
        await new Promise((r) => setTimeout(r, 0));
        expect(sessionData.activeZipBuild).toMatchObject({ buildId: 'b-new', phase: 'fetch', fetched: 3, total: 5 });
    });

    it("an older build's failure does not clear a newer build's state", async () => {
        await import('../src/background/index');
        // Hold the older build's offscreen:build request open so the newer
        // build can claim the shared state before the older build fails.
        let rejectOldBuild: (err: Error) => void = () => {};
        chrome.runtime.sendMessage.mockImplementation((message: { type?: string; buildId?: string }) =>
            message?.type === 'offscreen:build' && message.buildId === 'b-old'
                ? new Promise((_, reject) => { rejectOldBuild = reject; })
                : Promise.resolve({ ok: true, buildId: message?.buildId, downloaded: 'zip', filename: 'page.zip', totalImages: 1, bundledImages: 1, skippedImages: 0 }),
        );
        const oldResponsePromise = new Promise((resolve) => {
            messageListener!(
                { action: 'build_zip', buildId: 'b-old', payload: { markdown: '# hi', title: 'p', sourceUrl: null } },
                {},
                resolve,
            );
        });
        await new Promise((r) => setTimeout(r, 10)); // b-old is mid-flight
        // Build B claims the state (as its unconditional initial write
        // would), then build A's request fails.
        sessionData.activeZipBuild = { buildId: 'b-new', phase: 'fetch', fetched: 1, total: 5, startedAt: 1 };
        rejectOldBuild(new Error('boom'));
        const response = await oldResponsePromise;
        expect(response).toMatchObject({ success: false });
        expect(sessionData.activeZipBuild).toMatchObject({ buildId: 'b-new', phase: 'fetch', fetched: 1, total: 5 });
        const errorMsgs = sendMessageSpy.mock.calls.map((c) => c[0]).filter((m) => m.type === 'zip:error');
        expect(errorMsgs.some((m) => m.buildId === 'b-old')).toBe(true);
    });

    it("stale progress enqueued before a new build claim still loses", async () => {
        await import('../src/background/index');
        // Hold the new build's offscreen round-trip open so its claim is
        // still observable mid-flight (the queued ops below run first).
        let releaseBuild: (r: unknown) => void = () => {};
        chrome.runtime.sendMessage.mockImplementation((message: { type?: string; buildId?: string }) =>
            message?.type === 'offscreen:build'
                ? new Promise((resolve) => { releaseBuild = resolve; })
                : Promise.resolve({ ok: true, buildId: message?.buildId, downloaded: 'zip', filename: 'page.zip', totalImages: 1, bundledImages: 1, skippedImages: 0 }),
        );
        // The old build's late progress relay fires first (fire-and-forget)...
        messageListener!({ type: 'zip:progress', buildId: 'b-old', phase: 'fetch', fetched: 9, total: 9 }, {}, vi.fn());
        // ...and the new build's initial claim enqueues after it.
        const responsePromise = new Promise((resolve) => {
            messageListener!(
                { action: 'build_zip', buildId: 'b-new', payload: { markdown: '![a](https://e.com/a.png)', title: 'p', sourceUrl: null } },
                {},
                resolve,
            );
        });
        await new Promise((r) => setTimeout(r, 10)); // both queued mutations have run
        expect(sessionData.activeZipBuild).toMatchObject({ buildId: 'b-new' });
        // A second stale tick still cannot clobber the newer claim.
        messageListener!({ type: 'zip:progress', buildId: 'b-old', phase: 'fetch', fetched: 9, total: 9 }, {}, vi.fn());
        await new Promise((r) => setTimeout(r, 0));
        expect(sessionData.activeZipBuild).toMatchObject({ buildId: 'b-new' });
        releaseBuild({ ok: true, buildId: 'b-new', downloaded: 'zip', filename: 'page.zip', totalImages: 1, bundledImages: 1, skippedImages: 0 });
        await responsePromise;
    });

    it("new build claim enqueued before stale progress still wins", async () => {
        await import('../src/background/index');
        let releaseBuild: (r: unknown) => void = () => {};
        chrome.runtime.sendMessage.mockImplementation((message: { type?: string; buildId?: string }) =>
            message?.type === 'offscreen:build'
                ? new Promise((resolve) => { releaseBuild = resolve; })
                : Promise.resolve({ ok: true, buildId: message?.buildId, downloaded: 'zip', filename: 'page.zip', totalImages: 1, bundledImages: 1, skippedImages: 0 }),
        );
        const responsePromise = new Promise((resolve) => {
            messageListener!(
                { action: 'build_zip', buildId: 'b-new', payload: { markdown: '![a](https://e.com/a.png)', title: 'p', sourceUrl: null } },
                {},
                resolve,
            );
        });
        // Let the new build's initial claim enqueue (and run) first.
        await new Promise((r) => setTimeout(r, 0));
        // Stale progress from an older build enqueues after the claim.
        messageListener!({ type: 'zip:progress', buildId: 'b-old', phase: 'fetch', fetched: 9, total: 9 }, {}, vi.fn());
        await new Promise((r) => setTimeout(r, 0));
        expect(sessionData.activeZipBuild).toMatchObject({ buildId: 'b-new', phase: 'fetch', fetched: 0, total: 0 });
        releaseBuild({ ok: true, buildId: 'b-new', downloaded: 'zip', filename: 'page.zip', totalImages: 1, bundledImages: 1, skippedImages: 0 });
        await responsePromise;
    });

    it("stale build failure cannot remove a newer claim", async () => {
        await import('../src/background/index');
        sessionData.activeZipBuild = { buildId: 'b-new', phase: 'fetch', fetched: 1, total: 5, startedAt: 1 };
        // b-old fails BEFORE its initial write ever claims the state (the
        // offscreen document creation rejects), so the catch's compare-and-
        // clear must leave the newer claim untouched.
        chrome.offscreen.createDocument.mockRejectedValue(new Error('cannot create'));
        const responsePromise = new Promise((resolve) => {
            messageListener!(
                { action: 'build_zip', buildId: 'b-old', payload: { markdown: '# hi', title: 'p', sourceUrl: null } },
                {},
                resolve,
            );
        });
        const response = await responsePromise;
        expect(response).toMatchObject({ success: false });
        expect(sessionData.activeZipBuild).toMatchObject({ buildId: 'b-new', phase: 'fetch', fetched: 1, total: 5 });
    });

    it('broadcasts zip:error when no download item appears within the watch window', async () => {
        vi.useFakeTimers();
        await import('../src/background/index');
        const responsePromise = new Promise((resolve) => {
            messageListener!(
                { action: 'build_zip', buildId: 'b-watch', payload: { markdown: '![a](https://e.com/a.png)', title: 'p', sourceUrl: null } },
                {},
                resolve,
            );
        });
        const response = await responsePromise;
        expect(response).toMatchObject({ success: true });
        await vi.advanceTimersByTimeAsync(11_000);
        const errorMsgs = sendMessageSpy.mock.calls.map((c) => c[0]).filter((m) => m.type === 'zip:error');
        expect(errorMsgs.some((m) => m.buildId === 'b-watch')).toBe(true);
        vi.useRealTimers();
    });

    it('does not broadcast zip:error when a download item appears', async () => {
        vi.useFakeTimers();
        const search = chrome.downloads.search as ReturnType<typeof vi.fn>;
        search
            .mockResolvedValueOnce([]) // snapshot at build_zip arrival
            .mockResolvedValueOnce([{ id: 999, state: 'in_progress' }]); // first watchdog poll
        await import('../src/background/index');
        const responsePromise = new Promise((resolve) => {
            messageListener!(
                { action: 'build_zip', buildId: 'b-watch2', payload: { markdown: '![a](https://e.com/a.png)', title: 'p', sourceUrl: null } },
                {},
                resolve,
            );
        });
        const response = await responsePromise;
        expect(response).toMatchObject({ success: true });
        await vi.advanceTimersByTimeAsync(11_000);
        const errorMsgs = sendMessageSpy.mock.calls.map((c) => c[0]).filter((m) => m.type === 'zip:error' && m.buildId === 'b-watch2');
        expect(errorMsgs).toHaveLength(0);
        expect(search).toHaveBeenCalledTimes(2); // snapshot + first poll, then stopped
        vi.useRealTimers();
    });

    it('broadcasts zip:error when the new download item is interrupted', async () => {
        vi.useFakeTimers();
        const search = chrome.downloads.search as ReturnType<typeof vi.fn>;
        search
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ id: 999, state: 'interrupted' }]);
        await import('../src/background/index');
        const responsePromise = new Promise((resolve) => {
            messageListener!(
                { action: 'build_zip', buildId: 'b-watch3', payload: { markdown: '![a](https://e.com/a.png)', title: 'p', sourceUrl: null } },
                {},
                resolve,
            );
        });
        await responsePromise;
        await vi.advanceTimersByTimeAsync(0);
        const errorMsgs = sendMessageSpy.mock.calls.map((c) => c[0]).filter((m) => m.type === 'zip:error');
        expect(errorMsgs.some((m) => m.buildId === 'b-watch3')).toBe(true);
        vi.useRealTimers();
    });

    it('ignores an unrelated interrupted item when a new item is downloading', async () => {
        vi.useFakeTimers();
        const search = chrome.downloads.search as ReturnType<typeof vi.fn>;
        search
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ id: 999, state: 'interrupted' }, { id: 1000, state: 'in_progress' }]);
        await import('../src/background/index');
        const responsePromise = new Promise((resolve) => {
            messageListener!(
                { action: 'build_zip', buildId: 'b-watch4', payload: { markdown: '![a](https://e.com/a.png)', title: 'p', sourceUrl: null } },
                {},
                resolve,
            );
        });
        await responsePromise;
        await vi.advanceTimersByTimeAsync(11_000);
        const errorMsgs = sendMessageSpy.mock.calls.map((c) => c[0]).filter((m) => m.type === 'zip:error' && m.buildId === 'b-watch4');
        expect(errorMsgs).toHaveLength(0);
        vi.useRealTimers();
    });

    it('recovery watchdog: zip:completed with no item broadcasts zip:error', async () => {
        vi.useFakeTimers();
        (chrome.downloads.search as ReturnType<typeof vi.fn>).mockResolvedValue([]);
        await import('../src/background/index');
        sessionData.activeZipBuild = { buildId: 'b-recv', phase: 'build', fetched: 0, total: 0, startedAt: 1 };
        messageListener!({ type: 'zip:completed', buildId: 'b-recv', ok: true, downloaded: 'zip', filename: 'page.zip', totalImages: 2, bundledImages: 2, skippedImages: 0 }, {}, vi.fn());
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(11_000);
        const errorMsgs = sendMessageSpy.mock.calls.map((c) => c[0]).filter((m) => m.type === 'zip:error');
        expect(errorMsgs.some((m) => m.buildId === 'b-recv')).toBe(true);
        vi.useRealTimers();
    });

    it('recovery watchdog: zip:completed with the item present broadcasts no zip:error', async () => {
        vi.useFakeTimers();
        const search = chrome.downloads.search as ReturnType<typeof vi.fn>;
        search.mockResolvedValueOnce([{ id: 999, state: 'in_progress' }]);
        await import('../src/background/index');
        sessionData.activeZipBuild = { buildId: 'b-recv2', phase: 'build', fetched: 0, total: 0, startedAt: 1 };
        messageListener!({ type: 'zip:completed', buildId: 'b-recv2', ok: true, downloaded: 'zip', filename: 'page.zip', totalImages: 2, bundledImages: 2, skippedImages: 0 }, {}, vi.fn());
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(11_000);
        const errorMsgs = sendMessageSpy.mock.calls.map((c) => c[0]).filter((m) => m.type === 'zip:error' && m.buildId === 'b-recv2');
        expect(errorMsgs).toHaveLength(0);
        vi.useRealTimers();
    });

    it('builds succeed when the downloads API is unavailable', async () => {
        await import('../src/background/index');
        delete (global.chrome as { downloads?: unknown }).downloads;
        const responsePromise = new Promise((resolve) => {
            messageListener!(
                { action: 'build_zip', buildId: 'b-guard', payload: { markdown: '![a](https://e.com/a.png)', title: 'p', sourceUrl: null } },
                {},
                resolve,
            );
        });
        const response = await responsePromise;
        expect(response).toMatchObject({ success: true });
        expect(sendMessageSpy.mock.calls.map((c) => c[0]).filter((m) => m.type === 'zip:error')).toHaveLength(0);
    });

    it('takes the download snapshot once per worker instance (overlapping builds)', async () => {
        await import('../src/background/index');
        const search = chrome.downloads.search as ReturnType<typeof vi.fn>;
        // Call 1 = the snapshot (must be EMPTY so 999 counts as new for the
        // watchdogs); calls 2+ = watchdog polls (the item exists).
        let searchCalls = 0;
        search.mockImplementation(async () => {
            searchCalls += 1;
            return searchCalls === 1 ? [] : [{ id: 999, state: 'in_progress' }];
        });
        const releases: Array<(r: unknown) => void> = [];
        chrome.runtime.sendMessage.mockImplementation((message: { type?: string; buildId?: string }) =>
            message?.type === 'offscreen:build'
                ? new Promise((resolve) => { releases.push(resolve); })
                : Promise.resolve({ ok: true, buildId: message.buildId, downloaded: 'zip', filename: 'page.zip', totalImages: 1, bundledImages: 1, skippedImages: 0 }),
        );
        const dispatch = (buildId: string) => new Promise((resolve) => {
            messageListener!(
                { action: 'build_zip', buildId, payload: { markdown: '![a](https://e.com/a.png)', title: 'p', sourceUrl: null } },
                {},
                resolve,
            );
        });
        const responseA = dispatch('b-ovA');
        await new Promise((r) => setTimeout(r, 10)); // A reaches the offscreen await
        const responseB = dispatch('b-ovB');
        await new Promise((r) => setTimeout(r, 10)); // B arrives while A is in flight
        releases[1]({ ok: true, buildId: 'b-ovB', downloaded: 'zip', filename: 'page.zip', totalImages: 1, bundledImages: 1, skippedImages: 0 });
        await responseB;
        releases[0]({ ok: true, buildId: 'b-ovA', downloaded: 'zip', filename: 'page.zip', totalImages: 1, bundledImages: 1, skippedImages: 0 });
        await responseA;
        // Snapshot taken ONCE (B's arrival did not refresh it); both watchdogs
        // found the item via their polls — no false zip:error.
        expect(search).toHaveBeenCalledTimes(3); // 1 snapshot + A poll + B poll
        const errorMsgs = sendMessageSpy.mock.calls.map((c) => c[0]).filter((m) => m.type === 'zip:error');
        expect(errorMsgs).toHaveLength(0);
    });
});
