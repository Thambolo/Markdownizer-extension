/**
 * Shared DOM traversal utilities used by the content preview, the iframe
 * preview, and the extraction eligibility checks.
 */

export const EXCLUDED_TEXT_ANCESTORS = 'script,style,noscript,template';
export const BOXED_ANCESTORS = 'button,input,select,textarea';

/**
 * Check if an element is effectively hidden, either by its own styles/attributes
 * or by any ancestor up to (but not including) the root boundary.
 * Returns true if the element or any ancestor has:
 * - `hidden` attribute
 * - `display: none`
 * - `visibility: hidden` or `visibility: collapse`
 * - `opacity: 0`
 */
export function isHiddenInTree(el: Element, boundary: Element, view: Window): boolean {
    let current: Element | null = el;
    while (current && current !== boundary) {
        if (current.hasAttribute('hidden')) return true;
        const style = view.getComputedStyle(current);
        if (style.display === 'none') return true;
        if (style.visibility === 'hidden' || style.visibility === 'collapse') return true;
        if (parseFloat(style.opacity) === 0) return true;
        current = current.parentElement;
    }
    return false;
}

/**
 * Check if a DOMRectList or DOMRect[] contains at least one non-empty rect
 * (width > 0 and height > 0).
 */
export function hasNonEmptyRect(rects: DOMRectList | DOMRect[]): boolean {
    for (let i = 0; i < rects.length; i++) {
        const rect = rects[i];
        if (rect.width > 0 && rect.height > 0) {
            return true;
        }
    }
    return false;
}

export interface CollectVisibleTextRangesOptions {
    excludedSelector?: string;
    boxedSelector?: string;
    view?: Window;
    requireVisibleRect?: boolean;
}

/**
 * Collect a range for every visible text node inside `root`, skipping:
 *
 * - empty / whitespace-only text
 * - text inside excluded ancestors (script, style, noscript, template by default)
 * - text inside boxed ancestors (button, input, select, textarea by default)
 * - text in hidden elements (hidden attr / display:none / visibility:hidden|
 *   collapse / opacity:0)
 * - text whose range has no non-empty client rect (unless `requireVisibleRect`
 *   is false)
 *
 * Range rect reads are guarded against frame navigation throwing mid-collection.
 */
export function collectVisibleTextRanges(
    root: HTMLElement,
    options: CollectVisibleTextRangesOptions = {},
): Range[] {
    const excludedSelector = options.excludedSelector ?? EXCLUDED_TEXT_ANCESTORS;
    const boxedSelector = options.boxedSelector ?? BOXED_ANCESTORS;
    const view = options.view ?? root.ownerDocument.defaultView ?? window;
    const requireVisibleRect = options.requireVisibleRect ?? true;
    const ownerDocument = root.ownerDocument;

    const ranges: Range[] = [];
    const walker = ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            // Skip empty/whitespace-only text
            const text = node.textContent;
            if (!text || text.trim().length === 0) {
                return NodeFilter.FILTER_REJECT;
            }
            const parent = node.parentElement;
            if (!parent) {
                return NodeFilter.FILTER_REJECT;
            }
            // Skip text inside excluded ancestors
            if (parent.closest(excludedSelector)) {
                return NodeFilter.FILTER_REJECT;
            }
            // Skip text inside boxed ancestors (button, input, select, textarea)
            if (parent.closest(boxedSelector)) {
                return NodeFilter.FILTER_REJECT;
            }
            // Skip text in hidden elements (hidden attr, display:none,
            // visibility:hidden/collapse, opacity:0)
            if (isHiddenInTree(parent, root, view)) {
                return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        },
    });

    let textNode: Text | null;
    while ((textNode = walker.nextNode() as Text | null)) {
        const range = ownerDocument.createRange();
        range.selectNodeContents(textNode);
        if (!requireVisibleRect) {
            ranges.push(range);
            continue;
        }
        try {
            if (hasNonEmptyRect(range.getClientRects())) {
                ranges.push(range);
            }
        } catch {
            // A frame can navigate while ranges are being collected.
        }
    }
    return ranges;
}

const DEFAULT_EXCLUDED_TAGS: ReadonlySet<string> = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

/**
 * Return true when `root` contains at least one non-whitespace text node
 * outside the excluded elements (script, style, noscript, template by default).
 * An ancestor walk (equivalent to `parent.closest(excludedTags)`) skips text
 * nested anywhere inside an excluded subtree.
 */
export function hasOrdinaryText(root: Node, excludedTags?: ReadonlySet<string>): boolean {
    const doc = root.ownerDocument ?? document;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const tags = excludedTags ?? DEFAULT_EXCLUDED_TAGS;
    let node: Node | null;
    while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (!parent) continue;
        let current: Element | null = parent;
        let excluded = false;
        while (current) {
            if (tags.has(current.tagName)) {
                excluded = true;
                break;
            }
            current = current.parentElement;
        }
        if (excluded) continue;
        if (node.textContent?.trim()) return true;
    }
    return false;
}
