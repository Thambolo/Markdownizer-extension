// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
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

let lastMutationObserver: StubMutationObserver | undefined;

class StubMutationObserver {
    callback: MutationCallback;
    constructor(callback: MutationCallback) {
        this.callback = callback;
        // The test harness needs access to the latest observer to trigger mutations.
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        lastMutationObserver = this;
    }
    observe() {}
    disconnect() {}
    takeRecords(): MutationRecord[] { return []; }
    trigger(records: MutationRecord[] = []): void { this.callback(records, {} as MutationObserver); }
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
        lastMutationObserver = undefined;
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

    it('succeeds with empty body (selectCaptureRoot falls back to body)', async () => {
        setupDOM('<body></body>');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);

        const responsePromise = new Promise<unknown>((resolve) => {
            port.postMessage = vi.fn((msg: unknown) => resolve(msg));
            port.emitMessage({ type: 'preview:show', sessionId: 's1' });
        });

        const response = await responsePromise;
        // selectCaptureRoot falls back to document.body, so this succeeds
        // but there is no boxed content, so no host overlay is created
        expect(response).toEqual({ success: true });
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

    it('reports iframe eligibility for the requested capture root and generation', async () => {
        setupDOM('<body><main><h1>Smart only</h1></main><aside>Outside main</aside></body>');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);
        port.emitMessage({ type: 'preview:inspect', sessionId: 'inspect-1', captureMode: 'smart', generation: 7 });

        expect(port.postMessage).toHaveBeenCalledWith({
            type: 'preview:eligibility',
            sessionId: 'inspect-1',
            captureMode: 'smart',
            generation: 7,
            hasEligibleIframes: false,
            hasImages: false,
        });
    });

