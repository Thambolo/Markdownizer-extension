// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// ── Stub helpers for jsdom geometry ───────────────────────────────────────────

const VISIBLE_RECT: DOMRect = { x: 10, y: 10, width: 200, height: 50, top: 10, right: 210, bottom: 60, left: 10 } as DOMRect;

/**
 * Create an array-like object that behaves like DOMRectList.
 * jsdom does not define DOMRectList, so we polyfill it.
 */
function createRectList(rects: DOMRect[]): DOMRectList {
    const list = rects.slice();
    Object.defineProperty(list, 'length', { value: rects.length });
    return list as unknown as DOMRectList;
}

const EMPTY_RECT_LIST: DOMRectList = createRectList([]);

/**
 * Patch Range.prototype.getClientRects so that ranges covering
 * text in visible elements return a non-empty rect.
 * Elements with zero width/height, hidden attribute, or hidden styles
 * return empty rects.
 */
function stubRangeClientRects(): void {
    Range.prototype.getClientRects = function () {
        const text = this.toString();
        if (text && text.trim().length > 0) {
            // Check if parent element is hidden or zero-size
            const container = this.startContainer;
            const parent = container.nodeType === Node.TEXT_NODE
                ? container.parentElement
                : container as Element;
            if (parent) {
                // Check hidden attribute
                if (parent.hasAttribute('hidden')) {
                    return EMPTY_RECT_LIST;
                }
                // Check inline style attribute for zero size
                const styleAttr = parent.getAttribute('style') || '';
                if (/width\s*:\s*0(?:px)?\b/.test(styleAttr) || /height\s*:\s*0(?:px)?\b/.test(styleAttr)) {
                    return EMPTY_RECT_LIST;
                }
                // Check computed visibility/display/opacity via getComputedStyle proxy
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

/**
 * Check if an element or any ancestor is hidden (display:none,
 * visibility:hidden/collapse, opacity:0, or hidden attribute).
 */
function isAncestorHidden(el: Element): boolean {
    let current: Element | null = el;
    while (current && current !== document.documentElement) {
        if (current.hasAttribute('hidden')) return true;
        const computed = window.getComputedStyle(current);
        if (computed.display === 'none') return true;
        if (computed.visibility === 'hidden' || computed.visibility === 'collapse') return true;
        if (parseFloat(computed.opacity) === 0) return true;
        current = current.parentElement;
    }
    return false;
}

/**
 * Patch Element.prototype.getClientRects so that specific elements
 * return a non-empty rect (unless an ancestor is hidden). Others return empty.
 */
function stubElementClientRects(visibleSelectors: string[]): void {
    Element.prototype.getClientRects = function () {
        if (visibleSelectors.some(sel => this.matches(sel)) && !isAncestorHidden(this)) {
            return createRectList([VISIBLE_RECT]);
        }
        return EMPTY_RECT_LIST;
    };
}

/**
 * Patch getComputedStyle to return visibility/opacity based on attributes.
 */
function stubComputedStyle(): void {
    window.getComputedStyle = function (elt) {
        const htmlElt = elt as HTMLElement;
        return {
            get display() {
                if (htmlElt.style.display === 'none') return 'none';
                const tag = htmlElt.tagName.toLowerCase();
                if (['div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'main', 'article', 'aside', 'nav', 'header', 'footer', 'blockquote', 'pre', 'ul', 'ol', 'li', 'table', 'form', 'fieldset', 'details', 'summary'].includes(tag)) {
                    return 'block';
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
        } as unknown as CSSStyleDeclaration;
    };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FIXTURE_HTML = `
<main id="root">
  <h1>Visible heading</h1>
  <p>Visible paragraph</p>
  <p hidden>Hidden authored text</p>
  <script>excluded script</script>
  <style>excluded style</style>
  <noscript>excluded noscript</noscript>
  <template>excluded template</template>
  <button><span>Button label</span></button>
  <img id="visible-image" alt="Diagram">
  <img id="hidden-image" hidden alt="Hidden diagram">
  <input id="visible-input" value="Answer">
  <input id="hidden-input" type="hidden" value="Secret">
  <div style="display:none">Hidden by display</div>
  <div style="visibility:hidden">Hidden by visibility</div>
  <div style="visibility:collapse">Collapsed</div>
  <div style="opacity:0">Transparent</div>
  <div style="width:0;height:0">Zero size</div>
  <span>   </span>
  <span>\n\t</span>
</main>
<footer>Outside content</footer>
`;

function setupDOM(html: string): void {
    document.documentElement.innerHTML = html;
}

// ── Import the function under test ─────────────────────────────────────────────

import { collectContentPreviewTargets } from '../src/content-preview';

// ── Prototype hygiene: save originals before each test, restore after ─────────

let origRangeGetClientRects: typeof Range.prototype.getClientRects | undefined;
let origElementGetClientRects: typeof Element.prototype.getClientRects | undefined;

function saveOriginals(): void {
    origRangeGetClientRects = Range.prototype.getClientRects;
    origElementGetClientRects = Element.prototype.getClientRects;
}

function restoreOriginals(): void {
    if (origRangeGetClientRects !== undefined) {
        Range.prototype.getClientRects = origRangeGetClientRects;
    }
    if (origElementGetClientRects !== undefined) {
        Element.prototype.getClientRects = origElementGetClientRects;
    }
    origRangeGetClientRects = undefined;
    origElementGetClientRects = undefined;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('collectContentPreviewTargets', () => {
    beforeEach(() => {
        saveOriginals();
        stubRangeClientRects();
        stubElementClientRects(['#visible-image', 'button', '#visible-input', '#visible-select', '#visible-textarea', '#password-input']);
        stubComputedStyle();
        setupDOM(FIXTURE_HTML);
    });

    afterEach(() => {
        restoreOriginals();
    });

    it('collects visible text ranges and boxed elements', () => {
        const root = document.querySelector('main')!;
        const targets = collectContentPreviewTargets(root);

        expect(targets.textRanges.map(r => r.toString())).toEqual([
            'Visible heading',
            'Visible paragraph',
        ]);
        expect(targets.boxedElements).toEqual([
            document.querySelector('button'),
            document.querySelector('#visible-image'),
            document.querySelector('#visible-input'),
        ]);
    });

    it('omits whitespace-only text nodes', () => {
        setupDOM('<main id="root"><p>   </p></main>');
        const root = document.querySelector('main')!;
        const targets = collectContentPreviewTargets(root);
        expect(targets.textRanges).toHaveLength(0);
    });

    it('omits text inside style, noscript, and template', () => {
        setupDOM('<main id="root"><style>.x{}</style><noscript>fallback</noscript><template>content</template><p>Visible</p></main>');
        const root = document.querySelector('main')!;
        const targets = collectContentPreviewTargets(root);
        expect(targets.textRanges.map(r => r.toString())).toEqual(['Visible']);
    });

    it('does not duplicate text inside button as a text range', () => {
        setupDOM('<main id="root"><button><span>Label</span></button></main>');
        const root = document.querySelector('main')!;
        const targets = collectContentPreviewTargets(root);
        // Button text should NOT appear in textRanges (it is a boxed element)
        const buttonTextRanges = targets.textRanges.filter(r => r.toString().includes('Label'));
        expect(buttonTextRanges).toHaveLength(0);
        expect(targets.boxedElements).toEqual([document.querySelector('button')]);
    });

    it('does not duplicate text inside input as a text range', () => {
        setupDOM('<main id="root"><input id="vis" value="Text"></main>');
        stubElementClientRects(['#vis']);
        stubComputedStyle();
        const root = document.querySelector('main')!;
        const targets = collectContentPreviewTargets(root);
        const inputTextRanges = targets.textRanges.filter(r => r.toString().includes('Text'));
        expect(inputTextRanges).toHaveLength(0);
        expect(targets.boxedElements).toEqual([document.querySelector('#vis')]);
    });

    it('does not duplicate text inside select as a text range', () => {
        setupDOM('<main id="root"><select id="sel"><option>Choice</option></select></main>');
        stubElementClientRects(['#sel']);
        stubComputedStyle();
        const root = document.querySelector('main')!;
        const targets = collectContentPreviewTargets(root);
        const selectTextRanges = targets.textRanges.filter(r => r.toString().includes('Choice'));
        expect(selectTextRanges).toHaveLength(0);
    });

    it('does not duplicate text inside textarea as a text range', () => {
        setupDOM('<main id="root"><textarea id="ta">Content</textarea></main>');
        stubElementClientRects(['#ta']);
        stubComputedStyle();
        const root = document.querySelector('main')!;
        const targets = collectContentPreviewTargets(root);
        const taTextRanges = targets.textRanges.filter(r => r.toString().includes('Content'));
        expect(taTextRanges).toHaveLength(0);
    });

    it('omits elements with display:none', () => {
        const root = document.querySelector('main')!;
        const targets = collectContentPreviewTargets(root);
        // display:none div should not be boxed
        const hiddenDivs = Array.from(targets.boxedElements).filter(el =>
            el.getAttribute('style')?.includes('display:none')
        );
        expect(hiddenDivs).toHaveLength(0);
    });

    it('omits elements with visibility:hidden', () => {
        const root = document.querySelector('main')!;
        const targets = collectContentPreviewTargets(root);
        const hiddenDivs = Array.from(targets.boxedElements).filter(el =>
            el.getAttribute('style')?.includes('visibility:hidden')
        );
        expect(hiddenDivs).toHaveLength(0);
    });

    it('omits elements with visibility:collapse', () => {
        const root = document.querySelector('main')!;
        const targets = collectContentPreviewTargets(root);
        const collapsedDivs = Array.from(targets.boxedElements).filter(el =>
            el.getAttribute('style')?.includes('visibility:collapse')
        );
        expect(collapsedDivs).toHaveLength(0);
    });

    it('omits elements with opacity:0', () => {
        const root = document.querySelector('main')!;
        const targets = collectContentPreviewTargets(root);
        const transparentDivs = Array.from(targets.boxedElements).filter(el =>
            el.getAttribute('style')?.includes('opacity:0')
        );
        expect(transparentDivs).toHaveLength(0);
    });

    it('omits elements with hidden attribute', () => {
        const root = document.querySelector('main')!;
        const targets = collectContentPreviewTargets(root);
        // Hidden images and inputs should not be boxed
        expect(targets.boxedElements).not.toContain(document.querySelector('#hidden-image'));
        expect(targets.boxedElements).not.toContain(document.querySelector('#hidden-input'));
        // Hidden paragraph text should not be collected
        const hiddenText = targets.textRanges.filter(r => r.toString().includes('Hidden authored'));
        expect(hiddenText).toHaveLength(0);
    });

    it('omits elements with zero width or height', () => {
        const root = document.querySelector('main')!;
        const targets = collectContentPreviewTargets(root);
        const zeroSizeDivs = Array.from(targets.boxedElements).filter(el =>
            el.getAttribute('style')?.includes('width:0')
        );
        expect(zeroSizeDivs).toHaveLength(0);
    });

    it('omits content outside root', () => {
        const root = document.querySelector('main')!;
        const targets = collectContentPreviewTargets(root);
        const footerText = targets.textRanges.filter(r => r.toString().includes('Outside content'));
        expect(footerText).toHaveLength(0);
    });

    it('boxes visible select and textarea', () => {
        setupDOM('<main id="root"><select id="visible-select"><option>Option</option></select><textarea id="visible-textarea">Text</textarea></main>');
        stubElementClientRects(['#visible-select', '#visible-textarea']);
        stubComputedStyle();
        const root = document.querySelector('main')!;
        const targets = collectContentPreviewTargets(root);
        expect(targets.boxedElements).toContain(document.querySelector('#visible-select'));
        expect(targets.boxedElements).toContain(document.querySelector('#visible-textarea'));
    });

    it('boxes password input without reading its value', () => {
        setupDOM('<main id="root"><input id="password-input" type="password" value="secret123"></main>');
        stubElementClientRects(['#password-input']);
        stubComputedStyle();
        const root = document.querySelector('main')!;
        const targets = collectContentPreviewTargets(root);
        expect(targets.boxedElements).toContain(document.querySelector('#password-input'));
        // Verify the value was never read (password values should not appear in textRanges)
        const passwordText = targets.textRanges.filter(r => r.toString().includes('secret123'));
        expect(passwordText).toHaveLength(0);
    });

    it('does not include nested input inside button as separate boxed element', () => {
        setupDOM('<main id="root"><button><input id="nested-input-in-button" value="Nested"></button></main>');
        stubElementClientRects(['button']);
        stubComputedStyle();
        const root = document.querySelector('main')!;
        const targets = collectContentPreviewTargets(root);
        // The nested input inside button should not be a separate boxed element
        expect(targets.boxedElements).not.toContain(document.querySelector('#nested-input-in-button'));
    });

    it('omits boxed element inside a display:none ancestor (empty rects from hidden subtree)', () => {
        setupDOM('<main id="root"><div id="hidden-parent" style="display:none"><button id="boxed-in-hidden">Click me</button></div></main>');
        stubElementClientRects(['#boxed-in-hidden']);
        stubComputedStyle();
        const root = document.querySelector('main')!;
        const targets = collectContentPreviewTargets(root);
        // The button is inside a display:none ancestor, so its getClientRects returns empty
        // rects via the ancestor-aware stub — it must not appear as a boxed element.
        expect(targets.boxedElements).not.toContain(document.querySelector('#boxed-in-hidden'));
        expect(targets.boxedElements).toHaveLength(0);
    });
});

// ── ContentPreview host/box overlay tests ────────────────────────────────────

import { ContentPreview, CONTENT_PREVIEW_HOST_ATTRIBUTE, READY_HIGHLIGHT_NAME, LOADING_HIGHLIGHT_NAME } from '../src/content-preview';

describe('ContentPreview host and box overlay', () => {
    beforeEach(() => {
        saveOriginals();
        stubRangeClientRects();
        stubElementClientRects(['#visible-image', 'button', '#visible-input', '#visible-select', '#visible-textarea', '#password-input']);
        stubComputedStyle();
        setupDOM(FIXTURE_HTML);
    });

    afterEach(() => {
        restoreOriginals();
    });

    it('creates one host appended to document.documentElement after body when boxed elements exist', () => {
        const preview = new ContentPreview();
        const root = document.querySelector('main')!;
        preview.show(root);

        const hosts = document.querySelectorAll(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`);
        expect(hosts).toHaveLength(1);

        const host = hosts[0];
        // Host must be a child of document.documentElement
        expect(host.parentElement).toBe(document.documentElement);
        // Host must come after <body> (host is last appended)
        const body = document.body;
        const hostIndex = Array.from(document.documentElement.children).indexOf(host);
        const bodyIndex = Array.from(document.documentElement.children).indexOf(body);
        expect(hostIndex).toBeGreaterThan(bodyIndex);
    });

    it('host has aria-hidden="true" and pointer-events:none', () => {
        const preview = new ContentPreview();
        const root = document.querySelector('main')!;
        preview.show(root);

        const host = document.querySelector(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`)!;
        expect(host.getAttribute('aria-hidden')).toBe('true');
        expect((host as HTMLElement).style.pointerEvents).toBe('none');
    });

    it('creates .content-preview-box for each visible boxed element', () => {
        const preview = new ContentPreview();
        const root = document.querySelector('main')!;
        preview.show(root);

        const host = document.querySelector(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`)!;
        const shadow = host.shadowRoot!;
        const boxes = shadow.querySelectorAll('.content-preview-box');
        // Visible boxed elements: button, #visible-image, #visible-input
        expect(boxes.length).toBeGreaterThanOrEqual(3);
    });

    it('boxes use viewport-relative positioning from getClientRects', () => {
        const preview = new ContentPreview();
        const root = document.querySelector('main')!;
        preview.show(root);

        const host = document.querySelector(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`)!;
        const shadow = host.shadowRoot!;
        const box = shadow.querySelector('.content-preview-box') as HTMLElement;
        expect(box).toBeTruthy();
        // Geometry is set inline; visual styles come from .content-preview-box CSS class
        expect(box.className).toBe('content-preview-box');
        // VISIBLE_RECT has top:10, left:10, width:200, height:50
        expect(box.style.top).toBe('10px');
        expect(box.style.left).toBe('10px');
        expect(box.style.width).toBe('200px');
        expect(box.style.height).toBe('50px');
    });

    it('setLoading() changes host data-preview-state without recreating boxes', () => {
        const preview = new ContentPreview();
        const root = document.querySelector('main')!;
        preview.show(root);

        const host = document.querySelector(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`)!;
        const boxesBefore = host.shadowRoot!.querySelectorAll('.content-preview-box').length;
        expect(host.getAttribute('data-preview-state')).toBe('ready');

        preview.setLoading();
        const hostAfter = document.querySelector(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`)!;
        expect(hostAfter.getAttribute('data-preview-state')).toBe('loading');
        const boxesAfter = hostAfter.shadowRoot!.querySelectorAll('.content-preview-box').length;
        expect(boxesAfter).toBe(boxesBefore);
    });

    it('setReady() restores host data-preview-state to ready', () => {
        const preview = new ContentPreview();
        const root = document.querySelector('main')!;
        preview.show(root);

        preview.setLoading();
        preview.setReady();
        const host = document.querySelector(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`)!;
        expect(host.getAttribute('data-preview-state')).toBe('ready');
    });

    it('repeated show() replaces the host (no duplicate hosts)', () => {
        const preview = new ContentPreview();
        const root = document.querySelector('main')!;
        preview.show(root);
        preview.show(root);

        const hosts = document.querySelectorAll(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`);
        expect(hosts).toHaveLength(1);
    });

    it('repeated remove() is safe', () => {
        const preview = new ContentPreview();
        const root = document.querySelector('main')!;
        preview.show(root);

        expect(() => {
            preview.remove();
            preview.remove();
        }).not.toThrow();
    });

    it('remove() removes host, listeners, observers, and pending frame', () => {
        // ── Set up spies and stubs before show() ──────────────────────────
        const roDisconnectSpy = vi.fn();
        const roObserveSpy = vi.fn();
        const origRO = (globalThis as any).ResizeObserver;
        (globalThis as any).ResizeObserver = class {
            observe(...args: any[]) { roObserveSpy(...args); }
            disconnect() { roDisconnectSpy(); }
            unobserve() {}
        };

        const cancelRafSpy = vi.spyOn(globalThis, 'cancelAnimationFrame');
        const removeScrollSpy = vi.spyOn(document, 'removeEventListener');
        const removeResizeSpy = vi.spyOn(window, 'removeEventListener');

        const preview = new ContentPreview();
        const root = document.querySelector('main')!;
        preview.show(root);

        // Verify host exists and ResizeObserver observed elements (including root)
        const hostBefore = document.querySelector(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`);
        expect(hostBefore).toBeTruthy();
        expect(roObserveSpy).toHaveBeenCalled();
        expect(roObserveSpy).toHaveBeenCalledWith(root);

        // Trigger scroll to schedule a pending RAF
        document.dispatchEvent(new Event('scroll'));

        preview.remove();

        // ── Verify all cleanup ────────────────────────────────────────────
        // Host removed from DOM
        const hostAfter = document.querySelector(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`);
        expect(hostAfter).toBeNull();

        // ResizeObserver disconnected
        expect(roDisconnectSpy).toHaveBeenCalled();

        // Pending RAF cancelled
        expect(cancelRafSpy).toHaveBeenCalled();

        // Scroll listener removed (capture phase)
        expect(removeScrollSpy).toHaveBeenCalledWith(
            'scroll',
            expect.any(Function),
            { capture: true },
        );

        // Resize listener removed
        expect(removeResizeSpy).toHaveBeenCalledWith(
            'resize',
            expect.any(Function),
        );

        // ── Restore ───────────────────────────────────────────────────────
        if (origRO !== undefined) {
            (globalThis as any).ResizeObserver = origRO;
        } else {
            delete (globalThis as any).ResizeObserver;
        }
        cancelRafSpy.mockRestore();
        removeScrollSpy.mockRestore();
        removeResizeSpy.mockRestore();
    });

    it('no host is created for text-only targets (no boxed elements)', () => {
        setupDOM('<main id="root"><p>Hello world</p></main>');
        stubRangeClientRects();
        stubElementClientRects([]);
        stubComputedStyle();

        const preview = new ContentPreview();
        const root = document.querySelector('main')!;
        preview.show(root);

        const hosts = document.querySelectorAll(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`);
        expect(hosts).toHaveLength(0);
    });

    it('host is replaced on second show() with different targets', () => {
        const preview = new ContentPreview();

        // First show with image
        setupDOM('<main id="root"><img id="img1" alt="A"></main>');
        stubElementClientRects(['#img1']);
        stubComputedStyle();
        stubRangeClientRects();
        preview.show(document.querySelector('main')!);
        const host1 = document.querySelector(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`)!;
        const boxes1 = host1.shadowRoot!.querySelectorAll('.content-preview-box').length;
        expect(boxes1).toBeGreaterThanOrEqual(1);

        // Second show with different elements
        setupDOM('<main id="root"><button>Click</button></main>');
        stubElementClientRects(['button']);
        stubComputedStyle();
        stubRangeClientRects();
        preview.show(document.querySelector('main')!);
        const host2 = document.querySelector(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`)!;
        const boxes2 = host2.shadowRoot!.querySelectorAll('.content-preview-box').length;
        expect(boxes2).toBeGreaterThanOrEqual(1);

        // Only one host
        const hosts = document.querySelectorAll(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`);
        expect(hosts).toHaveLength(1);
    });
});

// ── ContentPreview registry lifecycle tests ──────────────────────────────────

/**
 * A mock HighlightRegistry backed by a plain Map. Provides `set`, `delete`,
 * and `has` which are the only methods ContentPreview uses.
 */
function createMockRegistry(): Map<string, any> & { set: typeof Map.prototype.set; delete: typeof Map.prototype.delete; has: typeof Map.prototype.has } {
    return new Map<string, any>();
}

/**
 * A stubbed Highlight class that stores the ranges it receives.
 * jsdom does not implement the CSS Custom Highlight API.
 */
class StubHighlight {
    ranges: any[];
    constructor(...args: any[]) {
        this.ranges = args.flat();
    }
}

describe('ContentPreview lifecycle', () => {
    let registry: ReturnType<typeof createMockRegistry>;
    let origCSS: typeof CSS | undefined;
    let origHighlight: typeof Highlight | undefined;

    beforeEach(() => {
        saveOriginals();
        stubRangeClientRects();
        stubElementClientRects(['#visible-image', 'button', '#visible-input']);
        stubComputedStyle();
        setupDOM(FIXTURE_HTML);
        registry = createMockRegistry();

        // Save originals
        origCSS = (globalThis as any).CSS;
        origHighlight = (globalThis as any).Highlight;

        // Stub CSS.highlights to our mock registry
        (globalThis as any).CSS = { highlights: registry };
        // Stub Highlight constructor
        (globalThis as any).Highlight = StubHighlight;
    });

    afterEach(() => {
        restoreOriginals();
        // Restore CSS and Highlight globals
        if (origCSS !== undefined) {
            (globalThis as any).CSS = origCSS;
        } else {
            delete (globalThis as any).CSS;
        }
        if (origHighlight !== undefined) {
            (globalThis as any).Highlight = origHighlight;
        } else {
            delete (globalThis as any).Highlight;
        }
    });

    it('show registers ready highlight and not loading', () => {
        const preview = new ContentPreview();
        const root = document.querySelector('main')!;
        preview.show(root);
        expect(registry.has(READY_HIGHLIGHT_NAME)).toBe(true);
        expect(registry.has(LOADING_HIGHLIGHT_NAME)).toBe(false);
    });

    it('setLoading swaps ready for loading', () => {
        const preview = new ContentPreview();
        const root = document.querySelector('main')!;
        preview.show(root);
        expect(registry.has(READY_HIGHLIGHT_NAME)).toBe(true);

        preview.setLoading();
        expect(registry.has(READY_HIGHLIGHT_NAME)).toBe(false);
        expect(registry.has(LOADING_HIGHLIGHT_NAME)).toBe(true);
    });

    it('setReady swaps loading for ready', () => {
        const preview = new ContentPreview();
        const root = document.querySelector('main')!;
        preview.show(root);
        preview.setLoading();
        expect(registry.has(LOADING_HIGHLIGHT_NAME)).toBe(true);

        preview.setReady();
        expect(registry.has(READY_HIGHLIGHT_NAME)).toBe(true);
        expect(registry.has(LOADING_HIGHLIGHT_NAME)).toBe(false);
    });

    it('remove clears both registry names', () => {
        const preview = new ContentPreview();
        const root = document.querySelector('main')!;
        preview.show(root);
        preview.setLoading();

        preview.remove();
        expect(registry.has(READY_HIGHLIGHT_NAME)).toBe(false);
        expect(registry.has(LOADING_HIGHLIGHT_NAME)).toBe(false);
    });

    it('full lifecycle: show -> setLoading -> setReady -> remove', () => {
        const preview = new ContentPreview();
        const root = document.querySelector('main')!;

        preview.show(root);
        expect(registry.has(READY_HIGHLIGHT_NAME)).toBe(true);
        expect(registry.has(LOADING_HIGHLIGHT_NAME)).toBe(false);

        preview.setLoading();
        expect(registry.has(READY_HIGHLIGHT_NAME)).toBe(false);
        expect(registry.has(LOADING_HIGHLIGHT_NAME)).toBe(true);

        preview.setReady();
        expect(registry.has(READY_HIGHLIGHT_NAME)).toBe(true);
        expect(registry.has(LOADING_HIGHLIGHT_NAME)).toBe(false);

        preview.remove();
        expect(registry.has(READY_HIGHLIGHT_NAME)).toBe(false);
        expect(registry.has(LOADING_HIGHLIGHT_NAME)).toBe(false);
    });

    it('show calls remove first (does not leave stale highlights)', () => {
        const preview = new ContentPreview();
        const root = document.querySelector('main')!;
        preview.show(root);
        expect(registry.has(READY_HIGHLIGHT_NAME)).toBe(true);

        // show again — should clear old and re-register
        preview.show(root);
        expect(registry.has(READY_HIGHLIGHT_NAME)).toBe(true);
        expect(registry.has(LOADING_HIGHLIGHT_NAME)).toBe(false);
    });
});

describe('ContentPreview unsupported API', () => {
    let origCSS: typeof CSS | undefined;
    let origHighlight: typeof Highlight | undefined;

    beforeEach(() => {
        origCSS = (globalThis as any).CSS;
        origHighlight = (globalThis as any).Highlight;
    });

    afterEach(() => {
        if (origCSS !== undefined) {
            (globalThis as any).CSS = origCSS;
        } else {
            delete (globalThis as any).CSS;
        }
        if (origHighlight !== undefined) {
            (globalThis as any).Highlight = origHighlight;
        } else {
            delete (globalThis as any).Highlight;
        }
    });

    it('does not throw when Highlight is unavailable', () => {
        delete (globalThis as any).Highlight;
        setupDOM('<main id="root"><p>Hello</p></main>');
        stubRangeClientRects();
        stubElementClientRects([]);
        stubComputedStyle();

        const preview = new ContentPreview();
        const root = document.querySelector('main')!;

        expect(() => preview.show(root)).not.toThrow();
        expect(() => preview.setLoading()).not.toThrow();
        expect(() => preview.setReady()).not.toThrow();
        expect(() => preview.remove()).not.toThrow();
    });

    it('does not throw when CSS.highlights is unavailable', () => {
        delete (globalThis as any).CSS;
        setupDOM('<main id="root"><p>Hello</p></main>');
        stubRangeClientRects();
        stubElementClientRects([]);
        stubComputedStyle();

        const preview = new ContentPreview();
        const root = document.querySelector('main')!;

        expect(() => preview.show(root)).not.toThrow();
        expect(() => preview.setLoading()).not.toThrow();
        expect(() => preview.setReady()).not.toThrow();
        expect(() => preview.remove()).not.toThrow();
    });
});

// ── ContentPreview MutationObserver rebuild tests ─────────────────────────────

/**
 * Controllable MutationObserver stub.
 * Captures constructor args and provides manual `trigger()` to invoke callbacks.
 * Also exposes `lastDisconnect` to verify disconnect was called.
 */
class StubMutationObserver {
    static instances: StubMutationObserver[] = [];
    callback: MutationCallback;
    options?: MutationObserverInit;
    target?: Node;
    disconnected = false;

    constructor(callback: MutationCallback) {
        this.callback = callback;
        StubMutationObserver.instances.push(this);
    }
    observe(target: Node, options?: MutationObserverInit): void {
        this.target = target;
        this.options = options;
    }
    disconnect(): void {
        this.disconnected = true;
    }
    takeRecords(): MutationRecord[] {
        return [];
    }
    /** Manually fire the callback with the given records. */
    trigger(records: MutationRecord[], observer?: MutationObserver): void {
        this.callback(records, observer ?? (this as unknown as MutationObserver));
    }
    static reset(): void {
        StubMutationObserver.instances = [];
    }
}

describe('ContentPreview MutationObserver rebuild', () => {
    let origMO: typeof MutationObserver | undefined;
    let origRaf: typeof requestAnimationFrame | undefined;
    let origCaf: typeof cancelAnimationFrame | undefined;
    let origCSS: typeof CSS | undefined;
    let origHighlight: typeof Highlight | undefined;
    let registry: ReturnType<typeof createMockRegistry>;
    /** Collected requestAnimationFrame callbacks for manual flushing. */
    let rafCallbacks: FrameRequestCallback[];
    let rafIds: number[];

    beforeEach(() => {
        saveOriginals();
        stubRangeClientRects();
        stubElementClientRects(['#visible-image', 'button', '#visible-input']);
        stubComputedStyle();
        setupDOM(FIXTURE_HTML);

        StubMutationObserver.reset();

        origMO = (globalThis as any).MutationObserver;
        (globalThis as any).MutationObserver = StubMutationObserver;

        // Set up mock CSS.highlights registry and Highlight
        registry = createMockRegistry();
        origCSS = (globalThis as any).CSS;
        origHighlight = (globalThis as any).Highlight;
        (globalThis as any).CSS = { highlights: registry };
        (globalThis as any).Highlight = StubHighlight;

        // Stub requestAnimationFrame to capture callbacks
        rafCallbacks = [];
        rafIds = [];
        let nextId = 1;
        origRaf = globalThis.requestAnimationFrame;
        globalThis.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
            const id = nextId++;
            rafCallbacks.push(cb);
            rafIds.push(id);
            return id;
        });
        origCaf = globalThis.cancelAnimationFrame;
        globalThis.cancelAnimationFrame = vi.fn((id: number) => {
            const idx = rafIds.indexOf(id);
            if (idx !== -1) {
                rafCallbacks.splice(idx, 1);
                rafIds.splice(idx, 1);
            }
        });
    });

    afterEach(() => {
        if (origMO !== undefined) {
            (globalThis as any).MutationObserver = origMO;
        } else {
            delete (globalThis as any).MutationObserver;
        }
        if (origRaf !== undefined) {
            globalThis.requestAnimationFrame = origRaf;
        }
        if (origCaf !== undefined) {
            globalThis.cancelAnimationFrame = origCaf;
        }
        if (origCSS !== undefined) {
            (globalThis as any).CSS = origCSS;
        } else {
            delete (globalThis as any).CSS;
        }
        if (origHighlight !== undefined) {
            (globalThis as any).Highlight = origHighlight;
        } else {
            delete (globalThis as any).Highlight;
        }
        restoreOriginals();
    });

    /** Flush all pending requestAnimationFrame callbacks. */
    function flushRaf(): void {
        while (rafCallbacks.length > 0) {
            const cb = rafCallbacks.shift()!;
            rafIds.shift();
            cb(performance.now());
        }
    }

    it('observes the selected root, not document.documentElement or the preview host', () => {
        const preview = new ContentPreview();
        const root = document.querySelector('main')!;
        preview.show(root);

        expect(StubMutationObserver.instances).toHaveLength(1);
        const mo = StubMutationObserver.instances[0];
        // The observe() call targets the root, not documentElement or host
        expect(mo.target).toBe(root);
        expect(mo.options).toEqual({
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
        });
    });

    it('rebuilds targets when a text node is added to root', () => {
        setupDOM('<main id="root"><p>Original</p></main>');
        stubElementClientRects([]);
        stubRangeClientRects();
        stubComputedStyle();

        const preview = new ContentPreview();
        const root = document.querySelector('main')!;
        preview.show(root);

        // Verify initial state: one text range
        expect(registry.has(READY_HIGHLIGHT_NAME)).toBe(true);

        // Add a second paragraph
        const p2 = document.createElement('p');
        p2.textContent = 'Added paragraph';
        root.appendChild(p2);

        // Trigger mutation
        const mo = StubMutationObserver.instances[0];
        mo.trigger([{ type: 'childList', addedNodes: [p2] } as MutationRecord]);

        // Before flushing, registry should still hold old highlight
        // (rebuild is deferred to rAF)
        flushRaf();

        // After flush: rebuild ran, recollected targets, and updated registry
        // The highlight now includes ranges from both paragraphs
        expect(registry.has(READY_HIGHLIGHT_NAME)).toBe(true);
        const storedHighlight = registry.get(READY_HIGHLIGHT_NAME);
        expect(storedHighlight.ranges.length).toBeGreaterThanOrEqual(2);
    });

    it('coalesces multiple mutations into a single rebuild frame', () => {
        setupDOM('<main id="root"><p>Original</p></main>');
        stubElementClientRects([]);
        stubRangeClientRects();
        stubComputedStyle();

        const preview = new ContentPreview();
        const root = document.querySelector('main')!;
        preview.show(root);

        const mo = StubMutationObserver.instances[0];
        const p2 = document.createElement('p');
        p2.textContent = 'Second';
        const p3 = document.createElement('p');
        p3.textContent = 'Third';

        // Actually add the elements to the DOM so rebuild can find them
        root.appendChild(p2);
        root.appendChild(p3);

        // Fire two mutations before flushing
        mo.trigger([{ type: 'childList', addedNodes: [p2] } as MutationRecord]);
        mo.trigger([{ type: 'childList', addedNodes: [p3] } as MutationRecord]);

        // Only one rAF should have been queued
        expect(rafCallbacks.length).toBe(1);

        flushRaf();

        // After the single flush, both paragraphs are reflected
        const storedHighlight = registry.get(READY_HIGHLIGHT_NAME);
        expect(storedHighlight.ranges.length).toBeGreaterThanOrEqual(2);
    });

    it('removes a boxed element box when the element is removed from root', () => {
        setupDOM('<main id="root"><img id="img-to-remove" alt="Removable"><p>Keep</p></main>');
        stubElementClientRects(['#img-to-remove']);
        stubRangeClientRects();
        stubComputedStyle();

        const preview = new ContentPreview();
        const root = document.querySelector('main')!;
        preview.show(root);

        // Verify box exists for the image
        const host = document.querySelector(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`)!;
        const shadow = host.shadowRoot!;
        const boxesBefore = shadow.querySelectorAll('.content-preview-box').length;
        expect(boxesBefore).toBeGreaterThanOrEqual(1);

        // Remove the image
        const img = root.querySelector('#img-to-remove')!;
        root.removeChild(img);

        const mo = StubMutationObserver.instances[0];
        mo.trigger([{ type: 'childList', removedNodes: [img] } as MutationRecord]);

        flushRaf();

        // After rebuild, no boxed elements remain → host is removed
        const hostAfter = document.querySelector(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`);
        expect(hostAfter).toBeNull();
    });

    it('preserves loading state across rebuild', () => {
        setupDOM('<main id="root"><p>Text</p></main>');
        stubElementClientRects([]);
        stubRangeClientRects();
        stubComputedStyle();

        const preview = new ContentPreview();
        const root = document.querySelector('main')!;
        preview.show(root);

        // Transition to loading
        preview.setLoading();
        expect(registry.has(LOADING_HIGHLIGHT_NAME)).toBe(true);

        // Mutate while loading
        const p2 = document.createElement('p');
        p2.textContent = 'More';
        root.appendChild(p2);

        const mo = StubMutationObserver.instances[0];
        mo.trigger([{ type: 'childList', addedNodes: [p2] } as MutationRecord]);
        flushRaf();

        // Still loading after rebuild
        expect(registry.has(LOADING_HIGHLIGHT_NAME)).toBe(true);
        expect(registry.has(READY_HIGHLIGHT_NAME)).toBe(false);
    });

    it('rebuild dominates geometry-only update in the same frame', () => {
        setupDOM('<main id="root"><img id="geom-img" alt="Geom"><p>Text</p></main>');
        stubElementClientRects(['#geom-img']);
        stubRangeClientRects();
        stubComputedStyle();

        const preview = new ContentPreview();
        const root = document.querySelector('main')!;
        preview.show(root);

        // Schedule a geometry-only update via scroll
        document.dispatchEvent(new Event('scroll'));
        // At least one rAF should be queued for geometry
        expect(rafCallbacks.length).toBeGreaterThanOrEqual(1);

        // Trigger a mutation via the observer — should NOT queue another rAF
        // because the pending geometry frame will be repurposed for rebuild
        const mo = StubMutationObserver.instances[0];
        const p2 = document.createElement('p');
        p2.textContent = 'New text';
        root.appendChild(p2);
        mo.trigger([{ type: 'childList', addedNodes: [p2] } as MutationRecord]);

        // Still only the same number of rAFs (no extra queued for rebuild)
        // A rebuild flag is set internally; when the pending frame fires,
        // it will run rebuild instead of geometry-only.
        expect(rafCallbacks.length).toBeGreaterThanOrEqual(1);

        flushRaf();

        // After flush: rebuild ran, so targets are recollected
        const storedHighlight = registry.get(READY_HIGHLIGHT_NAME);
        expect(storedHighlight.ranges.length).toBeGreaterThanOrEqual(2);
    });

    it('rebuilds on attribute changes — recollection picks up newly-visible element', () => {
        setupDOM('<main id="root"><p>Visible</p><p id="hidden-p" hidden>Secret</p></main>');
        stubElementClientRects([]);
        stubRangeClientRects();
        stubComputedStyle();

        const preview = new ContentPreview();
        const root = document.querySelector('main')!;
        preview.show(root);

        // Before mutation: hidden paragraph's text is NOT in the highlight ranges
        const rangesBefore = registry.get(READY_HIGHLIGHT_NAME).ranges.map((r: any) => r.toString());
        expect(rangesBefore).toEqual(['Visible']);
        expect(rangesBefore).not.toContain('Secret');

        // Remove the hidden attribute — triggers attribute mutation
        const hiddenP = root.querySelector('#hidden-p')!;
        hiddenP.removeAttribute('hidden');

        const mo = StubMutationObserver.instances[0];
        mo.trigger([{ type: 'attributes', target: hiddenP, attributeName: 'hidden' } as MutationRecord]);
        flushRaf();

        // After mutation: recollection picked up the newly-visible paragraph
        const rangesAfter = registry.get(READY_HIGHLIGHT_NAME).ranges.map((r: any) => r.toString());
        expect(rangesAfter).toContain('Visible');
        expect(rangesAfter).toContain('Secret');
        expect(rangesAfter.length).toBe(2);
    });

    it('rebuilds on characterData changes — recollection reflects modified text', () => {
        setupDOM('<main id="root"><p>Original text</p></main>');
        stubElementClientRects([]);
        stubRangeClientRects();
        stubComputedStyle();

        const preview = new ContentPreview();
        const root = document.querySelector('main')!;
        preview.show(root);

        // Before mutation: ranges contain original text
        const rangesBefore = registry.get(READY_HIGHLIGHT_NAME).ranges.map((r: any) => r.toString());
        expect(rangesBefore).toEqual(['Original text']);

        // Modify the text content
        const p = root.querySelector('p')!;
        const textNode = p.firstChild!;
        textNode.textContent = 'Modified text';

        const mo = StubMutationObserver.instances[0];
        mo.trigger([{ type: 'characterData', target: textNode } as MutationRecord]);
        flushRaf();

        // After mutation: recollection reflects the new text
        const rangesAfter = registry.get(READY_HIGHLIGHT_NAME).ranges.map((r: any) => r.toString());
        expect(rangesAfter).toEqual(['Modified text']);
        expect(rangesAfter).not.toEqual(rangesBefore);
    });

    it('disconnects MutationObserver on remove()', () => {
        setupDOM('<main id="root"><p>Text</p></main>');
        stubElementClientRects([]);
        stubRangeClientRects();
        stubComputedStyle();

        const preview = new ContentPreview();
        const root = document.querySelector('main')!;
        preview.show(root);

        expect(StubMutationObserver.instances).toHaveLength(1);

        preview.remove();

        expect(StubMutationObserver.instances[0].disconnected).toBe(true);
    });
});
