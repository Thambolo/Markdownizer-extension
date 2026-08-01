import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { ContentPreview, CONTENT_PREVIEW_HOST_ATTRIBUTE } from '../src/content-preview';
import { getBestContent, getVisibleBodyContent } from '../src/extractor';
import { skeletonize } from '../src/logic';

// ── Stubs for ContentPreview browser APIs in JSDOM ───────────────────────────

const VISIBLE_RECT: DOMRect = { x: 10, y: 10, width: 200, height: 50, top: 10, right: 210, bottom: 60, left: 10 } as DOMRect;

function createRectList(rects: DOMRect[]): DOMRectList {
    const list = rects.slice();
    Object.defineProperty(list, 'length', { value: rects.length });
    return list as unknown as DOMRectList;
}

const EMPTY_RECT_LIST: DOMRectList = createRectList([]);

let origRangeGetClientRects: typeof Range.prototype.getClientRects | undefined;
let origElementGetClientRects: typeof Element.prototype.getClientRects | undefined;
let origGetComputedStyle: typeof window.getComputedStyle | undefined;

let origMO: typeof MutationObserver | undefined;
let origRO: typeof ResizeObserver | undefined;
let origRaf: typeof requestAnimationFrame | undefined;
let origCaf: typeof cancelAnimationFrame | undefined;

function stubContentPreviewAPIs(): void {
    const W = global.window as unknown as Window & typeof globalThis;
    origRangeGetClientRects = Range.prototype.getClientRects;
    origElementGetClientRects = Element.prototype.getClientRects;
    origGetComputedStyle = window.getComputedStyle;
    origMO = global.MutationObserver;
    origRO = global.ResizeObserver;
    origRaf = global.requestAnimationFrame;
    origCaf = global.cancelAnimationFrame;

    const JSDOMRange = W.Range;
    const JSDOMElement = W.Element;

    if (JSDOMRange) {
        JSDOMRange.prototype.getClientRects = function () {
            const text = this.toString();
            if (text && text.trim().length > 0) {
                return createRectList([VISIBLE_RECT]);
            }
            return EMPTY_RECT_LIST;
        };
    }

    if (JSDOMElement) {
        JSDOMElement.prototype.getClientRects = function () {
            return createRectList([VISIBLE_RECT]);
        };
    }

    window.getComputedStyle = function () {
        return {
            get display() { return 'block'; },
            get visibility() { return 'visible'; },
            get opacity() { return '1'; },
            get content() { return 'none'; },
        } as unknown as CSSStyleDeclaration;
    };

    // Stub MutationObserver and ResizeObserver for ContentPreview
    global.MutationObserver = class {
        observe() {}
        disconnect() {}
        takeRecords() { return []; }
    } as unknown as typeof MutationObserver;

    global.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;

    // Stub requestAnimationFrame/cancelAnimationFrame
    let rafId = 0;
    global.requestAnimationFrame = (cb: FrameRequestCallback) => {
        cb(performance.now());
        return ++rafId;
    };
    global.cancelAnimationFrame = () => {};
}

function restoreContentPreviewAPIs(): void {
    if (origRangeGetClientRects !== undefined) Range.prototype.getClientRects = origRangeGetClientRects;
    if (origElementGetClientRects !== undefined) Element.prototype.getClientRects = origElementGetClientRects;
    if (origGetComputedStyle !== undefined) window.getComputedStyle = origGetComputedStyle;
    if (origMO !== undefined) global.MutationObserver = origMO;
    if (origRO !== undefined) global.ResizeObserver = origRO;
    if (origRaf !== undefined) global.requestAnimationFrame = origRaf;
    if (origCaf !== undefined) global.cancelAnimationFrame = origCaf;
}

function setupDOM(html: string): void {
    const dom = new JSDOM(html, { url: 'https://example.test/', pretendToBeVisual: true });
    global.window = dom.window as unknown as Window & typeof globalThis;
    global.document = dom.window.document;
    global.NodeFilter = dom.window.NodeFilter;
    // @ts-expect-error - JSDOM global injection for browser-like extractor tests
    global.Node = dom.window.Node;
    // @ts-expect-error - JSDOM global injection for ContentPreview DOM stubs
    if (!global.Range) global.Range = dom.window.Range;
    // @ts-expect-error - JSDOM global injection for ContentPreview DOM stubs
    if (!global.Element) global.Element = dom.window.Element;
    // Expose JSDOM browser APIs as globals for ContentPreview tracking
    if (!global.MutationObserver) global.MutationObserver = dom.window.MutationObserver;
    if (!global.ResizeObserver) {
        global.ResizeObserver = dom.window.ResizeObserver ?? class {
            observe() {}
            unobserve() {}
            disconnect() {}
        } as unknown as typeof ResizeObserver;
    }
    if (!global.requestAnimationFrame) {
        global.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(cb, 0) as unknown as number;
    }
    if (!global.cancelAnimationFrame) {
        global.cancelAnimationFrame = (id: number) => clearTimeout(id);
    }
    // Stub chrome.runtime.getURL for ContentPreview
    if (!global.chrome) {
        global.chrome = {
            runtime: {
                getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
            },
        } as unknown as typeof chrome;
    }
}

