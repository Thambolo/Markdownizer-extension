// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    collectVisibleTextRanges,
    EXCLUDED_TEXT_ANCESTORS,
    hasNonEmptyRect,
    hasOrdinaryText,
    isHiddenInTree,
} from '../src/shared/dom-traversal';

// ── jsdom geometry stubs ──────────────────────────────────────────────────────

const VISIBLE_RECT: DOMRect = { x: 10, y: 10, width: 200, height: 50, top: 10, right: 210, bottom: 60, left: 10 } as DOMRect;

function createRectList(rects: DOMRect[]): DOMRectList {
    const list = rects.slice();
    Object.defineProperty(list, 'length', { value: rects.length });
    return list as unknown as DOMRectList;
}

const EMPTY: DOMRectList = createRectList([]);

let origRangeGetClientRects: typeof Range.prototype.getClientRects | undefined;

/** Range rect stub: empty for whitespace-only or hidden/zero-size text, visible otherwise. */
function stubRangeClientRects(throwOnSelector = '__never__'): void {
    origRangeGetClientRects = Range.prototype.getClientRects;
    Range.prototype.getClientRects = function () {
        const text = this.toString();
        if (text && text.trim().length > 0) {
            const parent = this.startContainer.nodeType === Node.TEXT_NODE
                ? this.startContainer.parentElement
                : this.startContainer as Element;
            if (parent) {
                if (parent.hasAttribute('hidden')) return EMPTY;
                const styleAttr = parent.getAttribute('style') || '';
                if (/width\s*:\s*0(?:px)?\b/.test(styleAttr) || /height\s*:\s*0(?:px)?\b/.test(styleAttr)) return EMPTY;
                if (parent.closest(throwOnSelector)) throw new Error('frame navigated away');
                const computed = window.getComputedStyle(parent);
                if (computed.display === 'none') return EMPTY;
                if (computed.visibility === 'hidden' || computed.visibility === 'collapse') return EMPTY;
                if (parseFloat(computed.opacity) === 0) return EMPTY;
            }
            return createRectList([VISIBLE_RECT]);
        }
        return EMPTY;
    };
}

function restoreOriginals(): void {
    if (origRangeGetClientRects !== undefined) {
        Range.prototype.getClientRects = origRangeGetClientRects;
    }
    origRangeGetClientRects = undefined;
}

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

function setupDOM(html: string): void {
    document.documentElement.innerHTML = `<div id="root">${html}</div>`;
}

function root(): HTMLElement {
    return document.getElementById('root')!;
}

// ── isHiddenInTree ────────────────────────────────────────────────────────────

describe('isHiddenInTree', () => {
    let origGetComputedStyle: typeof window.getComputedStyle;

    beforeEach(() => {
        origGetComputedStyle = window.getComputedStyle;
        stubComputedStyle();
        restoreOriginals();
    });

    afterEach(() => {
        window.getComputedStyle = origGetComputedStyle;
        restoreOriginals();
    });

    it('detects the hidden attribute', () => {
        setupDOM('<p hidden>text</p>');
        expect(isHiddenInTree(root().querySelector('p')!, root(), window)).toBe(true);
    });

    it('detects display:none through a descendant', () => {
        setupDOM('<div><p>text</p></div>');
        const p = root().querySelector('p')!;
        (p.parentElement!).style.display = 'none';
        expect(isHiddenInTree(p, root(), window)).toBe(true);
    });

    it('detects visibility:hidden', () => {
        setupDOM('<p style="visibility:hidden">text</p>');
        expect(isHiddenInTree(root().querySelector('p')!, root(), window)).toBe(true);
    });

    it('detects visibility:collapse', () => {
        setupDOM('<p style="visibility:collapse">text</p>');
        expect(isHiddenInTree(root().querySelector('p')!, root(), window)).toBe(true);
    });

    it('detects opacity:0', () => {
        setupDOM('<p style="opacity:0">text</p>');
        expect(isHiddenInTree(root().querySelector('p')!, root(), window)).toBe(true);
    });

    it('stops at the boundary: a hidden ancestor above the boundary is not considered', () => {
        setupDOM('<div hidden><section><p>text</p></section></div>');
        const section = root().querySelector('section')!;
        // boundary = section: the hidden div (above the boundary) must not cause a hidden result
        const p = section.querySelector('p')!;
        expect(isHiddenInTree(p, section, window)).toBe(false);
        // outside the boundary it is hidden
        expect(isHiddenInTree(p, root(), window)).toBe(true);
    });

    it('returns false for a visible element', () => {
        setupDOM('<p>text</p>');
        expect(isHiddenInTree(root().querySelector('p')!, root(), window)).toBe(false);
    });
});

// ── hasNonEmptyRect ───────────────────────────────────────────────────────────

describe('hasNonEmptyRect', () => {
    it('is true when at least one rect has width and height', () => {
        const rects = createRectList([{ ...VISIBLE_RECT, width: 0 } as DOMRect, VISIBLE_RECT]);
        expect(hasNonEmptyRect(rects)).toBe(true);
    });

    it('is false when all rects are empty or zero-sized', () => {
        expect(hasNonEmptyRect(EMPTY)).toBe(false);
        const rects = createRectList([
            { ...VISIBLE_RECT, width: 0, height: 0 } as DOMRect,
            { ...VISIBLE_RECT, width: 10, height: 0 } as DOMRect,
        ]);
        expect(hasNonEmptyRect(rects)).toBe(false);
    });
});

