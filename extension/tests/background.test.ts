import { beforeEach, describe, expect, it, vi } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';

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

describe('Background zip build request flow', () => {
    let messageListener: RuntimeMessageListener | undefined;
    let sendMessageSpy: ReturnType<typeof vi.fn>;
    let sessionData: Record<string, unknown>;
    let downloadsDownload: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.resetModules();
        vi.stubEnv('VITE_API_URL', 'https://api-markdownizer.thambolo.com/convert');
        messageListener = undefined;
        sendMessageSpy = vi.fn(async () => {});
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

    it('builds a zip in the service worker and downloads it as a data URL', async () => {
        await import('../src/background');
        const responsePromise = new Promise((resolve) => {
            messageListener!(
                {
                    action: 'build_zip',
                    buildId: 'b-1',
                    payload: { markdown: '![Hero](https://e.com/hero.png)', title: 'page', sourceUrl: 'https://e.com' },
                },
                {},
                resolve,
            );
        });
        const response = await responsePromise;
        expect(response).toMatchObject({ success: true, downloaded: 'zip', filename: 'page.zip', bundledImages: 1 });
        expect(downloadsDownload).toHaveBeenCalledTimes(1);
        const [args] = downloadsDownload.mock.calls[0] as [{ url: string; filename: string }];
        expect(args.filename).toBe('page.zip');
        expect(args.url.startsWith('data:application/zip;base64,')).toBe(true);
        // Progress was relayed to storage.session and broadcast
        expect(sessionData.activeZipBuild).toBeUndefined(); // cleared on done
        const progressMsgs = sendMessageSpy.mock.calls.map((c) => c[0]);
        expect(progressMsgs.some((m) => m.type === 'zip:progress' && m.buildId === 'b-1' && m.phase === 'fetch')).toBe(true);
        expect(progressMsgs.some((m) => m.type === 'zip:done' && m.buildId === 'b-1' && m.downloaded === 'zip')).toBe(true);
    });

    it('falls back to a markdown download when nothing bundles', async () => {
        global.fetch = vi.fn(async () => { throw new Error('down'); }) as unknown as typeof fetch;
        await import('../src/background');
        const responsePromise = new Promise((resolve) => {
            messageListener!(
                {
                    action: 'build_zip',
                    buildId: 'b-2',
                    payload: { markdown: '![a](https://e.com/a.png)', title: 'page', sourceUrl: null },
                },
                {},
                resolve,
            );
        });
        const response = await responsePromise;
        expect(response).toMatchObject({ success: true, downloaded: 'md', filename: 'page.md' });
        const [args] = downloadsDownload.mock.calls[0] as [{ url: string; filename: string }];
        expect(args.filename).toBe('page.md');
        expect(args.url.startsWith('data:text/markdown;base64,')).toBe(true);
    });

    it('broadcasts zip:error and clears state when the download fails', async () => {
        downloadsDownload.mockRejectedValue(new Error('shelf full'));
        await import('../src/background');
        const responsePromise = new Promise((resolve) => {
            messageListener!(
                {
                    action: 'build_zip',
                    buildId: 'b-4',
                    payload: { markdown: '![a](https://e.com/a.png)', title: 'page', sourceUrl: null },
                },
                {},
                resolve,
            );
        });
        const response = await responsePromise;
        expect(response).toMatchObject({ success: false });
        expect(sessionData.activeZipBuild).toBeUndefined();
        const errorMsgs = sendMessageSpy.mock.calls.map((c) => c[0]);
        expect(errorMsgs.some((m) => m.type === 'zip:error' && m.buildId === 'b-4')).toBe(true);
    });

    it('includes the source page URL in the zip README (decoded from the data URL)', async () => {
        await import('../src/background');
        const responsePromise = new Promise((resolve) => {
            messageListener!(
                {
                    action: 'build_zip',
                    buildId: 'b-5',
                    payload: {
                        markdown: 'Intro\n\n![Hero](https://e.com/hero.png)',
                        title: 'page',
                        sourceUrl: 'https://e.com',
                    },
                },
                {},
                resolve,
            );
        });
        await responsePromise;
        const [args] = downloadsDownload.mock.calls[0] as [{ url: string; filename: string }];
        const base64 = args.url.split(',')[1];
        const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
        const files = unzipSync(bytes);
        const readme = strFromU8(files['README.md']);
        expect(readme).toContain('https://e.com');
        expect(strFromU8(files['page.md'])).toContain('![Hero](images/img-001.png)');
    });

    it('zip:status reports the live build and clears stale state', async () => {
        await import('../src/background');
        sessionData.activeZipBuild = { buildId: 'b-live', phase: 'fetch', fetched: 3, total: 10, startedAt: 1 };
        const statusPromise = new Promise((resolve) => {
            messageListener!({ action: 'zip:status', buildId: 'b-live' }, {}, resolve);
        });
        const status = await statusPromise;
        expect(status).toMatchObject({ active: true, buildId: 'b-live', fetched: 3, total: 10 });

        const stalePromise = new Promise((resolve) => {
            messageListener!({ action: 'zip:status', buildId: 'b-gone' }, {}, resolve);
        });
        const stale = await stalePromise;
        expect(stale).toMatchObject({ active: false });
        expect(sessionData.activeZipBuild).toBeUndefined(); // stale state cleared
    });
});
