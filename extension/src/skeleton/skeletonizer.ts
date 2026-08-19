// skeletonizer.ts - Shared logic for the extension

import { createSkeletonPipeline } from './pipeline';
import { normalizeRenderedReDoc } from './redoc-normalizer';
import { recoverGeneratedText } from './generated-text';
import { serializeNativeControls } from './native-controls';
import { compactSkeleton } from './compactor';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';

export const TOKEN_PREFIX = "{{MDZ";
export const TOKEN_SUFFIX = "}}";

export interface TokenMap {
    [key: string]: string;
}

interface MarkdownNode {
    type: string;
    value?: string;
    lang?: string | null;
    children?: MarkdownNode[];
}

/**
 * Skeletonize: Replaces all text nodes with tokens.
 * Returns the HTML string and the token map.
 */
export function skeletonize(root: HTMLElement): { html: string, tokens: TokenMap } {
    return new Skeletonizer().process(root);
}

// Shared transform sequence. Pipeline order is a deliberate contract:
// normalizeRenderedReDoc runs BEFORE serializeNativeControls so ReDoc
// operation buttons are normalized into semantic headings + server links
// instead of mdz-control markers (P4 fix). The order is locked by
// tests/skeleton-pipeline.test.ts + the redoc golden test.
//
// Wiring note: every SkeletonTransform receives (root, clone). The
// transform modules that only mutate the element they are passed
// (normalizeRenderedReDoc, compactSkeleton) are wrapped here so they
// operate on the CLONE — passing the bare module references would hand
// them the live source root instead and mutate the live page.
/** The production skeleton pipeline. Exported so tests lock the real order. */
export const SKELETON_PIPELINE = createSkeletonPipeline([
    recoverGeneratedText,
    (_root: HTMLElement, clone: HTMLElement) => { normalizeRenderedReDoc(clone); },
    serializeNativeControls,
    (_root: HTMLElement, clone: HTMLElement) => { compactSkeleton(clone); },
]);

class Skeletonizer {
    private tokens: TokenMap = {};
    private counter = 0;

    public process(root: HTMLElement): { html: string, tokens: TokenMap } {
        const clone = root.cloneNode(true) as HTMLElement;
        SKELETON_PIPELINE(root, clone);
        const walker = document.createTreeWalker(
            clone,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: (node) => {
                    if (!node.textContent || node.textContent.trim().length === 0) {
                        return NodeFilter.FILTER_SKIP;
                    }
                    if (['SCRIPT', 'STYLE'].includes(node.parentElement?.tagName || '')) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    return NodeFilter.FILTER_ACCEPT;
                }
            }
        );

        while (walker.nextNode()) {
            this.handleTextNode(walker.currentNode);
        }

        return { html: clone.outerHTML, tokens: this.tokens };
    }

    private handleTextNode(node: Node): void {
        const text = node.textContent || "";
        
        if (!isInsideCodeContext(node)) {
            this.processStandardText(node, text);
        } else {
            this.processCodeBlock(node, text);
        }
    }

    private processStandardText(node: Node, text: string): void {
        const tokenId = this.createToken(null);
        const leadingSpace = text.match(/^\s*/)?.[0] || "";
        const trailingSpace = text.match(/\s*$/)?.[0] || "";
        const trimmedText = text.trim();

        const cleanText = trimmedText.replace(/\s+/g, ' ');
        
        node.textContent = leadingSpace + tokenId + trailingSpace;
        this.tokens[tokenId] = cleanText;
    }

    private processCodeBlock(node: Node, text: string): void {
        let cleanText = text;
        if (isInsidePre(node)) {
            cleanText = cleanText.replace(/^\s*```+|```+\s*$/g, '');
        }

        // Split by newline to preserve indentation in Markdown.
        const lines = cleanText.split('\n');
        const lineTokens = lines.map((line) => this.createToken(line));
        node.textContent = lineTokens.join('\n');
    }

    private createToken(content: string | null): string {
        const id = `${TOKEN_PREFIX}${this.counter++}${TOKEN_SUFFIX}`;
        if (content !== null) {
            this.tokens[id] = content;
        }
        return id;
    }
}

function isInsideCodeContext(node: Node): boolean {
    let parent = node.parentElement;
    while (parent) {
        if (['PRE', 'CODE', 'SAMP', 'KBD', 'VAR', 'TT'].includes(parent.tagName)) {
            return true;
        }
        parent = parent.parentElement;
    }
    return false;
}

function isInsidePre(node: Node): boolean {
    let parent = node.parentElement;
    while (parent) {
        if (parent.tagName === 'PRE') {
            return true;
        }
        parent = parent.parentElement;
    }
    return false;
}

/**
 * Rehydrates backend Markdown by replacing tokens only in literal AST values.
 */
export function rehydrateMarkdown(markdown: string, tokenMap: TokenMap): string {
    const processor = remark().use(remarkGfm).use(remarkStringify);
    const tree = processor.parse(markdown) as unknown as MarkdownNode;
    replaceLiteralTokens(tree, tokenMap);
    return processor.stringify(tree as never);
}

function replaceLiteralTokens(node: MarkdownNode, tokenMap: TokenMap): void {
    if ((node.type === 'text' || node.type === 'inlineCode' || node.type === 'code') && node.value) {
        node.value = node.value.replace(/\{\{MDZ\d+\}\}/g, (token) => {
            if (Object.prototype.hasOwnProperty.call(tokenMap, token)) return tokenMap[token];
            return token;
        });
    }
    node.children?.forEach((child) => replaceLiteralTokens(child, tokenMap));
}
