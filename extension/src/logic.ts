// logic.ts - Shared logic for the extension

export const TOKEN_PREFIX = "{{MDZ";
export const TOKEN_SUFFIX = "}}";

export interface TokenMap {
    [key: string]: string;
}

/**
 * Skeletonize: Replaces all text nodes with tokens.
 * Returns the HTML string and the token map.
 */
export function skeletonize(root: HTMLElement): { html: string, tokens: TokenMap } {
    const tokens: TokenMap = {};
    let counter = 0;

    // Clone to avoid modifying the live DOM (if we passed a live reference)
    const clone = root.cloneNode(true) as HTMLElement;

    // TreeWalker is faster than recursion for DOM traversal
    const walker = document.createTreeWalker(
        clone,
        NodeFilter.SHOW_TEXT,
        {
            acceptNode: (node) => {
                // Skip empty whitespace nodes
                if (!node.textContent || node.textContent.trim().length === 0) {
                    return NodeFilter.FILTER_SKIP;
                }
                // Skip script/style content if it somehow got in
                if (['SCRIPT', 'STYLE'].includes(node.parentElement?.tagName || '')) {
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            }
        }
    );

    while (walker.nextNode()) {
        const node = walker.currentNode;
        const text = node.textContent || "";
        const tokenId = `${TOKEN_PREFIX}${counter}${TOKEN_SUFFIX}`;
        
        let cleanText = text;
        
        if (!isInsideCodeContext(node)) {
            // Keep leading/trailing whitespace outside the token to preserve formatting
            const leadingSpace = text.match(/^\s*/)?.[0] || "";
            const trailingSpace = text.match(/\s*$/)?.[0] || "";
            const trimmedText = text.trim();

            // Collapse internal whitespace and escape Markdown chars
            cleanText = escapeMarkdown(trimmedText.replace(/\s+/g, ' '));
            
            node.textContent = leadingSpace + tokenId + trailingSpace;
        } else {
            // We are inside a code block.
            // If it is a PRE block, strip existing Markdown fences to prevent double-fencing
            if (isInsidePre(node)) {
                cleanText = cleanText.replace(/^\s*```+|```+\s*$/g, '');
            }
            node.textContent = tokenId;
        }

        tokens[tokenId] = cleanText;
        counter++;
    }

    return { html: clone.outerHTML, tokens };
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
 * Escapes characters that have special meaning in Markdown.
 */
function escapeMarkdown(text: string): string {
    // List of chars to escape: \ * _ { } [ ] ( ) # + - . ! | > ~ `
    return text.replace(/([\\*_{}[\]()#+\-.!|>~`])/g, '\\$1');
}

/**
 * Rehydrate: Replaces tokens in the markdown string with original text.
 */
export function rehydrate(skeleton: string, tokens: TokenMap): string {
    let result = skeleton;

    // Regex: Matches {{MDZ0}} or \{\{MDZ0\}\} or mixed escaping, OR URL-encoded versions
    const tokenRegex = /(?:\\?\{|%7B){2}MDZ\d+(?:\\?\}|%7D){2}/g;

    result = result.replace(tokenRegex, (match) => {
        // Normalize the match key by removing backslashes and decoding URI components
        let key = match.replace(/\\/g, '');
        
        if (key.includes('%')) {
            try {
                key = decodeURIComponent(key);
            } catch (e) {
                // validation fallback
            }
        }

        if (Object.prototype.hasOwnProperty.call(tokens, key)) {
            return tokens[key];
        }
        return match; 
    });

    return result;
}
