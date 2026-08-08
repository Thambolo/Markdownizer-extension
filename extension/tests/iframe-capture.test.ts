// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import {
    IFRAME_MAX_DEPTH,
    IFRAME_MAX_COUNT,
    createIframeBudget,
    readSameOriginFrame,
    iframeLabel,
    hasEligibleIframesLightweight,
} from '../src/iframe-capture';

// Mock owner document for tests that don't need JSDOM
const mockOwnerDoc = { baseURI: 'https://example.com/' } as unknown as Document;

// Helper to create a minimal HTMLIFrameElement mock
function createMockIframe(options: {
    title?: string;
    src?: string;
    contentDocument?: Document | null;
    ownerDocument?: Document;
} = {}): HTMLIFrameElement {
    const iframe = {
        tagName: 'IFRAME',
        title: options.title ?? '',
        src: options.src ?? '',
        ownerDocument: options.ownerDocument ?? mockOwnerDoc,
        // contentDocument will be defined via getter
    } as unknown as HTMLIFrameElement;

    // Define contentDocument as a getter that can be mocked per test
    Object.defineProperty(iframe, 'contentDocument', {
        get: () => options.contentDocument,
        configurable: true,
    });

    return iframe;
}

describe('iframe-capture constants', () => {
    it('IFRAME_MAX_DEPTH is 3', () => {
        expect(IFRAME_MAX_DEPTH).toBe(3);
    });

    it('IFRAME_MAX_COUNT is 20', () => {
        expect(IFRAME_MAX_COUNT).toBe(20);
    });
});

describe('createIframeBudget', () => {
    it('returns a budget with count 0 and maxCount/maxDepth set', () => {
        const budget = createIframeBudget();
        expect(budget.count).toBe(0);
        expect(budget.maxCount).toBe(IFRAME_MAX_COUNT);
        expect(budget.maxDepth).toBe(IFRAME_MAX_DEPTH);
    });

    it('maxCount and maxDepth are readonly', () => {
        const budget = createIframeBudget();
        // TypeScript would catch this at compile time, but we can test runtime
        expect(() => {
            // Cast to a type that allows writing to test runtime immutability
            (budget as { maxCount: number }).maxCount = 10;
        }).toThrow();
        expect(() => {
            (budget as { maxDepth: number }).maxDepth = 5;
        }).toThrow();
    });
});

describe('readSameOriginFrame', () => {
    it('returns null when contentDocument is null', () => {
        const iframe = createMockIframe({ contentDocument: null });
        expect(readSameOriginFrame(iframe)).toBeNull();
    });

    it('returns null when contentDocument access throws SecurityError', () => {
        const iframe = createMockIframe();
        // Override contentDocument getter to throw
        Object.defineProperty(iframe, 'contentDocument', {
            get: () => {
                throw new DOMException('Blocked a frame with origin "null"', 'SecurityError');
            },
            configurable: true,
        });
        expect(readSameOriginFrame(iframe)).toBeNull();
    });

    it('returns null when contentDocument access throws generic Error', () => {
        const iframe = createMockIframe();
        Object.defineProperty(iframe, 'contentDocument', {
            get: () => {
                throw new Error('some other error');
            },
            configurable: true,
        });
        expect(readSameOriginFrame(iframe)).toBeNull();
    });

    it('returns the document when contentDocument is accessible', () => {
        const doc = { URL: 'https://example.com/frame.html' } as unknown as Document;
        const iframe = createMockIframe({ contentDocument: doc });
        expect(readSameOriginFrame(iframe)).toBe(doc);
    });
});

