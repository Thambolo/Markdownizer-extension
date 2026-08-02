/**
 * Iframe capture helpers for deterministic eligibility and expansion.
 */

export const IFRAME_MAX_DEPTH = 3;
export const IFRAME_MAX_COUNT = 20;

export interface IframeBudget {
    count: number;
    readonly maxCount: number;
    readonly maxDepth: number;
}

export type IframeSanitizer = (
    sourceRoot: HTMLElement,
    budget: IframeBudget,
    frameDepth: number,
    framePath?: number[],
) => HTMLElement | null;

export function createIframeBudget(): IframeBudget {
    const budget = { count: 0, maxCount: IFRAME_MAX_COUNT, maxDepth: IFRAME_MAX_DEPTH } as IframeBudget;
    // Freeze maxCount and maxDepth to enforce readonly at runtime
    Object.defineProperty(budget, 'maxCount', { writable: false });
    Object.defineProperty(budget, 'maxDepth', { writable: false });
    return budget;
}

/**
 * Compute the child-index path from `document.body` to `element`.
 * Each entry is the zero-based index of the element among its
 * parent's child elements. Returns an empty array if element
 * is body itself or not reachable from body.
 */
export function bodyRelativePath(element: Element): number[] {
    const path: number[] = [];
    let current: Element | null = element;
    while (current && current !== current.ownerDocument.body) {
        const parent = current.parentElement;
        if (!parent) break;
        const siblings = parent.children;
        const index = Array.from(siblings).indexOf(current);
        if (index >= 0) path.unshift(index);
        current = parent;
    }
    return path;
}

/**
 * Read a same-origin iframe's document, returning null on cross-origin, opaque, or any error.
 */
export function readSameOriginFrame(iframe: HTMLIFrameElement): Document | null {
    try {
        const doc = iframe.contentDocument;
        return doc;
    } catch {
        return null;
    }
}

/**
 * Produce a human-readable label for an iframe, prioritizing:
 * 1. iframe title
 * 2. embedded document title
 * 3. absolute document URL (excluding about:blank)
 * 4. fallback "Embedded content"
 */
export function iframeLabel(iframe: HTMLIFrameElement, frameDocument: Document): string {
    // 1. iframe title (if non-empty after trimming)
    const iframeTitle = iframe.title?.trim();
    if (iframeTitle) return iframeTitle;

    // 2. embedded document title
    const docTitle = frameDocument.title?.trim();
    if (docTitle) return docTitle;

    // 3. absolute document URL (excluding about:blank and empty)
    const rawUrl = frameDocument.URL;
    if (rawUrl && rawUrl !== 'about:blank') {
        try {
            const base = iframe.ownerDocument?.baseURI ?? '';
            return new URL(rawUrl, base).href;
        } catch {
            // invalid URL, fall through
        }
    }

    // 4. fallback
    return 'Embedded content';
}

/**
 * Replace readable iframe elements in a clone with labeled, sanitized sections.
 * The source tree is read-only; all replacements happen in cloneRoot.
 */
export function expandSameOriginIframes(
    sourceRoot: HTMLElement,
    cloneRoot: HTMLElement,
    sanitize: IframeSanitizer,
    budget = createIframeBudget(),
    frameDepth = 1,
): void {
    if (frameDepth > budget.maxDepth || budget.count >= budget.maxCount) return;

    const sourceFrames = Array.from(sourceRoot.querySelectorAll<HTMLIFrameElement>('iframe'));
    const cloneFrames = Array.from(cloneRoot.querySelectorAll<HTMLIFrameElement>('iframe'));

    sourceFrames.forEach((sourceFrame, index) => {
        if (budget.count >= budget.maxCount || frameDepth > budget.maxDepth) return;
        const cloneFrame = cloneFrames[index];
        if (!cloneFrame) return;

        const frameDocument = readSameOriginFrame(sourceFrame);
        if (!frameDocument?.body) return;

        const framePath = bodyRelativePath(sourceFrame);
        budget.count += 1;
        const sanitizedFrame = sanitize(frameDocument.body, budget, frameDepth, framePath);
        if (!sanitizedFrame?.textContent?.trim()) return;

        const destinationDocument = cloneFrame.ownerDocument;
        const section = destinationDocument.createElement('section');
        const label = destinationDocument.createElement('p');
        const strong = destinationDocument.createElement('strong');
        const frameName = iframeLabel(sourceFrame, frameDocument);
        strong.textContent = frameName === 'Embedded content'
            ? frameName
            : `Embedded content: ${frameName}`;
        label.appendChild(strong);
        section.appendChild(label);

        for (const child of Array.from(sanitizedFrame.childNodes)) {
            section.appendChild(destinationDocument.importNode(child, true));
        }

        cloneFrame.replaceWith(section);
    });
}

