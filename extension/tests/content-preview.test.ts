// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { PREVIEW_HOST_ATTRIBUTE } from '../src/capture-preview';

// ── Chrome API Mocks ──────────────────────────────────────────────────────────

type RuntimeConnectListener = (port: MockPort) => void;

interface MockPort {
    name: string;
    postMessage: ReturnType<typeof vi.fn>;
    onMessage: { addListener: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> };
    onDisconnect: { addListener: ReturnType<typeof vi.fn> };
    // Test helpers
    _messageCallbacks: Array<(msg: unknown) => void>;
    _disconnectCallbacks: Array<() => void>;
    emitMessage(msg: unknown): void;
    emitDisconnect(): void;
}

function createMockPort(name: string): MockPort {
    const port: MockPort = {
        name,
        postMessage: vi.fn(),
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        _messageCallbacks: [],
        _disconnectCallbacks: [],
        emitMessage(msg: unknown) {
            for (const cb of port._messageCallbacks) cb(msg);
        },
        emitDisconnect() {
            for (const cb of port._disconnectCallbacks) cb();
        },
    };

    // Wire addListener to record callbacks
    port.onMessage.addListener.mockImplementation((cb: (msg: unknown) => void) => {
        port._messageCallbacks.push(cb);
    });
    port.onMessage.removeListener.mockImplementation((cb: (msg: unknown) => void) => {
        const idx = port._messageCallbacks.indexOf(cb);
        if (idx !== -1) port._messageCallbacks.splice(idx, 1);
    });
    port.onDisconnect.addListener.mockImplementation((cb: () => void) => {
        port._disconnectCallbacks.push(cb);
    });

    return port;
}

let connectListener: RuntimeConnectListener | undefined;

