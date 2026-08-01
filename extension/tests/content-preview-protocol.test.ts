// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
    CONTENT_PREVIEW_HOST_ATTRIBUTE,
    READY_HIGHLIGHT_NAME,
} from '../src/content-preview';

const { skeletonizeMock } = vi.hoisted(() => ({
    skeletonizeMock: vi.fn(),
}));

vi.mock('../src/logic', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/logic')>();
    return { ...actual, skeletonize: skeletonizeMock };
});

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
let messageListener: ((request: unknown, sender: unknown, sendResponse: (response: unknown) => void) => void) | undefined;

function createChromeMock() {
    return {
        runtime: {
            onInstalled: { addListener: vi.fn() },
            onMessage: {
                addListener: vi.fn((listener: (request: unknown, sender: unknown, sendResponse: (response: unknown) => void) => void) => {
                    messageListener = listener;
                })
            },
            onConnect: {
                addListener: vi.fn((listener: RuntimeConnectListener) => {
                    connectListener = listener;
                })
            },
            sendMessage: vi.fn(async () => {
                return { success: true, markdown_skeleton: '# Test' };
            }),
            getURL: vi.fn((path: string) => `chrome-extension://test/${path}`)
        }
    };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function setupDOM(html: string) {
    document.documentElement.innerHTML = html;
}

// ── Stubs for ContentPreview browser APIs in jsdom ────────────────────────────

const VISIBLE_RECT: DOMRect = { x: 10, y: 10, width: 200, height: 50, top: 10, right: 210, bottom: 60, left: 10 } as DOMRect;

function createRectList(rects: DOMRect[]): DOMRectList {
    const list = rects.slice();
    Object.defineProperty(list, 'length', { value: rects.length });
    return list as unknown as DOMRectList;
}

const EMPTY_RECT_LIST: DOMRectList = createRectList([]);

let origRangeGetClientRects: typeof Range.prototype.getClientRects | undefined;
let origElementGetClientRects: typeof Element.prototype.getClientRects | undefined;

function stubRangeClientRects(): void {
    origRangeGetClientRects = Range.prototype.getClientRects;
    Range.prototype.getClientRects = function () {
        const text = this.toString();
        if (text && text.trim().length > 0) {
            const parent = this.startContainer.nodeType === Node.TEXT_NODE
                ? this.startContainer.parentElement
                : this.startContainer as Element;
            if (parent) {
                if (parent.hasAttribute('hidden')) return EMPTY_RECT_LIST;
                const styleAttr = parent.getAttribute('style') || '';
                if (/width\s*:\s*0(?:px)?\b/.test(styleAttr) || /height\s*:\s*0(?:px)?\b/.test(styleAttr)) return EMPTY_RECT_LIST;
                const computed = window.getComputedStyle(parent);
                if (computed.display === 'none') return EMPTY_RECT_LIST;
                if (computed.visibility === 'hidden' || computed.visibility === 'collapse') return EMPTY_RECT_LIST;
                if (parseFloat(computed.opacity) === 0) return EMPTY_RECT_LIST;
            }
            return createRectList([VISIBLE_RECT]);
        }
        return EMPTY_RECT_LIST;
    };
}

function stubElementClientRects(visibleSelectors: string[]): void {
    origElementGetClientRects = Element.prototype.getClientRects;
    Element.prototype.getClientRects = function () {
        let hidden = this.hasAttribute('hidden');
        let current: Element | null = this.parentElement;
        while (!hidden && current && current !== document.documentElement) {
            if (current.hasAttribute('hidden')) { hidden = true; break; }
            const computed = window.getComputedStyle(current);
            if (computed.display === 'none') { hidden = true; break; }
            if (computed.visibility === 'hidden' || computed.visibility === 'collapse') { hidden = true; break; }
            if (parseFloat(computed.opacity) === 0) { hidden = true; break; }
            current = current.parentElement;
        }
        if (!hidden && visibleSelectors.some(sel => this.matches(sel))) {
            return createRectList([VISIBLE_RECT]);
        }
        return EMPTY_RECT_LIST;
    };
}

function stubGetComputedStyle(): void {
    window.getComputedStyle = function (elt) {
        const htmlElt = elt as HTMLElement;
        return {
            get display() {
                if (htmlElt.style.display === 'none') return 'none';
                const tag = htmlElt.tagName.toLowerCase();
                if (['div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'main', 'article', 'aside', 'nav', 'header', 'footer', 'blockquote', 'pre', 'ul', 'ol', 'li', 'table', 'form', 'fieldset', 'details', 'summary', 'img'].includes(tag)) {
                    return tag === 'img' ? 'inline' : 'block';
                }
                if (tag === 'span') return 'inline';
                if (tag === 'button') return 'inline-block';
                return 'inline';
            },
            get visibility() {
                if (htmlElt.hasAttribute('hidden')) return 'hidden';
                if (htmlElt.style.visibility === 'hidden') return 'hidden';
                if (htmlElt.style.visibility === 'collapse') return 'collapse';
                return 'visible';
            },
            get opacity() {
                if (htmlElt.style.opacity !== '') return htmlElt.style.opacity;
                return '1';
            },
            get content() {
                return 'none';
            },
        } as unknown as CSSStyleDeclaration;
    };
}

function restoreOriginals(): void {
    if (origRangeGetClientRects !== undefined) Range.prototype.getClientRects = origRangeGetClientRects;
    if (origElementGetClientRects !== undefined) Element.prototype.getClientRects = origElementGetClientRects;
    origRangeGetClientRects = undefined;
    origElementGetClientRects = undefined;
}

// CSS Custom Highlight API stubs
class StubHighlight {
    ranges: Range[];
    constructor(...args: Range[]) { this.ranges = args.flat(); }
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
        vi.stubGlobal('Highlight', StubHighlight);
        vi.stubGlobal('CSS', { highlights: new Map<string, StubHighlight>() });
        stubRangeClientRects();
        stubElementClientRects(['img']);
        stubGetComputedStyle();
        vi.resetModules();
        // @ts-expect-error – injecting global chrome for content script
        global.chrome = createChromeMock();
        skeletonizeMock.mockReset();
        skeletonizeMock.mockReturnValue({ html: '<p>Test</p>', tokens: [] });
        connectListener = undefined;
        messageListener = undefined;
    });

    afterEach(() => {
        restoreOriginals();
        Reflect.deleteProperty(globalThis, 'CSS');
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        // Clean up any preview host left in the DOM
        const host = document.querySelector(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`);
        if (host) host.remove();
    });

    it('creates overlay host on show and sets ready state', async () => {
        setupDOM('<body><main><h1>Hello</h1><img alt="diagram"></main></body>');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);

        port.emitMessage({ type: 'preview:show', sessionId: 's1' });

        const host = document.querySelector(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`);
        expect(host).not.toBeNull();
        expect(host?.getAttribute('data-preview-state')).toBe('ready');
    });

    it('transitions to ready state', async () => {
        setupDOM('<body><main><h1>Hello</h1><img alt="diagram"></main></body>');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);

        port.emitMessage({ type: 'preview:show', sessionId: 's1' });
        port.emitMessage({ type: 'preview:ready', sessionId: 's1' });

        const host = document.querySelector(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`);
        expect(host?.getAttribute('data-preview-state')).toBe('ready');
    });

    it('removes overlay on hide', async () => {
        setupDOM('<body><main><h1>Hello</h1><img alt="diagram"></main></body>');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);

        port.emitMessage({ type: 'preview:show', sessionId: 's1' });
        expect(document.querySelector(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`)).not.toBeNull();

        port.emitMessage({ type: 'preview:hide', sessionId: 's1' });
        expect(document.querySelector(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`)).toBeNull();
    });

    it('removes overlay on owner disconnect', async () => {
        setupDOM('<body><main><h1>Hello</h1><img alt="diagram"></main></body>');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);

        port.emitMessage({ type: 'preview:show', sessionId: 's1' });
        expect(document.querySelector(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`)).not.toBeNull();

        port.emitDisconnect();
        expect(document.querySelector(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`)).toBeNull();
    });

    it('ignores stale port commands when newer generation owns overlay', async () => {
        setupDOM('<body><main><h1>Hello</h1><img alt="diagram"></main></body>');
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
        expect(document.querySelector(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`)).not.toBeNull();

        // Newer can still hide it
        newerPort.emitMessage({ type: 'preview:hide', sessionId: 'newer' });
        expect(document.querySelector(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`)).toBeNull();
    });

    it('ignores stale port commands to change state', async () => {
        setupDOM('<body><main><h1>Hello</h1><img alt="diagram"></main></body>');
        await import('../src/content');

        const olderPort = createMockPort('markdownizer-capture-preview');
        connectListener?.(olderPort);
        olderPort.emitMessage({ type: 'preview:show', sessionId: 'older' });

        const newerPort = createMockPort('markdownizer-capture-preview');
        connectListener?.(newerPort);
        newerPort.emitMessage({ type: 'preview:show', sessionId: 'newer' });
        newerPort.emitMessage({ type: 'preview:ready', sessionId: 'newer' });

        // Owner is newer with ready state
        const host1 = document.querySelector(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`);
        expect(host1?.getAttribute('data-preview-state')).toBe('ready');

        // Older tries to set loading — should be ignored
        olderPort.emitMessage({ type: 'preview:loading', sessionId: 'older' });
        const host2 = document.querySelector(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`);
        expect(host2?.getAttribute('data-preview-state')).toBe('ready');
    });

    it('does not create overlay for non-preview port names', async () => {
        setupDOM('<body><main><h1>Hello</h1><img alt="diagram"></main></body>');
        await import('../src/content');

        const port = createMockPort('some-other-port');
        connectListener?.(port);

        port.emitMessage({ type: 'preview:show', sessionId: 's1' });

        expect(document.querySelector(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`)).toBeNull();
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
        expect(document.querySelector(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`)).toBeNull();
    });

    it('responds with success to preview_ready on show', async () => {
        setupDOM('<body><main><h1>Hello</h1><img alt="diagram"></main></body>');
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
        setupDOM('<body><main><h1>Hello</h1><img alt="diagram"></main></body>');
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

    it('responds to preview_ready action via onMessage', async () => {
        setupDOM('<body><main><h1>Hello</h1><img alt="diagram"></main></body>');
        await import('../src/content');

        // Verify the onMessage listener was registered
        expect(messageListener).toBeDefined();

        // Simulate a preview-ready message from the popup
        const sendResponse = vi.fn();
        const result = messageListener!(
            { action: 'preview_ready' },
            {},
            sendResponse
        );

        // Should return false (synchronous response)
        expect(result).toBe(false);
        // sendResponse should be called with success
        expect(sendResponse).toHaveBeenCalledWith({ success: true });
    });

    it('highlights visible body content for a full-page preview', async () => {
        setupDOM('<body><main>Smart only</main><aside>Outside main</aside></body>');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);
        port.emitMessage({ type: 'preview:show', sessionId: 'full', captureMode: 'full-page' });

        const ranges = (CSS.highlights as Map<string, StubHighlight>)
            .get(READY_HIGHLIGHT_NAME)?.ranges.map((range) => range.toString());
        expect(ranges).toContain('Smart only');
        expect(ranges).toContain('Outside main');
    });

    it('uses semantic content for a smart preview', async () => {
        setupDOM('<body><main>Smart only</main><aside>Outside main</aside></body>');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);
        port.emitMessage({ type: 'preview:show', sessionId: 'smart', captureMode: 'unexpected' });

        const ranges = (CSS.highlights as Map<string, StubHighlight>)
            .get(READY_HIGHLIGHT_NAME)?.ranges.map((range) => range.toString());
        expect(ranges).toContain('Smart only');
        expect(ranges).not.toContain('Outside main');
    });

    it('converts a full-page request using the visible-body strategy', async () => {
        setupDOM('<body><main>Smart only</main><aside>Outside main</aside></body>');
        await import('../src/content');

        const response = await new Promise<unknown>((resolve) => {
            messageListener!(
                { action: 'convert_page', captureMode: 'full-page' },
                {},
                resolve,
            );
        });

        expect(response).toEqual(expect.objectContaining({ success: true }));
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
            action: 'convert_skeleton',
            payload: expect.objectContaining({ extraction_strategy: 'visible-body' }),
        }));
    });

    it('passes captureMode full-page in the convert_page message', async () => {
        setupDOM('<body><main>Smart only</main><aside>Outside main</aside></body>');
        await import('../src/content');

        const sendRequest = new Promise<unknown>((resolve) => {
            messageListener!(
                { action: 'convert_page', captureMode: 'full-page' },
                {},
                resolve,
            );
        });

        const response = await sendRequest;
        expect(response).toEqual(expect.objectContaining({ success: true }));
    });

    it('converts a default request without captureMode using semantic strategy', async () => {
        setupDOM('<body><main>Smart only</main><aside>Outside main</aside></body>');
        await import('../src/content');

        const response = await new Promise<unknown>((resolve) => {
            messageListener!(
                { action: 'convert_page' },
                {},
                resolve,
            );
        });

        expect(response).toEqual(expect.objectContaining({ success: true }));
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
            action: 'convert_skeleton',
            payload: expect.objectContaining({ extraction_strategy: 'semantic-html' }),
        }));
    });

    it('rejects an oversized full-page conversion without Readability fallback', async () => {
        setupDOM('<body><main>Smart only</main><aside>Outside main</aside></body>');
        skeletonizeMock.mockReturnValue({ html: 'x'.repeat(1_048_577), tokens: [] });
        const extractor = await import('../src/extractor');
        const readabilitySpy = vi.spyOn(extractor, 'getReadabilityContent');
        await import('../src/content');

        const response = await new Promise<unknown>((resolve) => {
            messageListener!(
                { action: 'convert_page', captureMode: 'full-page' },
                {},
                resolve,
            );
        });

        expect(response).toEqual({
            success: false,
            error: 'The full page is too large to convert. Turn off Capture full page to use Smart selection.',
        });
        expect(readabilitySpy).not.toHaveBeenCalled();
    });

    it('does not invoke Readability for full-page even when skeleton is below size limit', async () => {
        setupDOM('<body><main>Small content</main><aside>Also small</aside></body>');
        skeletonizeMock.mockReturnValue({ html: '<p>Tiny</p>', tokens: [] });
        const extractor = await import('../src/extractor');
        const readabilitySpy = vi.spyOn(extractor, 'getReadabilityContent');
        await import('../src/content');

        const response = await new Promise<unknown>((resolve) => {
            messageListener!(
                { action: 'convert_page', captureMode: 'full-page' },
                {},
                resolve,
            );
        });

        expect(response).toEqual(expect.objectContaining({ success: true }));
        expect(readabilitySpy).not.toHaveBeenCalled();
    });
});