describe('iframeLabel', () => {
    function makeDoc(title: string, url: string): Document {
        return {
            title,
            URL: url,
        } as unknown as Document;
    }

    it('prefers iframe title over document title', () => {
        const iframe = createMockIframe({ title: 'Iframe Title' });
        const doc = makeDoc('Doc Title', 'https://example.com/');
        expect(iframeLabel(iframe, doc)).toBe('Iframe Title');
    });

    it('falls back to document title when iframe title is empty', () => {
        const iframe = createMockIframe({ title: '' });
        const doc = makeDoc('Doc Title', 'https://example.com/');
        expect(iframeLabel(iframe, doc)).toBe('Doc Title');
    });

    it('falls back to absolute URL when both titles are empty', () => {
        const iframe = createMockIframe({ title: '' });
        const doc = makeDoc('', 'https://example.com/page');
        expect(iframeLabel(iframe, doc)).toBe('https://example.com/page');
    });

    it('uses URL resolution relative to ownerDocument baseURI', () => {
        const iframe = createMockIframe({
            title: '',
            ownerDocument: { baseURI: 'https://example.com/base/' } as unknown as Document,
        });
        const doc = makeDoc('', 'relative/path');
        expect(iframeLabel(iframe, doc)).toBe('https://example.com/base/relative/path');
    });

    it('skips about:blank URL', () => {
        const iframe = createMockIframe({ title: '' });
        const doc = makeDoc('', 'about:blank');
        expect(iframeLabel(iframe, doc)).toBe('Embedded content');
    });

    it('skips empty URL', () => {
        const iframe = createMockIframe({ title: '' });
        const doc = makeDoc('', '');
        expect(iframeLabel(iframe, doc)).toBe('Embedded content');
    });

    it('returns "Embedded content" when both titles are empty and URL is about:blank', () => {
        const iframe = createMockIframe({ title: '' });
        const doc = makeDoc('', 'about:blank');
        expect(iframeLabel(iframe, doc)).toBe('Embedded content');
    });

    it('uses document title when iframe title is whitespace only', () => {
        const iframe = createMockIframe({ title: '   ' });
        const doc = makeDoc('Doc Title', 'https://example.com/');
        expect(iframeLabel(iframe, doc)).toBe('Doc Title');
    });

    it('uses absolute URL when iframe title is empty and document title is empty', () => {
        const iframe = createMockIframe({ title: '' });
        const doc = makeDoc('', 'https://example.com/path?query=value#hash');
        expect(iframeLabel(iframe, doc)).toBe('https://example.com/path?query=value#hash');
    });
});

describe('budget accounting with depth-first traversal', () => {
    // Simulates a depth-first traversal of iframes
    function traverseDepthFirst(
        iframes: HTMLIFrameElement[],
        budget: ReturnType<typeof createIframeBudget>,
        currentDepth: number = 0
    ): HTMLIFrameElement[] {
        const visited: HTMLIFrameElement[] = [];
        for (const iframe of iframes) {
            if (budget.count >= budget.maxCount) break;
            if (currentDepth > budget.maxDepth) continue; // skip beyond max depth
            // Simulate reading the frame (increment count)
            budget.count++;
            visited.push(iframe);
            // In real code, would recursively traverse nested iframes
        }
        return visited;
    }

    it('skips the 21st frame when maxCount is 20', () => {
        const budget = createIframeBudget();
        const iframes = Array.from({ length: 25 }, (_, i) =>
            createMockIframe({ title: `Frame ${i + 1}` })
        );
        const visited = traverseDepthFirst(iframes, budget);
        expect(visited.length).toBe(20);
        expect(budget.count).toBe(20);
    });

    it('preserves depth-first order within budget', () => {
        const budget = createIframeBudget();
        const iframes = Array.from({ length: 10 }, (_, i) =>
            createMockIframe({ title: `Frame ${i + 1}` })
        );
        const visited = traverseDepthFirst(iframes, budget);
        expect(visited.map(f => f.title)).toEqual([
            'Frame 1', 'Frame 2', 'Frame 3', 'Frame 4', 'Frame 5',
            'Frame 6', 'Frame 7', 'Frame 8', 'Frame 9', 'Frame 10',
        ]);
    });

    it('respects depth limit', () => {
        const budget = createIframeBudget();
        const iframes = Array.from({ length: 5 }, (_, i) =>
            createMockIframe({ title: `Frame ${i + 1}` })
        );
        // At depth 3 (maxDepth), frames are still eligible (depth 3 beneath top)
        const visited = traverseDepthFirst(iframes, budget, 3);
        expect(visited.length).toBe(5); // all 5 frames visited at depth 3
    });

    it('does not visit frames beyond depth limit', () => {
        const budget = createIframeBudget();
        const iframes = Array.from({ length: 10 }, (_, i) =>
            createMockIframe({ title: `Frame ${i + 1}` })
        );
        // At depth 4 (beyond maxDepth=3), no frames should be visited
        const visited = traverseDepthFirst(iframes, budget, 4);
        expect(visited.length).toBe(0);
    });

    it('sibling frames before the 21st keep DOM order', () => {
        const budget = createIframeBudget();
        const iframes = Array.from({ length: 20 }, (_, i) =>
            createMockIframe({ title: `Sibling ${i + 1}` })
        );
        const visited = traverseDepthFirst(iframes, budget);
        expect(visited.length).toBe(20);
        expect(visited.map(f => f.title)).toEqual(
            Array.from({ length: 20 }, (_, i) => `Sibling ${i + 1}`)
        );
    });
});

