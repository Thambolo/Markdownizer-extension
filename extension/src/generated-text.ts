// Generated-text recovery
//
// Some pages render meaningful text through CSS pseudo-elements rather than DOM text
// nodes. The existing skeletonizer and Go converter cannot see that content because it
// walks only DOM text. This module recovers high-confidence computed ::before and ::after
// text from the live page, inserts it as normal text nodes in the clone, and leaves the
// original DOM untouched. The recovered text then flows through the standard tokenization,
// backend conversion, and local rehydration pipeline.
//
// Safety rules:
// - Only a single quoted computed string of 1 to 4,096 characters is accepted.
// - Unsupported CSS content values are rejected (none, normal, quotes, counters, url).
// - Conflicting clone text is removed only when a Range over the source text has no
//   non-zero client rects, proving the original text has no visible layout.

export type Pseudo = '::before' | '::after';

export interface ComputedStyleReader {
    content(element: HTMLElement, pseudo: Pseudo): string;
    textHasVisibleLayout(text: Text): boolean;
}

const MAX_GENERATED_TEXT_LENGTH = 4096;

// CSS computed content values that are not recoverable as plain text.
const UNSUPPORTED_CONTENT = /^(none|normal|open-quote|close-quote|no-open-quote|no-close-quote|url\(|counter\(|counters\()/i;

// Matches a single quoted string: "..." or '...'. Captures the inner text.
const QUOTED_CONTENT = /^(['"])((?:\\.|(?!\1)[\s\S])*)\1$/;

// Production reader that uses the browser's computed style engine.
const browserReader: ComputedStyleReader = {
    content(element, pseudo) {
        if (typeof window === 'undefined') return 'none';
        return element.ownerDocument.defaultView!.getComputedStyle(element, pseudo).content;
    },
    textHasVisibleLayout(text) {
        const range = text.ownerDocument.createRange();
        range.selectNodeContents(text);
        return Array.from(range.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);
    },
};

// Parse a CSS computed content string into recoverable text.
// Returns null for unsupported, empty, over-limit, or malformed values.
export function parseGeneratedContent(content: string): string | null {
    const value = content.trim();
    if (value.length === 0 || UNSUPPORTED_CONTENT.test(value)) return null;
    const match = value.match(QUOTED_CONTENT);
    if (!match) return null;

    const text = match[2].replace(/\\([\\"'])/g, '$1');
    if (text.trim().length === 0 || text.length > MAX_GENERATED_TEXT_LENGTH) return null;
    return text;
}

// Recover computed pseudo-element text from the live source root and insert it into
// the clone. Each source element is paired with its same-position clone by preorder
// traversal. If element counts differ (e.g. DOM changed between clone and read), the
// function bails out without modifying the clone.
//
export function recoverGeneratedText(sourceRoot: HTMLElement, cloneRoot: HTMLElement, reader = browserReader): void {
    const sourceElements = [sourceRoot, ...Array.from(sourceRoot.querySelectorAll<HTMLElement>('*'))];
    const cloneElements = [cloneRoot, ...Array.from(cloneRoot.querySelectorAll<HTMLElement>('*'))];
    if (sourceElements.length !== cloneElements.length) return;

    sourceElements.forEach((source, index) => {
        const clone = cloneElements[index];
        const before = parseGeneratedContent(reader.content(source, '::before'));
        const after = parseGeneratedContent(reader.content(source, '::after'));
        const generated = [before, after].filter((value): value is string => value !== null);

        if (generated.length === 0) return;

        // Remove conflicting hidden clone text before inserting generated nodes,
        // so the generated value takes the text-node slot cleanly.
        if (generated.length === 1) replaceHiddenText(source, clone, reader);
        if (generated.length === 1 && source.childElementCount === 0 && !source.textContent?.trim()) {
            clone.replaceWith(source.ownerDocument!.createTextNode(generated[0]));
            return;
        }
        if (before !== null) clone.insertBefore(source.ownerDocument!.createTextNode(before), clone.firstChild);
        if (after !== null) clone.appendChild(source.ownerDocument!.createTextNode(after));
    });
}

// Remove the sole visible text node from the clone when the corresponding source
// text has no visible layout (all client rects are zero-area). This supports the
// common CSS swap pattern where generated content replaces a visually suppressed
// DOM value.
function replaceHiddenText(source: HTMLElement, clone: HTMLElement, reader: ComputedStyleReader): void {
    const sourceTextNodes = Array.from(source.childNodes).flatMap(collectNonEmptyTextNodes);
    if (sourceTextNodes.length !== 1 || reader.textHasVisibleLayout(sourceTextNodes[0])) return;

    const cloneTextNodes = Array.from(clone.childNodes).flatMap(collectNonEmptyTextNodes);
    if (cloneTextNodes.length !== 1 || cloneTextNodes[0].textContent !== sourceTextNodes[0].textContent) return;
    cloneTextNodes[0].remove();
}

// Collect all non-empty text nodes reachable from a given node.
function collectNonEmptyTextNodes(node: Node): Text[] {
    if (node.nodeType === node.TEXT_NODE) {
        return node.textContent?.trim() ? [node as Text] : [];
    }
    return Array.from(node.childNodes).flatMap(collectNonEmptyTextNodes);
}
