// logic.ts - Shared logic for the extension

import { normalizeRenderedReDoc } from './redoc-normalizer';
import { recoverGeneratedText } from './generated-text';
import { serializeNativeControls } from './native-controls';
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

class Skeletonizer {
    private tokens: TokenMap = {};
    private counter = 0;

    public process(root: HTMLElement): { html: string, tokens: TokenMap } {
        const clone = root.cloneNode(true) as HTMLElement;
        recoverGeneratedText(root, clone);
        serializeNativeControls(root, clone);
        normalizeRenderedReDoc(clone);
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