// ── hasEligibleIframesLightweight tests ─────────────────────────────────────

// Stub for getComputedStyle with pseudo-element support
function stubGetComputedStyleForIframes(): { restore: () => void; spy: ReturnType<typeof vi.fn> } {
    const orig = window.getComputedStyle;
    const spy = vi.fn((elt: Element, pseudo?: string | null) => {
        const htmlElt = elt as HTMLElement;
        return {
            get content() {
                // For generated-text-only iframes, return quoted string for ::before
                if (pseudo === '::before' && htmlElt.dataset?.pseudoBefore) {
                    return htmlElt.dataset.pseudoBefore;
                }
                if (pseudo === '::after' && htmlElt.dataset?.pseudoAfter) {
                    return htmlElt.dataset.pseudoAfter;
                }
                return 'none';
            },
            get display() {
                if (htmlElt.style.display === 'none') return 'none';
                const tag = htmlElt.tagName.toLowerCase();
                if (['div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'main', 'article', 'aside', 'nav', 'header', 'footer', 'blockquote', 'pre', 'ul', 'ol', 'li', 'table', 'form', 'fieldset', 'details', 'summary', 'img'].includes(tag)) {
                    return tag === 'img' ? 'inline' : 'block';
                }
                if (tag === 'span') return 'inline';
                return 'inline';
            },
            get visibility() { return 'visible'; },
            get opacity() { return '1'; },
            get contentVisibility() { return 'visible'; },
        } as unknown as CSSStyleDeclaration;
    });
    window.getComputedStyle = spy as unknown as typeof window.getComputedStyle;
    return { restore: () => { window.getComputedStyle = orig; }, spy };
}

describe('hasEligibleIframesLightweight', () => {
    afterEach(() => {
        document.body.replaceChildren();
    });

    it('returns true for an iframe with ordinary non-whitespace text', () => {
        const { restore } = stubGetComputedStyleForIframes();
        try {
            document.body.innerHTML = '<div id="root"><iframe></iframe></div>';
            const iframe = document.querySelector('iframe') as HTMLIFrameElement;
            const frameDoc = new DOMParser().parseFromString(
                '<html><body><p>Hello world</p></body></html>',
                'text/html',
            );
            Object.defineProperty(iframe, 'contentDocument', {
                configurable: true,
                get: () => frameDoc,
            });

            expect(hasEligibleIframesLightweight(document.getElementById('root')!)).toBe(true);
        } finally {
            restore();
        }
    });

    it('returns false for an empty iframe (no text content)', () => {
        const { restore } = stubGetComputedStyleForIframes();
        try {
            document.body.innerHTML = '<div id="root"><iframe></iframe></div>';
            const iframe = document.querySelector('iframe') as HTMLIFrameElement;
            const frameDoc = new DOMParser().parseFromString(
                '<html><body></body></html>',
                'text/html',
            );
            Object.defineProperty(iframe, 'contentDocument', {
                configurable: true,
                get: () => frameDoc,
            });

            expect(hasEligibleIframesLightweight(document.getElementById('root')!)).toBe(false);
        } finally {
            restore();
        }
    });

    it('returns false when getComputedStyle is never called for ordinary-text iframes', () => {
        const { restore, spy } = stubGetComputedStyleForIframes();
        try {
            document.body.innerHTML = '<div id="root"><iframe></iframe></div>';
            const iframe = document.querySelector('iframe') as HTMLIFrameElement;
            const frameDoc = new DOMParser().parseFromString(
                '<html><body><p>Has real text</p></body></html>',
                'text/html',
            );
            Object.defineProperty(iframe, 'contentDocument', {
                configurable: true,
                get: () => frameDoc,
            });

            spy.mockClear();
            const result = hasEligibleIframesLightweight(document.getElementById('root')!);
            expect(result).toBe(true);
            // getComputedStyle should NOT be called when ordinary text exists
            expect(spy).not.toHaveBeenCalled();
        } finally {
            restore();
        }
    });

    it('returns true for a generated-only iframe using at most two pseudo-element reads per element', () => {
        const { restore, spy } = stubGetComputedStyleForIframes();
        try {
            document.body.innerHTML = '<div id="root"><iframe></iframe></div>';
            const iframe = document.querySelector('iframe') as HTMLIFrameElement;
            const frameDoc = new DOMParser().parseFromString(
                '<html><body><div class="gen"></div></body></html>',
                'text/html',
            );
            // Set pseudo data attribute so our stub returns generated content
            frameDoc.querySelector('.gen')!.setAttribute('data-pseudo-before', '"Generated text"');
            Object.defineProperty(iframe, 'contentDocument', {
                configurable: true,
                get: () => frameDoc,
            });

            spy.mockClear();
            const result = hasEligibleIframesLightweight(document.getElementById('root')!);
            expect(result).toBe(true);
            // At most 2 pseudo reads: ::before + ::after for the single element
            expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
        } finally {
            restore();
        }
    });

    it('returns false for a text-empty iframe with no generated pseudo content', () => {
        const { restore } = stubGetComputedStyleForIframes();
        try {
            document.body.innerHTML = '<div id="root"><iframe></iframe></div>';
            const iframe = document.querySelector('iframe') as HTMLIFrameElement;
            const frameDoc = new DOMParser().parseFromString(
                '<html><body><div class="empty"></div></body></html>',
                'text/html',
            );
            Object.defineProperty(iframe, 'contentDocument', {
                configurable: true,
                get: () => frameDoc,
            });

            expect(hasEligibleIframesLightweight(document.getElementById('root')!)).toBe(false);
        } finally {
            restore();
        }
    });

    it('skips non-content elements (script, style, noscript, template) when checking text', () => {
        const { restore } = stubGetComputedStyleForIframes();
        try {
            document.body.innerHTML = '<div id="root"><iframe></iframe></div>';
            const iframe = document.querySelector('iframe') as HTMLIFrameElement;
            const frameDoc = new DOMParser().parseFromString(
                '<html><body><script>var x = 1;</script><style>.foo{}</style><p>Real text</p></body></html>',
                'text/html',
            );
            Object.defineProperty(iframe, 'contentDocument', {
                configurable: true,
                get: () => frameDoc,
            });

            expect(hasEligibleIframesLightweight(document.getElementById('root')!)).toBe(true);
        } finally {
            restore();
        }
    });

    it('returns false when no iframes are present in the root', () => {
        const { restore } = stubGetComputedStyleForIframes();
        try {
            document.body.innerHTML = '<div id="root"><p>No iframes here</p></div>';
            expect(hasEligibleIframesLightweight(document.getElementById('root')!)).toBe(false);
        } finally {
            restore();
        }
    });

    it('returns false for a cross-origin iframe (contentDocument is null)', () => {
        const { restore } = stubGetComputedStyleForIframes();
        try {
            document.body.innerHTML = '<div id="root"><iframe src="https://other.example.com"></iframe></div>';
            const iframe = document.querySelector('iframe') as HTMLIFrameElement;
            // contentDocument is null for cross-origin
            Object.defineProperty(iframe, 'contentDocument', {
                configurable: true,
                get: () => null,
            });

            expect(hasEligibleIframesLightweight(document.getElementById('root')!)).toBe(false);
        } finally {
            restore();
        }
    });

    it('does not call cloneNode on any element', () => {
        const { restore } = stubGetComputedStyleForIframes();
        try {
            document.body.innerHTML = '<div id="root"><iframe></iframe></div>';
            const iframe = document.querySelector('iframe') as HTMLIFrameElement;
            const frameDoc = new DOMParser().parseFromString(
                '<html><body><p>Text</p></body></html>',
                'text/html',
            );
            Object.defineProperty(iframe, 'contentDocument', {
                configurable: true,
                get: () => frameDoc,
            });

            const cloneSpy = vi.spyOn(frameDoc.body!, 'cloneNode');
            hasEligibleIframesLightweight(document.getElementById('root')!);
            expect(cloneSpy).not.toHaveBeenCalled();
        } finally {
            restore();
        }
    });
});
describe('hasImagesInRoot', () => {
    let hasImagesInRoot: (root: HTMLElement, includeIframes?: boolean) => boolean;

    beforeEach(async () => {
        vi.resetModules();
        const mod = await import('../src/iframe-capture');
        hasImagesInRoot = mod.hasImagesInRoot;
    });

    it('returns false for an empty root', () => {
        const root = document.createElement('div');
        expect(hasImagesInRoot(root)).toBe(false);
    });

    it('returns true for an img with a non-empty src', () => {
        const root = document.createElement('div');
        root.innerHTML = '<img src="https://example.com/a.png">';
        expect(hasImagesInRoot(root)).toBe(true);
    });

    it('skips imgs with an empty src', () => {
        const root = document.createElement('div');
        root.innerHTML = '<img src="">';
        expect(hasImagesInRoot(root)).toBe(false);
    });

    it('skips blob: URLs (unfetchable from the popup)', () => {
        const root = document.createElement('div');
        root.innerHTML = '<img src="blob:https://example.com/uuid">';
        expect(hasImagesInRoot(root)).toBe(false);
    });

    it('skips confirmed 1x1 tracking pixels', () => {
        const root = document.createElement('div');
        const img = document.createElement('img');
        img.src = 'https://example.com/pixel.gif';
        Object.defineProperty(img, 'complete', { value: true });
        Object.defineProperty(img, 'naturalWidth', { value: 1 });
        Object.defineProperty(img, 'naturalHeight', { value: 1 });
        root.appendChild(img);
        expect(hasImagesInRoot(root)).toBe(false);
    });

    it('counts not-yet-loaded imgs (naturalWidth 0) as eligible', () => {
        const root = document.createElement('div');
        const img = document.createElement('img');
        img.src = 'https://example.com/photo.jpg';
        Object.defineProperty(img, 'complete', { value: false });
        Object.defineProperty(img, 'naturalWidth', { value: 0 });
        Object.defineProperty(img, 'naturalHeight', { value: 0 });
        root.appendChild(img);
        expect(hasImagesInRoot(root)).toBe(true);
    });

    it('returns true when only some imgs are usable', () => {
        const root = document.createElement('div');
        root.innerHTML = '<img src="blob:x"><img src="https://example.com/b.png">';
        expect(hasImagesInRoot(root)).toBe(true);
    });

    // ── Same-origin iframe content ─────────────────────────────────────────

    /** Create a root with an iframe whose contentDocument is a parsed doc. */
    function createRootWithFrame(html: string, frameBodyHtml: string): { root: HTMLElement; iframe: HTMLIFrameElement } {
        const root = document.createElement('div');
        root.innerHTML = html;
        const iframe = root.querySelector('iframe') as HTMLIFrameElement;
        const frameDoc = new DOMParser().parseFromString(
            `<html><body>${frameBodyHtml}</body></html>`,
            'text/html',
        );
        Object.defineProperty(iframe, 'contentDocument', {
            configurable: true,
            get: () => frameDoc,
        });
        return { root, iframe };
    }

    it('returns true for an image inside a same-origin iframe when includeIframes is true', () => {
        const { root } = createRootWithFrame(
            '<iframe></iframe>',
            '<img src="https://example.com/frame.png">',
        );
        expect(hasImagesInRoot(root, true)).toBe(true);
    });

    it('does not count images inside same-origin iframes when includeIframes is false (default)', () => {
        const { root } = createRootWithFrame(
            '<iframe></iframe>',
            '<img src="https://example.com/frame.png">',
        );
        // Frame images never reach the Markdown when iframes are excluded
        expect(hasImagesInRoot(root)).toBe(false);
        expect(hasImagesInRoot(root, false)).toBe(false);
    });

    it('counts root images regardless of includeIframes', () => {
        const { root } = createRootWithFrame(
            '<img src="https://example.com/root.png"><iframe></iframe>',
            '<img src="https://example.com/frame.png">',
        );
        expect(hasImagesInRoot(root)).toBe(true);
        expect(hasImagesInRoot(root, false)).toBe(true);
        expect(hasImagesInRoot(root, true)).toBe(true);
    });

    it('returns false when the image is only in an unreadable (cross-origin) iframe', () => {
        const root = document.createElement('div');
        root.innerHTML = '<iframe src="https://other.example.com"></iframe>';
        const iframe = root.querySelector('iframe') as HTMLIFrameElement;
        // Cross-origin frames expose no contentDocument
        Object.defineProperty(iframe, 'contentDocument', {
            configurable: true,
            get: () => null,
        });
        // Even with includeIframes on, an unreadable frame contributes nothing
        expect(hasImagesInRoot(root)).toBe(false);
        expect(hasImagesInRoot(root, true)).toBe(false);
    });

    it('returns false for blob-only images inside a same-origin frame', () => {
        const { root } = createRootWithFrame(
            '<iframe></iframe>',
            '<img src="blob:https://example.com/uuid">',
        );
        expect(hasImagesInRoot(root, true)).toBe(false);
    });

    it('returns true when the root and a frame both contribute images', () => {
        const { root } = createRootWithFrame(
            '<img src="https://example.com/root.png"><iframe></iframe>',
            '<img src="https://example.com/frame.png">',
        );
        expect(hasImagesInRoot(root)).toBe(true);
    });

    it('returns true for an image in a nested same-origin frame', () => {
        const { root, iframe } = createRootWithFrame('<iframe></iframe>', '<iframe></iframe>');
        const nestedFrame = iframe.contentDocument!.querySelector('iframe') as HTMLIFrameElement;
        const nestedDoc = new DOMParser().parseFromString(
            '<html><body><img src="https://example.com/deep.png"></body></html>',
            'text/html',
        );
        Object.defineProperty(nestedFrame, 'contentDocument', {
            configurable: true,
            get: () => nestedDoc,
        });
        expect(hasImagesInRoot(root, true)).toBe(true);
    });

    it('respects the iframe count budget across frames', () => {
        // 21 readable frames, each containing an image: only the first 20 are
        // inspected, so the 21st's image must not flip the result.
        const root = document.createElement('div');
        for (let i = 0; i < IFRAME_MAX_COUNT + 1; i += 1) {
            const frame = document.createElement('iframe');
            const frameDoc = new DOMParser().parseFromString(
                i === IFRAME_MAX_COUNT
                    ? '<html><body><img src="https://example.com/budgeted.png"></body></html>'
                    : '<html><body></body></html>',
                'text/html',
            );
            Object.defineProperty(frame, 'contentDocument', {
                configurable: true,
                get: () => frameDoc,
            });
            root.appendChild(frame);
        }
        // The only image lives in the 21st frame — beyond the budget.
        expect(hasImagesInRoot(root, true)).toBe(false);
    });
});