// ── collectVisibleTextRanges ──────────────────────────────────────────────────

describe('collectVisibleTextRanges', () => {
    let origGetComputedStyle: typeof window.getComputedStyle;

    beforeEach(() => {
        origGetComputedStyle = window.getComputedStyle;
        restoreOriginals();
    });

    afterEach(() => {
        window.getComputedStyle = origGetComputedStyle;
        restoreOriginals();
    });

    it('collects visible text, skipping boxed ancestors', () => {
        stubRangeClientRects();
        stubComputedStyle();
        setupDOM('<p>Hello</p><button><span>Label</span></button>');
        const ranges = collectVisibleTextRanges(root());
        expect(ranges.map((r) => r.toString())).toEqual(['Hello']);
    });

    it('skips text inside excluded ancestors (script, style, noscript, template)', () => {
        stubRangeClientRects();
        stubComputedStyle();
        setupDOM('<script>var x = 1;</script><style>.a{}</style><noscript>fallback</noscript><template>tmpl</template><p>Visible</p>');
        const ranges = collectVisibleTextRanges(root());
        expect(ranges.map((r) => r.toString())).toEqual(['Visible']);
    });

    it('supports a custom excluded selector', () => {
        stubRangeClientRects();
        stubComputedStyle();
        setupDOM('<code>not content</code><p>Visible</p>');
        const ranges = collectVisibleTextRanges(root(), { excludedSelector: 'code' });
        expect(ranges.map((r) => r.toString())).toEqual(['Visible']);
    });

    it('skips text inside hidden elements', () => {
        stubRangeClientRects();
        stubComputedStyle();
        setupDOM('<p>Visible</p><p hidden>Hidden authored</p><div style="display:none">display none</div>');
        const ranges = collectVisibleTextRanges(root());
        expect(ranges.map((r) => r.toString())).toEqual(['Visible']);
    });

    it('omits whitespace-only text nodes', () => {
        stubRangeClientRects();
        stubComputedStyle();
        setupDOM('<p>   </p><span>\n\t</span><p>Real</p>');
        const ranges = collectVisibleTextRanges(root());
        expect(ranges.map((r) => r.toString())).toEqual(['Real']);
    });

    it('omits text whose range has no non-empty rect', () => {
        stubRangeClientRects();
        stubComputedStyle();
        setupDOM('<p style="width:0;height:0">Zero size text</p><p>Real</p>');
        const ranges = collectVisibleTextRanges(root());
        expect(ranges.map((r) => r.toString())).toEqual(['Real']);
    });

    it('swallows getClientRects errors for navigated frame ranges and keeps going', () => {
        stubRangeClientRects('p.gone');
        stubComputedStyle();
        setupDOM('<p class="gone">Vanished frame text</p><p>Stable</p>');
        const ranges = collectVisibleTextRanges(root());
        expect(ranges.map((r) => r.toString())).toEqual(['Stable']);
    });

    it('returns an empty array for an empty root', () => {
        stubRangeClientRects();
        stubComputedStyle();
        setupDOM('');
        expect(collectVisibleTextRanges(root())).toEqual([]);
    });
});

// ── hasOrdinaryText ───────────────────────────────────────────────────────────

describe('hasOrdinaryText', () => {
    it('is true for ordinary text', () => {
        setupDOM('<p>Hello world</p>');
        expect(hasOrdinaryText(root())).toBe(true);
    });

    it('is false for whitespace-only text', () => {
        setupDOM('<p>   \n\t</p>');
        expect(hasOrdinaryText(root())).toBe(false);
    });

    it('is false for only script/style/noscript/template content', () => {
        setupDOM('<script>var x = 1;</script><style>.a{}</style><noscript>fallback</noscript><template>tmpl</template>');
        expect(hasOrdinaryText(root())).toBe(false);
    });

    it('skips text inside excluded elements even when nested (closest() semantics)', () => {
        setupDOM('<div><div><template>nope</template><script>code()</script></div></div>');
        expect(hasOrdinaryText(root())).toBe(false);
    });

    it('is true when any non-excluded text exists alongside excluded content', () => {
        setupDOM('<script>var x = 1;</script><style>.a{}</style><p>Real content</p>');
        expect(hasOrdinaryText(root())).toBe(true);
    });

    it('honors a custom excludedTags set', () => {
        setupDOM('<code>not content</code><p>Real</p>');
        expect(hasOrdinaryText(root(), new Set(['CODE']))).toBe(true);
        setupDOM('<code>not content</code>');
        expect(hasOrdinaryText(root(), new Set(['CODE']))).toBe(false);
    });

    it('is false for an empty document', () => {
        setupDOM('');
        expect(hasOrdinaryText(root())).toBe(false);
    });
});

// EXCLUDED_TEXT_ANCESTORS is exported for reuse
describe('exported constants', () => {
    it('EXCLUDED_TEXT_ANCESTORS matches the standard set', () => {
        expect(EXCLUDED_TEXT_ANCESTORS).toBe('script,style,noscript,template');
    });
});