/**
 * Return true when at least one readable iframe contains non-empty sanitized content.
 */
export function hasEligibleIframesInRoot(
    sourceRoot: HTMLElement,
    sanitize: IframeSanitizer,
): boolean {
    const budget = createIframeBudget();
    const sourceFrames = Array.from(sourceRoot.querySelectorAll<HTMLIFrameElement>('iframe'));

    for (const sourceFrame of sourceFrames) {
        if (budget.count >= budget.maxCount) break;
        const frameDocument = readSameOriginFrame(sourceFrame);
        if (!frameDocument?.body) continue;

        budget.count += 1;
        const sanitizedFrame = sanitize(frameDocument.body, budget, 1);
        if (sanitizedFrame?.textContent?.trim()) return true;
    }

    return false;
}

// ── Lightweight eligibility (no cloneNode / recoverGeneratedText / skeletonize) ─

const NON_CONTENT_ELEMENTS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

/**
 * Return true when the given element has ordinary non-whitespace text content,
 * skipping non-content elements. Uses a TreeWalker for efficiency.
 */
function hasOrdinaryText(root: Node): boolean {
    const doc = root.ownerDocument ?? document;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
        if (node.textContent?.trim()) {
            const parent = node.parentElement;
            if (parent && !NON_CONTENT_ELEMENTS.has(parent.tagName)) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Check pseudo-element content for recoverable generated text.
 * Returns true when `::before` or `::after` yields a single quoted string.
 * At most 2 getComputedStyle calls per element (::before + ::after).
 */
function hasGeneratedPseudoText(element: HTMLElement): boolean {
    const view = element.ownerDocument.defaultView ?? window;
    if (typeof view.getComputedStyle !== 'function') return false;

    for (const pseudo of ['::before', '::after'] as const) {
        const computed = view.getComputedStyle(element, pseudo);
        const content = computed.content;
        // Match a single quoted string: "..." or '...'
        const match = content.match(/^(['"])((?:\\.|(?!\1)[\s\S])*)\1$/);
        if (match && match[2].trim().length > 0) {
            return true;
        }
    }
    return false;
}

/**
 * Lightweight iframe eligibility check.
 * Traverses each readable frame body depth-first, skipping non-content elements.
 * Returns immediately when ordinary non-whitespace text is found.
 * Only for text-empty candidates, inspects ::before and ::after pseudo-elements
 * using a bounded generated-text-only predicate (at most 2 pseudo reads per element).
 * Does NOT call cloneNode, recoverGeneratedText, skeletonize, or serialization.
 */
export function hasEligibleIframesLightweight(sourceRoot: HTMLElement): boolean {
    const sourceFrames = Array.from(sourceRoot.querySelectorAll<HTMLIFrameElement>('iframe'));
    const budget = createIframeBudget();

    for (const sourceFrame of sourceFrames) {
        if (budget.count >= budget.maxCount) break;
        const frameDocument = readSameOriginFrame(sourceFrame);
        if (!frameDocument?.body) continue;

        budget.count += 1;

        // Fast path: ordinary text in the frame body
        if (hasOrdinaryText(frameDocument.body)) return true;

        // Slow path: text-empty body — check for generated pseudo content
        const elements = Array.from(frameDocument.body.querySelectorAll<HTMLElement>('*'));
        for (const el of elements) {
            if (NON_CONTENT_ELEMENTS.has(el.tagName)) continue;
            if (hasGeneratedPseudoText(el)) return true;
        }
    }

    return false;
}
