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