function createChromeMock() {
    return {
        runtime: {
            onInstalled: { addListener: vi.fn() },
            onMessage: {
                addListener: vi.fn(() => {
                    // messageListener not needed for preview protocol tests
                })
            },
            onConnect: {
                addListener: vi.fn((listener: RuntimeConnectListener) => {
                    connectListener = listener;
                })
            },
            sendMessage: vi.fn(async () => {
                return { success: true, markdown_skeleton: '# Test' };
            })
        }
    };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function setupDOM(html: string) {
    document.documentElement.innerHTML = html;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// ── Stubs for browser APIs missing in jsdom ───────────────────────────────────

class StubResizeObserver {
    callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) { this.callback = callback; }
    observe() {}
    unobserve() {}
    disconnect() {}
}

class StubMutationObserver {
    callback: MutationCallback;
    constructor(callback: MutationCallback) { this.callback = callback; }
    observe() {}
    disconnect() {}
    takeRecords(): MutationRecord[] { return []; }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Content-script preview protocol', () => {
    beforeEach(() => {
        vi.stubGlobal('ResizeObserver', StubResizeObserver);
        vi.stubGlobal('MutationObserver', StubMutationObserver);
        vi.resetModules();
        // @ts-expect-error – injecting global chrome for content script
        global.chrome = createChromeMock();
        connectListener = undefined;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        // Clean up any preview host left in the DOM
        const host = document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`);
        if (host) host.remove();
    });

    it('creates overlay host on show and sets loading state', async () => {
        setupDOM('<body><main><h1>Hello</h1></main></body>');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);

        port.emitMessage({ type: 'preview:show', sessionId: 's1' });

        const host = document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`);
        expect(host).not.toBeNull();
        expect(host?.getAttribute('data-preview-state')).toBe('loading');
    });

    it('transitions to ready state', async () => {
        setupDOM('<body><main><h1>Hello</h1></main></body>');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);

        port.emitMessage({ type: 'preview:show', sessionId: 's1' });
        port.emitMessage({ type: 'preview:ready', sessionId: 's1' });

        const host = document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`);
        expect(host?.getAttribute('data-preview-state')).toBe('ready');
    });

    it('removes overlay on hide', async () => {
        setupDOM('<body><main><h1>Hello</h1></main></body>');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);

        port.emitMessage({ type: 'preview:show', sessionId: 's1' });
        expect(document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`)).not.toBeNull();

        port.emitMessage({ type: 'preview:hide', sessionId: 's1' });
        expect(document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`)).toBeNull();
    });

    it('removes overlay on owner disconnect', async () => {
        setupDOM('<body><main><h1>Hello</h1></main></body>');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);

        port.emitMessage({ type: 'preview:show', sessionId: 's1' });
        expect(document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`)).not.toBeNull();

        port.emitDisconnect();
        expect(document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`)).toBeNull();
    });

    it('ignores stale port commands when newer generation owns overlay', async () => {
        setupDOM('<body><main><h1>Hello</h1></main></body>');
        await import('../src/content');

        const olderPort = createMockPort('markdownizer-capture-preview');
        connectListener?.(olderPort);
        olderPort.emitMessage({ type: 'preview:show', sessionId: 'older' });

        const newerPort = createMockPort('markdownizer-capture-preview');
        connectListener?.(newerPort);
        newerPort.emitMessage({ type: 'preview:show', sessionId: 'newer' });

        // Owner is now newerPort; older port disconnect should be ignored
        olderPort.emitDisconnect();

        // Overlay should still exist because newer owns it
        expect(document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`)).not.toBeNull();

        // Newer can still hide it
        newerPort.emitMessage({ type: 'preview:hide', sessionId: 'newer' });
        expect(document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`)).toBeNull();
    });

    it('ignores stale port commands to change state', async () => {
        setupDOM('<body><main><h1>Hello</h1></main></body>');
        await import('../src/content');

        const olderPort = createMockPort('markdownizer-capture-preview');
        connectListener?.(olderPort);
        olderPort.emitMessage({ type: 'preview:show', sessionId: 'older' });

        const newerPort = createMockPort('markdownizer-capture-preview');
        connectListener?.(newerPort);
        newerPort.emitMessage({ type: 'preview:show', sessionId: 'newer' });
        newerPort.emitMessage({ type: 'preview:ready', sessionId: 'newer' });

        // Owner is newer with ready state
        const host1 = document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`);
        expect(host1?.getAttribute('data-preview-state')).toBe('ready');

        // Older tries to set loading — should be ignored
        olderPort.emitMessage({ type: 'preview:loading', sessionId: 'older' });
        const host2 = document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`);
        expect(host2?.getAttribute('data-preview-state')).toBe('ready');
    });

    it('does not create overlay for non-preview port names', async () => {
        setupDOM('<body><main><h1>Hello</h1></main></body>');
        await import('../src/content');

        const port = createMockPort('some-other-port');
        connectListener?.(port);

        port.emitMessage({ type: 'preview:show', sessionId: 's1' });

        expect(document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`)).toBeNull();
    });

    it('responds with error when no source is available', async () => {
        setupDOM('<body></body>');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);

        const responsePromise = new Promise<unknown>((resolve) => {
            port.postMessage = vi.fn((msg: unknown) => resolve(msg));
            port.emitMessage({ type: 'preview:show', sessionId: 's1' });
        });

        const response = await responsePromise;
        expect(response).toEqual({ success: false, error: expect.any(String) });
        expect(document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`)).toBeNull();
    });

    it('responds with success to preview_ready on show', async () => {
        setupDOM('<body><main><h1>Hello</h1></main></body>');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);

        const responsePromise = new Promise<unknown>((resolve) => {
            port.postMessage = vi.fn((msg: unknown) => resolve(msg));
            port.emitMessage({ type: 'preview:show', sessionId: 's1' });
        });

        const response = await responsePromise;
        expect(response).toEqual({ success: true });
    });

    it('does not trigger convert_page on preview_ready', async () => {
        setupDOM('<body><main><h1>Hello</h1></main></body>');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);

        // This should not trigger convert_page
        const responsePromise = new Promise<unknown>((resolve) => {
            port.postMessage = vi.fn((msg: unknown) => resolve(msg));
            port.emitMessage({ type: 'preview:show', sessionId: 's1' });
        });

        const response = await responsePromise;
        expect(response).toEqual({ success: true });

        // chrome.runtime.sendMessage should NOT have been called for conversion
        expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    });
});
