import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { ContentPreview, CONTENT_PREVIEW_HOST_ATTRIBUTE } from '../src/content-preview';
import { getBestContent, getVisibleBodyContent, getContentForMode, hasEligibleIframesByExtraction, selectCaptureRoot } from '../src/extractor';
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
    it('leaves iframe elements unchanged when iframe inclusion is disabled', () => {
        setupDOM('<body><p>Before</p><iframe title="Widget"></iframe><p>After</p></body>');

        const result = getVisibleBodyContent(document.body, { includeIframes: false });

        expect(result?.element.querySelector('iframe')).not.toBeNull();
        expect(result?.element.textContent).toContain('Before');
        expect(result?.element.textContent).toContain('After');
    });

    it('replaces a readable iframe with labeled content at its original position', () => {
        setupDOM('<body><p>Before</p><iframe title="Widget"></iframe><p>After</p></body>');
        const iframe = document.querySelector('iframe') as HTMLIFrameElement;
        const frameDocument = new JSDOM('<body><h2>Embedded heading</h2><p>Embedded body</p></body>', {
            url: 'https://frame.example.test/widget',
        }).window.document;
        Object.defineProperty(iframe, 'contentDocument', { configurable: true, get: () => frameDocument });

        const result = getVisibleBodyContent(document.body, { includeIframes: true });
        const sections = result?.element.querySelectorAll('section');

        expect(sections).toHaveLength(1);
        expect(result?.element.textContent).toContain('Before');
        expect(result?.element.textContent).toContain('Embedded heading');
        expect(result?.element.textContent).toContain('Embedded body');
        expect(result?.element.textContent).toContain('After');
        expect(result?.element.querySelector('iframe')).toBeNull();
        expect(result?.element.innerHTML.indexOf('Before')).toBeLessThan(result?.element.innerHTML.indexOf('Embedded heading'));
        expect(result?.element.innerHTML.indexOf('Embedded heading')).toBeLessThan(result?.element.innerHTML.indexOf('After'));
    });

    it('preserves live form-control values inside included iframe documents', () => {
        setupDOM('<body><p>Before</p><iframe title="Widget"></iframe><p>After</p></body>');
        const iframe = document.querySelector('iframe') as HTMLIFrameElement;
        const frameDocument = new JSDOM(
            '<body><p>Embedded editor</p><textarea></textarea><input value="initial"></body>',
            { url: 'https://frame.example.test/widget' },
        ).window.document;
        const editor = frameDocument.querySelector('textarea') as HTMLTextAreaElement;
        editor.value = 'def answer():\n    return 42';
        const input = frameDocument.querySelector('input') as HTMLInputElement;
        input.value = 'live iframe value';
        Object.defineProperty(iframe, 'contentDocument', { configurable: true, get: () => frameDocument });

        const result = getVisibleBodyContent(document.body, { includeIframes: true });
        const frameText = result?.element.querySelector('section')?.textContent ?? '';

        expect(frameText).toContain('value: "def answer():\\n    return 42"');
        expect(frameText).toContain('value: "live iframe value"');
    });

    it('reports an eligible iframe only when sanitized frame content is non-empty', () => {
        setupDOM('<body><iframe id="empty"></iframe><iframe id="content"></iframe></body>');
        const emptyFrame = document.querySelector('#empty') as HTMLIFrameElement;
        const contentFrame = document.querySelector('#content') as HTMLIFrameElement;
        const emptyDocument = new JSDOM('<body><script>ignore()</script></body>', {
            url: 'https://frame.example.test/empty',
        }).window.document;
        const contentDocument = new JSDOM('<body><p>Embedded text</p></body>', {
            url: 'https://frame.example.test/content',
        }).window.document;
        Object.defineProperty(emptyFrame, 'contentDocument', { configurable: true, get: () => emptyDocument });
        Object.defineProperty(contentFrame, 'contentDocument', { configurable: true, get: () => contentDocument });

        expect(hasEligibleIframesByExtraction(document.body)).toBe(true);
        Object.defineProperty(contentFrame, 'contentDocument', { configurable: true, get: () => emptyDocument });
        expect(hasEligibleIframesByExtraction(document.body)).toBe(false);
    });

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

describe('extraction modes', () => {
    it('smart mode delegates to semantic root via getBestContent', () => {
        setupDOM('<body><header>Sidebar</header><main><h1>Article</h1><p>Body text</p></main><aside>Outside main</aside></body>');
        const result = getContentForMode('smart');

        expect(result?.sourceElement.tagName).toBe('MAIN');
        expect(result?.strategy).toBe('semantic-html');
    });

    it('full-page mode delegates to visible body via getVisibleBodyContent', () => {
        setupDOM('<body><header>Sidebar</header><main><h1>Article</h1><p>Body text</p></main><aside>Outside main</aside></body>');
        const result = getContentForMode('full-page');

        expect(result?.sourceElement).toBe(document.body);
        expect(result?.strategy).toBe('visible-body');
        expect(result?.element.textContent).toContain('Outside main');
    });
});

describe('selectCaptureRoot', () => {
    it('returns article when it has ordinary text', () => {
        setupDOM('<body><header>Nav</header><article><p>Article content</p></article></body>');
        const root = selectCaptureRoot('smart');
        expect(root?.tagName).toBe('ARTICLE');
    });

    it('falls back to main when article is absent', () => {
        setupDOM('<body><header>Nav</header><main><p>Main content</p></main></body>');
        const root = selectCaptureRoot('smart');
        expect(root?.tagName).toBe('MAIN');
    });

    it('falls back to role-main when article and main are absent', () => {
        setupDOM('<body><header>Nav</header><div role="main"><p>Role main content</p></div></body>');
        const root = selectCaptureRoot('smart');
        expect(root?.getAttribute('role')).toBe('main');
    });

    it('falls back to body when no semantic candidate has text', () => {
        setupDOM('<body><article>   </article><div></div></body>');
        const root = selectCaptureRoot('smart');
        expect(root).toBe(document.body);
    });

    it('returns body for full-page mode regardless of semantic roots', () => {
        setupDOM('<body><main><p>Main content</p></main></body>');
        const root = selectCaptureRoot('full-page');
        expect(root).toBe(document.body);
    });

    it('does not invoke cloneNode on the live DOM', () => {
        setupDOM('<body><main><p>Content</p></main></body>');
        const main = document.querySelector('main')!;
        const spy = vi.spyOn(main, 'cloneNode');
        selectCaptureRoot('smart');
        expect(spy).not.toHaveBeenCalled();
    });

    it('does not invoke recoverGeneratedText', async () => {
        const { recoverGeneratedText } = await import('../src/generated-text');
        setupDOM('<body><main><p>Content</p></main></body>');
        const spy = vi.spyOn(recoverGeneratedText as { apply: (...args: unknown[]) => unknown }, 'apply');
        selectCaptureRoot('smart');
        expect(spy).not.toHaveBeenCalled();
    });
});
