import { beforeEach, describe, expect, it, vi } from 'vitest';

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
