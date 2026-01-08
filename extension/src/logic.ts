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
    return new Skeletonizer().process(root);
}

class Skeletonizer {
    private tokens: TokenMap = {};
    private counter = 0;

    public process(root: HTMLElement): { html: string, tokens: TokenMap } {
        const clone = root.cloneNode(true) as HTMLElement;
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

        // Collapse internal whitespace and escape Markdown chars
        const cleanText = escapeMarkdown(trimmedText.replace(/\s+/g, ' '));
        
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
        const lineTokens = lines.map(line => this.createToken(line));
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