describe('visible-body extraction', () => {
    it('uses a semantic main element before the visible body', () => {
        setupDOM('<body><header>Site nav</header><main><h1>Assignment</h1><p>Instructions</p></main></body>');
        const result = getBestContent();

        expect(result?.strategy).toBe('semantic-html');
        expect(result?.element.tagName).toBe('MAIN');
    });

    it('clones semantic content while preserving hidden authored nodes', () => {
        setupDOM('<body><main><p hidden>Hidden text</p><p style="visibility: hidden">Invisible text</p><dialog>Closed dialog</dialog><p aria-hidden="true">ARIA label</p><p inert>Inert label</p><nav>Section navigation</nav><script>secret()</script><style>.x { color: red; }</style><noscript>No JavaScript</noscript><template>Template text</template></main></body>');
        const source = document.querySelector('main') as HTMLElement;
        const result = getBestContent();

        expect(result?.element).not.toBe(source);
        expect(result?.element.textContent).toContain('Hidden text');
        expect(result?.element.textContent).toContain('Invisible text');
        expect(result?.element.textContent).toContain('Closed dialog');
        expect(result?.element.textContent).toContain('ARIA label');
        expect(result?.element.textContent).toContain('Inert label');
        expect(result?.element.textContent).toContain('Section navigation');
        expect(result?.element.querySelector('script, style, noscript, template')).toBeNull();
        expect(source.querySelector('script')).not.toBeNull();
    });

    it('uses visible body content when no semantic root exists', () => {
        setupDOM('<body><div class="wrap"><h1>Assignment 2</h1><p>Submit Friday.</p><pre>g = f + d - e</pre></div></body>');
        const result = getBestContent();

        expect(result?.strategy).toBe('visible-body');
        expect(result?.element.textContent).toContain('Assignment 2');
        expect(result?.element.textContent).toContain('Submit Friday.');
    });

    it('removes non-content nodes while preserving hidden authored body content', () => {
        setupDOM('<body><header>Course navigation</header><script>secret()</script><style>.x { color: red; }</style><noscript>No JavaScript</noscript><template>template text</template><p hidden>Hidden text</p><p style="visibility: hidden">Invisible text</p><dialog>Closed dialog</dialog><p>Visible instructions</p></body>');
        const result = getVisibleBodyContent();

        expect(result?.element.textContent).toContain('Course navigation');
        expect(result?.element.textContent).toContain('Visible instructions');
        expect(result?.element.textContent).toContain('Hidden text');
        expect(result?.element.textContent).toContain('Invisible text');
        expect(result?.element.textContent).toContain('Closed dialog');
        expect(result?.element.querySelector('script, style, noscript, template')).toBeNull();
    });

    it('returns the live semantic source used to create the extraction clone', () => {
        setupDOM('<body><main><h1>Assignment</h1><script>ignore()</script></main></body>');
        const source = document.querySelector('main') as HTMLElement;

        const result = getBestContent();

        expect(result?.sourceElement).toBe(source);
        expect(result?.element).not.toBe(source);
        expect(result?.element.tagName).toBe('MAIN');
        expect(result?.element.querySelector('script')).toBeNull();
    });

    it('returns the live body when no usable semantic root exists', () => {
        setupDOM('<body><article>   </article><div>Visible instructions</div></body>');

        const result = getBestContent();

        expect(result?.strategy).toBe('visible-body');
        expect(result?.sourceElement).toBe(document.body);
        expect(result?.element).not.toBe(document.body);
    });
});

describe('Preview contamination regression', () => {
    beforeEach(() => {
        // Set up JSDOM first so Range/Element are available globally
        setupDOM('<body><h1>Assignment</h1><p>Submit Friday.</p><img alt="diagram"></body>');
        stubContentPreviewAPIs();
    });

    afterEach(() => {
        restoreContentPreviewAPIs();
    });

    it('never leaks ContentPreview markup or host into extraction or skeleton', () => {

        // Show the preview overlay on document.body
        const preview = new ContentPreview();
        preview.show(document.body);

        // Extract content (should take the visible-body path)
        const extraction = getBestContent();
        expect(extraction).not.toBeNull();
        expect(extraction!.strategy).toBe('visible-body');

        // The extraction clone must not contain the preview host
        expect(extraction!.element.querySelector(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`)).toBeNull();

        // The extraction clone must not contain .content-preview-box
        expect(extraction!.element.querySelector('.content-preview-box')).toBeNull();

        // Skeletonize the extraction result
        const skeleton = skeletonize(extraction!.element);

        // Skeleton HTML must not contain any preview-related markup, marker, or color
        expect(skeleton.html).not.toContain('markdownizer-preview');
        expect(skeleton.html).not.toContain('content-preview-box');
        expect(skeleton.html).not.toContain('rgb(16, 185, 129)');
        expect(skeleton.html).not.toContain(CONTENT_PREVIEW_HOST_ATTRIBUTE);

        // Token values must not contain the word 'Preview' or preview UI text
        const allTokenValues = Object.values(skeleton.tokens).join(' ');
        expect(allTokenValues).not.toContain('Preview');

        // Clean up
        preview.remove();
    });
});