    it('refreshes iframe eligibility when the selected root changes', async () => {
        setupDOM('<body><main><p>Main content</p></main><aside></aside></body>');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);
        port.emitMessage({ type: 'preview:inspect', sessionId: 'live-1', captureMode: 'smart', generation: 3 });
        expect(lastMutationObserver).toBeDefined();
        port.postMessage.mockClear();

        const iframe = document.createElement('iframe');
        const frameDocument = new JSDOM('<body><p>Embedded content</p></body>', {
            url: 'https://frame.example.test/content',
        }).window.document;
        Object.defineProperty(iframe, 'contentDocument', { configurable: true, get: () => frameDocument });
        document.querySelector('main')!.appendChild(iframe);
        lastMutationObserver?.trigger([{ type: 'childList', target: document.querySelector('main')! } as MutationRecord]);

        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(port.postMessage).toHaveBeenCalledWith({
            type: 'preview:eligibility',
            sessionId: 'live-1',
            captureMode: 'smart',
            generation: 3,
            hasEligibleIframes: true,
            hasImages: false,
        });
    });

    it('reports iframe images only when the inspect includes includeIframes', async () => {
        setupDOM('<body><main><h1>Smart only</h1><iframe></iframe></main></body>');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);

        const iframe = document.querySelector('iframe') as HTMLIFrameElement;
        const frameDoc = iframe.contentDocument!;
        frameDoc.write('<img src="https://example.com/frame.png">');
        frameDoc.close();

        // Without includeIframes the frame image must not count — it never
        // reaches the Markdown, so the images toggle must stay hidden.
        port.emitMessage({ type: 'preview:inspect', sessionId: 'img-off', captureMode: 'smart', generation: 1 });
        expect(port.postMessage).toHaveBeenCalledWith({
            type: 'preview:eligibility',
            sessionId: 'img-off',
            captureMode: 'smart',
            generation: 1,
            hasEligibleIframes: false,
            hasImages: false,
        });

        port.postMessage.mockClear();
        // With includeIframes the same frame image counts.
        port.emitMessage({
            type: 'preview:inspect',
            sessionId: 'img-on',
            captureMode: 'smart',
            generation: 2,
            includeIframes: true,
        });
        expect(port.postMessage).toHaveBeenCalledWith({
            type: 'preview:eligibility',
            sessionId: 'img-on',
            captureMode: 'smart',
            generation: 2,
            hasEligibleIframes: false,
            hasImages: true,
        });
    });

    it('refreshes eligibility when a loaded same-origin iframe document mutates', async () => {
        setupDOM('<body><main><h1>Smart only</h1><iframe></iframe></main></body>');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);

        // A loaded same-origin frame whose document contains a lazy img with
        // no src yet.
        const iframe = document.querySelector('iframe') as HTMLIFrameElement;
        const frameDoc = iframe.contentDocument!;
        frameDoc.write('<img id="later" src="">');
        frameDoc.close();

        port.emitMessage({
            type: 'preview:inspect',
            sessionId: 'frame-mut',
            captureMode: 'smart',
            generation: 1,
            includeIframes: true,
        });
        // Initial eligibility: the frame img has no src, so no images.
        expect(port.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'preview:eligibility',
                sessionId: 'frame-mut',
                hasImages: false,
            }),
        );
        port.postMessage.mockClear();

        // Mutate inside the frame document: the img gains a src. The root
        // observer cannot see this (separate DOM tree), so a frame-document
        // observer must schedule the refresh.
        const frameImg = frameDoc.getElementById('later') as HTMLImageElement;
        frameImg.setAttribute('src', 'https://example.com/later.png');
        lastMutationObserver?.trigger([{
            type: 'attributes',
            target: frameImg,
            attributeName: 'src',
        } as unknown as MutationRecord]);

        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(port.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'preview:eligibility',
                sessionId: 'frame-mut',
                hasImages: true,
            }),
        );
    });

    it('ignores mutations outside the current Smart root', async () => {
        setupDOM('<body><main><p>Main content</p></main><aside></aside></body>');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);
        port.emitMessage({ type: 'preview:inspect', sessionId: 'live-2', captureMode: 'smart', generation: 4 });
        port.postMessage.mockClear();

        const aside = document.querySelector('aside')!;
        aside.appendChild(document.createElement('iframe'));
        lastMutationObserver?.trigger([{ type: 'childList', target: aside } as MutationRecord]);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(port.postMessage).not.toHaveBeenCalled();
    });

    it('stops eligibility refreshes after the capture session disconnects', async () => {
        setupDOM('<body><main><p>Main content</p></main></body>');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);
        port.emitMessage({ type: 'preview:inspect', sessionId: 'live-3', captureMode: 'smart', generation: 5 });
        port.postMessage.mockClear();
        port.emitDisconnect();
        lastMutationObserver?.trigger([{ type: 'childList', target: document.querySelector('main')! } as MutationRecord]);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(port.postMessage).not.toHaveBeenCalled();
    });

    it('accepts iframe inclusion only as an explicit boolean protocol value', async () => {
        setupDOM('<body><main><h1>Smart only</h1></main></body>');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);
        port.emitMessage({
            type: 'preview:show',
            sessionId: 'invalid-include',
            captureMode: 'smart',
            includeIframes: 'true' as unknown as boolean,
        });

        expect(port.postMessage).toHaveBeenCalledWith({ success: true });
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

    it.each([
        ['smart', 'smart'],
        ['full-page', 'full-page'],
    ] as const)('rejects oversized capture with included iframe content in %s mode', async (mode) => {
        setupDOM('<body><main>Page content</main></body>');
        skeletonizeMock.mockReturnValue({ html: 'x'.repeat(1_048_577), tokens: [] });
        const extractor = await import('../src/extractor');
        const readabilitySpy = vi.spyOn(extractor, 'getReadabilityContent');
        await import('../src/content');

        const response = await new Promise<unknown>((resolve) => {
            messageListener!(
                { action: 'convert_page', captureMode: mode, includeIframes: true },
                {},
                resolve,
            );
        });

        expect(response).toEqual({
            success: false,
            error: 'The page and included iframe content are too large to convert. Turn off Include iframes and try again.',
        });
        expect(readabilitySpy).not.toHaveBeenCalled();
        expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'convert_skeleton' }));
    });

    // ── Task 4: Stabilization tests ─────────────────────────────────────────

    it('preview:inspect does not call getContentForMode (lightweight eligibility)', async () => {
        setupDOM('<body><main><h1>Smart only</h1></main></body>');
        const extractor = await import('../src/extractor');
        const getContentForModeSpy = vi.spyOn(extractor, 'getContentForMode');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);

        getContentForModeSpy.mockClear();
        port.emitMessage({
            type: 'preview:inspect',
            sessionId: 'inspect-lightweight',
            captureMode: 'smart',
            generation: 1,
        });

        // postEligibility must NOT call getContentForMode
        expect(getContentForModeSpy).not.toHaveBeenCalled();
        // But we should still get an eligibility response
        expect(port.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'preview:eligibility',
                sessionId: 'inspect-lightweight',
            }),
        );
    });

    it('full-page observer does not unconditionally refresh on non-iframe mutations', async () => {
        setupDOM('<body><main><p>Main content</p></main></body>');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);
        port.emitMessage({ type: 'preview:inspect', sessionId: 'fp-1', captureMode: 'full-page', generation: 1 });
        expect(lastMutationObserver).toBeDefined();
        port.postMessage.mockClear();

        // Trigger a non-iframe mutation (text change inside main)
        const p = document.querySelector('main p')!;
        p.textContent = 'Updated content';
        lastMutationObserver?.trigger([{
            type: 'characterData',
            target: p.firstChild!,
        } as MutationRecord]);

        await new Promise((resolve) => setTimeout(resolve, 50));
        // Should NOT have posted eligibility for a non-iframe mutation
        expect(port.postMessage).not.toHaveBeenCalled();
    });

    it('full-page observer does refresh when an iframe is added', async () => {
        setupDOM('<body><main><p>Main content</p></main></body>');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);
        port.emitMessage({ type: 'preview:inspect', sessionId: 'fp-2', captureMode: 'full-page', generation: 1 });
        expect(lastMutationObserver).toBeDefined();
        port.postMessage.mockClear();

        const iframe = document.createElement('iframe');
        document.querySelector('main')!.appendChild(iframe);
        lastMutationObserver?.trigger([{
            type: 'childList',
            target: document.querySelector('main')!,
            addedNodes: [iframe],
        } as unknown as MutationRecord]);

        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(port.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'preview:eligibility',
                sessionId: 'fp-2',
            }),
        );
    });

    it('stale generation inspect commands are ignored when a newer generation is active', async () => {
        setupDOM('<body><main><h1>Content</h1></main></body>');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);

        // Start with generation 10
        port.emitMessage({ type: 'preview:inspect', sessionId: 'gen-10', captureMode: 'smart', generation: 10 });
        expect(port.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ generation: 10 }),
        );
        port.postMessage.mockClear();

        // Now send a stale generation 5 inspect — should be ignored
        port.emitMessage({ type: 'preview:inspect', sessionId: 'gen-5-stale', captureMode: 'smart', generation: 5 });

        // No eligibility message should be posted for the stale generation
        const callsForGen5 = port.postMessage.mock.calls.filter(
            (call: unknown[]) => call[0] && typeof call[0] === 'object' && 'generation' in (call[0] as Record<string, unknown>) && (call[0] as Record<string, unknown>).generation === 5,
        );
        expect(callsForGen5).toHaveLength(0);
    });

    it('preview host mutations do not trigger eligibility refresh', async () => {
        setupDOM('<body><main><p>Main content</p></main></body>');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);

        // Show preview first to create the host
        port.emitMessage({ type: 'preview:show', sessionId: 'host-mut', captureMode: 'smart' });
        port.emitMessage({ type: 'preview:inspect', sessionId: 'host-mut', captureMode: 'smart', generation: 1 });
        port.postMessage.mockClear();

        // Mutate the preview host (e.g., attribute change)
        const host = document.querySelector(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`);
        if (host) {
            host.setAttribute('data-preview-state', 'loading');
            lastMutationObserver?.trigger([{
                type: 'attributes',
                target: host,
                attributeName: 'data-preview-state',
            } as unknown as MutationRecord]);
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
        // Should NOT have posted eligibility for a preview-host mutation
        expect(port.postMessage).not.toHaveBeenCalled();
    });

    it('mutation observer is scoped to the capture root, not the full document', async () => {
        setupDOM('<body><aside id="outside">Outside</aside><main><p>Main content</p></main></body>');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);
        port.emitMessage({ type: 'preview:inspect', sessionId: 'scope-1', captureMode: 'smart', generation: 1 });

        // Verify observer was created
        expect(lastMutationObserver).toBeDefined();

        // The observe() call should target the main element, not document.documentElement
        // We can't directly inspect the observe target, but we can verify that
        // mutations outside the root don't trigger refresh
        port.postMessage.mockClear();

        // Mutation in aside (outside the smart root)
        const aside = document.getElementById('outside')!;
        aside.appendChild(document.createElement('span'));
        lastMutationObserver?.trigger([{
            type: 'childList',
            target: aside,
        } as MutationRecord]);

        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(port.postMessage).not.toHaveBeenCalled();
    });

    it('disconnect cleans up the mutation observer', async () => {
        setupDOM('<body><main><p>Main content</p></main></body>');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);
        port.emitMessage({ type: 'preview:inspect', sessionId: 'cleanup-1', captureMode: 'smart', generation: 1 });
        expect(lastMutationObserver).toBeDefined();

        const disconnectSpy = vi.spyOn(lastMutationObserver!, 'disconnect');

        port.emitDisconnect();
        expect(disconnectSpy).toHaveBeenCalled();
    });

    // ── Task 6: Performance-contract tests ──────────────────────────────────

    it('popup startup sends exactly one show and one inspect', async () => {
        setupDOM('<body><main><h1>Hello</h1><img alt="diagram"></main></body>');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);

        // Simulate popup startup: show then inspect
        port.emitMessage({ type: 'preview:show', sessionId: 'startup', captureMode: 'smart' });
        port.emitMessage({ type: 'preview:inspect', sessionId: 'startup', captureMode: 'smart', generation: 1 });

        // Show produces exactly one overlay host
        const hosts = document.querySelectorAll(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`);
        expect(hosts).toHaveLength(1);

        // Inspect produces exactly one eligibility response
        const eligibilityCalls = port.postMessage.mock.calls.filter(
            (call: unknown[]) => call[0] && typeof call[0] === 'object' && 'type' in (call[0] as Record<string, unknown>) && (call[0] as Record<string, unknown>).type === 'preview:eligibility',
        );
        expect(eligibilityCalls).toHaveLength(1);
    });

    it('preview show and inspect call zero conversion-grade extraction functions', async () => {
        setupDOM('<body><main><h1>Hello</h1><img alt="diagram"></main></body>');
        const extractor = await import('../src/extractor');
        const logic = await import('../src/logic');
        const getContentForModeSpy = vi.spyOn(extractor, 'getContentForMode');
        const getReadabilityContentSpy = vi.spyOn(extractor, 'getReadabilityContent');
        const skeletonizeSpy = vi.spyOn(logic, 'skeletonize');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);

        getContentForModeSpy.mockClear();
        getReadabilityContentSpy.mockClear();
        skeletonizeSpy.mockClear();

        // Show preview
        port.emitMessage({ type: 'preview:show', sessionId: 'perf-1', captureMode: 'smart' });

        // Inspect preview
        port.emitMessage({ type: 'preview:inspect', sessionId: 'perf-1', captureMode: 'smart', generation: 1 });

        // None of the conversion-grade extraction functions should be called
        expect(getContentForModeSpy).not.toHaveBeenCalled();
        expect(getReadabilityContentSpy).not.toHaveBeenCalled();
        expect(skeletonizeSpy).not.toHaveBeenCalled();
    });

    it('eligibility mutations do not call getContentForMode', async () => {
        setupDOM('<body><main><p>Main content</p></main></body>');
        const extractor = await import('../src/extractor');
        const getContentForModeSpy = vi.spyOn(extractor, 'getContentForMode');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);

        // Start inspecting
        port.emitMessage({ type: 'preview:inspect', sessionId: 'elig-1', captureMode: 'smart', generation: 1 });
        getContentForModeSpy.mockClear();

        // Add an iframe to trigger eligibility refresh
        const iframe = document.createElement('iframe');
        document.querySelector('main')!.appendChild(iframe);
        lastMutationObserver?.trigger([{ type: 'childList', target: document.querySelector('main')! } as MutationRecord]);

        await new Promise((resolve) => setTimeout(resolve, 50));

        // Eligibility refresh must NOT call getContentForMode
        expect(getContentForModeSpy).not.toHaveBeenCalled();
        // But eligibility should be posted
        expect(port.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'preview:eligibility',
                sessionId: 'elig-1',
            }),
        );
    });

    it('toggling iframe inclusion sends no top-level show', async () => {
        setupDOM('<body><main><h1>Hello</h1><img alt="diagram"></main></body>');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);

        // Initial show
        port.emitMessage({ type: 'preview:show', sessionId: 'toggle-1', captureMode: 'smart' });
        port.postMessage.mockClear();

        // Toggle iframe inclusion on and off
        port.emitMessage({ type: 'preview:set-iframes', sessionId: 'toggle-1', enabled: true });
        port.emitMessage({ type: 'preview:set-iframes', sessionId: 'toggle-1', enabled: false });

        // No show messages should be sent for set-iframes toggles
        const showCalls = port.postMessage.mock.calls.filter(
            (call: unknown[]) => call[0] && typeof call[0] === 'object' && 'type' in (call[0] as Record<string, unknown>) && (call[0] as Record<string, unknown>).type === 'preview:show',
        );
        expect(showCalls).toHaveLength(0);
    });

    it('unrelated parent resource loads do not rebuild frame contexts', async () => {
        setupDOM('<body><main><iframe title="Frame1" srcdoc="<p>Frame1 text</p>"></iframe></body>');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);

        // Start inspecting
        port.emitMessage({ type: 'preview:inspect', sessionId: 'unrel-1', captureMode: 'smart', generation: 1 });
        port.postMessage.mockClear();

        // Simulate an unrelated parent resource load event
        const loadEvent = new Event('load', { bubbles: false });
        document.dispatchEvent(loadEvent);

        await new Promise((resolve) => setTimeout(resolve, 50));

        // No eligibility refresh should be triggered for unrelated loads
        expect(port.postMessage).not.toHaveBeenCalled();
    });

    it('a single frame mutation rebuilds one context', async () => {
        setupDOM('<body><main><p>Main content</p></main></body>');
        await import('../src/content');

        const port = createMockPort('markdownizer-capture-preview');
        connectListener?.(port);

        // Start inspecting
        port.emitMessage({ type: 'preview:inspect', sessionId: 'single-1', captureMode: 'smart', generation: 1 });
        port.postMessage.mockClear();

        // Add a new iframe with a mocked contentDocument containing text
        const iframe = document.createElement('iframe');
        const frameDocument = new JSDOM('<body><p>Frame content</p></body>', {
            url: 'https://frame.example.test/content',
        }).window.document;
        Object.defineProperty(iframe, 'contentDocument', { configurable: true, get: () => frameDocument });
        document.querySelector('main')!.appendChild(iframe);
        lastMutationObserver?.trigger([{ type: 'childList', target: document.querySelector('main')! } as MutationRecord]);

        await new Promise((resolve) => setTimeout(resolve, 50));

        // Exactly one eligibility message should be posted for the single mutation
        const eligibilityCalls = port.postMessage.mock.calls.filter(
            (call: unknown[]) => call[0] && typeof call[0] === 'object' && 'type' in (call[0] as Record<string, unknown>) && (call[0] as Record<string, unknown>).type === 'preview:eligibility',
        );
        expect(eligibilityCalls).toHaveLength(1);
        expect(eligibilityCalls[0][0]).toEqual(
            expect.objectContaining({
                type: 'preview:eligibility',
                sessionId: 'single-1',
                hasEligibleIframes: true,
                hasImages: false,
            }),
        );
    });
});
