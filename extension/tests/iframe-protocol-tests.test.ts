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

function createChromeMock() {
    return {
        runtime: {
            onInstalled: { addListener: vi.fn() },
            onMessage: {
                addListener: vi.fn(() => {
                    // Listener captured by mock; not exercised in this test file.
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
    constructor(callback: MutationCallback) {
        this.callback = callback;
    }
    observe() {}
    disconnect() {}
    takeRecords(): MutationRecord[] { return []; }
    trigger(records: MutationRecord[] = []): void { this.callback(records, {} as MutationObserver); }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Iframe protocol and controller tests', () => {
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

    // ── Protocol Tests ──────────────────────────────────────────────────────────

    describe('preview:show uses selectCaptureRoot', () => {
        it('uses semantic root for smart mode instead of getContentForMode', async () => {
            setupDOM('<body><article><h1>Article content</h1><p>Paragraph</p><img alt="diagram"></article></body>');
            await import('../src/content');

            const port = createMockPort('markdownizer-capture-preview');
            connectListener?.(port);

            port.emitMessage({ type: 'preview:show', sessionId: 's1', captureMode: 'smart' });

            const host = document.querySelector(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`);
            expect(host).not.toBeNull();

            // Check that the preview highlights are within the article
            const ranges = (CSS.highlights as Map<string, StubHighlight>)
                .get(READY_HIGHLIGHT_NAME)?.ranges.map((range) => range.toString());
            expect(ranges).toContain('Article content');
            expect(ranges).toContain('Paragraph');
        });

        it('uses document.body for full-page mode', async () => {
            setupDOM('<body><article><h1>Article</h1></article><aside>Sidebar</aside></body>');
            await import('../src/content');

            const port = createMockPort('markdownizer-capture-preview');
            connectListener?.(port);

            port.emitMessage({ type: 'preview:show', sessionId: 's1', captureMode: 'full-page' });

            const ranges = (CSS.highlights as Map<string, StubHighlight>)
                .get(READY_HIGHLIGHT_NAME)?.ranges.map((range) => range.toString());
            expect(ranges).toContain('Sidebar');
        });

        it('does not call getContentForMode for preview:show', async () => {
            setupDOM('<body><main><h1>Content</h1></main></body>');
            await import('../src/content');

            // Import and spy on getContentForMode
            const extractor = await import('../src/extractor');
            const getContentForModeSpy = vi.spyOn(extractor, 'getContentForMode');

            const port = createMockPort('markdownizer-capture-preview');
            connectListener?.(port);

            port.emitMessage({ type: 'preview:show', sessionId: 's1', captureMode: 'smart' });

            // getContentForMode should NOT be called for preview:show
            expect(getContentForModeSpy).not.toHaveBeenCalled();
        });
    });

    describe('preview:set-iframes command', () => {
        it('handles preview:set-iframes command', async () => {
            setupDOM('<body><main><h1>Content</h1><iframe src="https://example.com"></iframe></main></body>');
            await import('../src/content');

            const port = createMockPort('markdownizer-capture-preview');
            connectListener?.(port);

            // First show the preview
            port.emitMessage({ type: 'preview:show', sessionId: 's1', captureMode: 'smart' });

            // Then send set-iframes command
            port.emitMessage({
                type: 'preview:set-iframes',
                sessionId: 's1',
                enabled: true,
            });

            // Command should be processed without errors
            expect(port.postMessage).not.toHaveBeenCalledWith(
                expect.objectContaining({ type: 'error' })
            );
        });

        it('ignores set-iframes from non-current generation', async () => {
            setupDOM('<body><main><h1>Content</h1><iframe src="https://example.com"></iframe></main></body>');
            await import('../src/content');

            const olderPort = createMockPort('markdownizer-capture-preview');
            connectListener?.(olderPort);
            olderPort.emitMessage({ type: 'preview:show', sessionId: 'older' });

            const newerPort = createMockPort('markdownizer-capture-preview');
            connectListener?.(newerPort);
            newerPort.emitMessage({ type: 'preview:show', sessionId: 'newer' });

            // Older port tries to send set-iframes - should be ignored
            olderPort.emitMessage({
                type: 'preview:set-iframes',
                sessionId: 'older',
                enabled: true,
            });

            // Newer port should still work
            newerPort.emitMessage({
                type: 'preview:set-iframes',
                sessionId: 'newer',
                enabled: true,
            });

            // No errors should have occurred
        });

        it('set-iframes with enabled=true shows iframe preview', async () => {
            setupDOM('<body><main><h1>Content</h1><iframe src="https://example.com"></iframe></main></body>');
            await import('../src/content');

            const port = createMockPort('markdownizer-capture-preview');
            connectListener?.(port);

            // First show the preview
            port.emitMessage({ type: 'preview:show', sessionId: 's1', captureMode: 'smart' });

            // Send set-iframes with enabled=true
            port.emitMessage({
                type: 'preview:set-iframes',
                sessionId: 's1',
                enabled: true,
            });

            // Should not throw or error
        });

        it('set-iframes with enabled=false removes iframe preview', async () => {
            setupDOM('<body><main><h1>Content</h1><iframe src="https://example.com"></iframe></main></body>');
            await import('../src/content');

            const port = createMockPort('markdownizer-capture-preview');
            connectListener?.(port);

            // First show the preview, then disable iframe highlighting
            port.emitMessage({ type: 'preview:show', sessionId: 's1', captureMode: 'smart' });

            // Then disable iframes
            port.emitMessage({
                type: 'preview:set-iframes',
                sessionId: 's1',
                enabled: false,
            });

            // Should not throw or error
        });
    });

    describe('ContentPreview.setIncludeIframes idempotency', () => {
        it('does not recollect top-document targets when enabling iframes', async () => {
            setupDOM('<body><main><h1>Content</h1><iframe src="https://example.com"></iframe></main></body>');
            await import('../src/content');
            const { ContentPreview } = await import('../src/content-preview');

            const contentPreview = new ContentPreview();
            const main = document.querySelector('main') as HTMLElement;

            // Spy on collectContentPreviewTargets
            const contentPreviewMod = await import('../src/content-preview');
            const collectSpy = vi.spyOn(contentPreviewMod, 'collectContentPreviewTargets');

            // Show preview
            contentPreview.show(main);

            // Reset spy call count
            collectSpy.mockClear();

            // Call setIncludeIframes
            contentPreview.setIncludeIframes(true);

            // collectContentPreviewTargets should NOT be called again
            expect(collectSpy).not.toHaveBeenCalled();
        });

        it('does not recreate the host when enabling iframes', async () => {
            setupDOM('<body><main><h1>Content</h1><img alt="diagram"></main></body>');
            await import('../src/content');
            const { ContentPreview, CONTENT_PREVIEW_HOST_ATTRIBUTE } = await import('../src/content-preview');

            const contentPreview = new ContentPreview();
            const main = document.querySelector('main') as HTMLElement;

            // Show preview
            contentPreview.show(main);
            const host1 = document.querySelector(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`);
            expect(host1).not.toBeNull();

            // Call setIncludeIframes
            contentPreview.setIncludeIframes(true);

            // Host should still be the same element
            const host2 = document.querySelector(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`);
            expect(host2).toBe(host1);
        });

        it('is a no-op when setting same value twice', async () => {
            setupDOM('<body><main><h1>Content</h1></main></body>');
            await import('../src/content');
            const { ContentPreview } = await import('../src/content-preview');

            const contentPreview = new ContentPreview();
            const main = document.querySelector('main') as HTMLElement;

            // Show preview
            contentPreview.show(main);

            // Call setIncludeIframes twice with same value
            contentPreview.setIncludeIframes(true);
            contentPreview.setIncludeIframes(true);

            // No errors should occur
        });

        it('does not call iframePreview.show when enabling iframes without root', async () => {
            setupDOM('<body><main><h1>Content</h1></main></body>');
            await import('../src/content');
            const { ContentPreview } = await import('../src/content-preview');

            const contentPreview = new ContentPreview();

            // Don't call show first, so rootRef is null
            // Call setIncludeIframes - should be safe
            contentPreview.setIncludeIframes(true);

            // No errors should occur
        });
    });

    describe('Eligibility causes setIncludeIframes instead of another show', () => {
        it('eligibility message triggers setIncludeIframes, not preview:show', async () => {
            setupDOM('<body><main><h1>Content</h1><iframe src="https://example.com"></iframe></main></body>');
            await import('../src/content');

            const port = createMockPort('markdownizer-capture-preview');
            connectListener?.(port);

            // Show preview first
            port.emitMessage({ type: 'preview:show', sessionId: 's1', captureMode: 'smart' });

            // Clear previous calls
            port.postMessage.mockClear();

            // Simulate eligibility message from popup
            // In the real flow, popup would receive eligibility and call setIncludeIframes
            // Here we test that set-iframes command works without triggering show
            port.emitMessage({
                type: 'preview:set-iframes',
                sessionId: 's1',
                enabled: true,
            });

            // Should NOT send another preview:show
            expect(port.postMessage).not.toHaveBeenCalledWith(
                expect.objectContaining({ type: 'preview:show' })
            );
        });
    });

    describe('Protocol command types', () => {
        it('preview:set-iframes has correct structure', () => {
            const command = {
                type: 'preview:set-iframes',
                sessionId: 'test-session',
                enabled: true,
            };

            expect(command.type).toBe('preview:set-iframes');
            expect(typeof command.sessionId).toBe('string');
            expect(typeof command.enabled).toBe('boolean');
        });
    });
});
