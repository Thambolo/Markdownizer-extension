import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { skeletonize, rehydrate } from '../src/logic';

describe('Skeleton Protocol', () => {
    // Helper: Setup JSDOM environment
    function setupDOM(htmlString: string) {
        const dom = new JSDOM(htmlString);
        global.document = dom.window.document;
        global.NodeFilter = dom.window.NodeFilter;
        // @ts-expect-error - JSDOM global injection
        global.Node = dom.window.Node;
        return dom.window.document.body; // Return body as root
    }

    it('should replace text with tokens and restore them', () => {
        const root = setupDOM(`
            <article>
                <h1>Hello World</h1>
                <p>This is a <b>test</b>.</p>
            </article>
        `);

        const article = root.querySelector('article') as HTMLElement;
        const { html, tokens } = skeletonize(article);

        // Verify token generation
        expect(html).toContain('{{MDZ0}}');
        expect(Object.values(tokens)).toContain('Hello World');
        expect(Object.values(tokens)).toContain('test');

        // Verify restoration
        const restored = rehydrate(html, tokens);
        expect(restored).toContain('<h1>Hello World</h1>');
        // Verify escaping of Markdown characters (dot is escaped)
        expect(restored).toContain('This is a <b>test</b>\\.');
    });

    it('should handle escaped characters from backend markdown converters', () => {
        const tokens = {
            '{{MDZ0}}': 'Simple',
            '{{MDZ1}}': 'Complex'
        };
        // Simulate backend escaping of token braces: \{\{MDZ0\}\}
        const messySkeleton = `Title: \\{\\{MDZ0\\}\\}\nBody: \\{\\{MDZ1\\}\\}`;
        
        const result = rehydrate(messySkeleton, tokens);
        expect(result).toBe(`Title: Simple\nBody: Complex`);
    });

    it('should keep leading/trailing whitespace OUTSIDE of tokens', () => {
        const root = setupDOM(`<strong> Joint work </strong>`);
        const strong = root.querySelector('strong') as HTMLElement;
        const { html, tokens } = skeletonize(strong);

        // Verify preservation of surrounding whitespace
        expect(html).toContain('<strong> {{MDZ0}} </strong>');
        
        // Verify token content is trimmed
        const tokenValue = Object.values(tokens)[0];
        expect(tokenValue).toBe('Joint work');

        // Verify rehydration restores original spacing
        const restored = rehydrate(html, tokens);
        expect(restored).toBe('<strong> Joint work </strong>');
    });

    it('should normalize excessive internal whitespace within standard text', () => {
        const root = setupDOM(`<div>  Line 1    Line 2   </div>`);
        const div = root.querySelector('div') as HTMLElement;
        const { tokens } = skeletonize(div);
        
        // Verify internal whitespace collapse
        const text = Object.values(tokens)[0];
        expect(text).toBe('Line 1 Line 2');
    });

    it('should preserve whitespace and special characters inside <pre> tags', () => {
        const codeSnippet = `function test() {
    return "value | pipe";
}
        `;
        const root = setupDOM(`<pre>${codeSnippet}</pre>`);
        const pre = root.querySelector('pre') as HTMLElement;
        
        const { tokens, html } = skeletonize(pre);
        
        // Verify code block is split into lines (including template literal trailing newline)
        const lines = codeSnippet.split('\n');
        expect(Object.keys(tokens)).toHaveLength(lines.length);
        
        // Verify exact restoration
        const restored = rehydrate(html, tokens);
        expect(restored).toBe(`<pre>${codeSnippet}</pre>`);
    });

    it('should handle mixed bold/italic spacing via skeletonization', () => {
        const root = setupDOM(`<p><strong> Joint work</strong> is <strong>not permitted</strong>.</p>`);
        const p = root.querySelector('p') as HTMLElement;
        
        const { html, tokens } = skeletonize(p);
        
        // Verify token formatting
        expect(html).toContain('<strong> {{MDZ0}}</strong>');
        expect(tokens['{{MDZ0}}']).toBe('Joint work');

        // Simulate backend Markdown conversion:
        // "<p><strong> {{MDZ0}}</strong> is <strong>{{MDZ1}}</strong>.</p>"
        // -> "** {{MDZ0}}** is **{{MDZ1}}**."
        const mockBackendMarkdown = `** {{MDZ0}}** is **{{MDZ1}}**\\.`
        
        const restored = rehydrate(mockBackendMarkdown, tokens);
        
        expect(restored).toContain('** Joint work**');
    });

    it('should split by newline inside <pre> tags to preserve indentation intent', () => {
        const root = setupDOM(`<pre>line1\nline2</pre>`);
        const pre = root.querySelector('pre') as HTMLElement;
        
        const { html, tokens } = skeletonize(pre);
        
        // Verify distinct tokens per line
        expect(Object.keys(tokens)).toHaveLength(2);
        expect(html).toContain('{{MDZ0}}\n{{MDZ1}}');
        
        expect(tokens['{{MDZ0}}']).toBe('line1');
        expect(tokens['{{MDZ1}}']).toBe('line2');
    });

    it('preserves ordinary code operators and formatting without generated text', () => {
        const root = setupDOM('<pre><code>g = f + d - e * 2 / 3 <= 4\n\t# comment</code></pre>');
        const { html, tokens } = skeletonize(root.querySelector('pre') as HTMLElement);

        expect(rehydrate(html, tokens)).toBe('<pre><code>g = f + d - e * 2 / 3 <= 4\n\t# comment</code></pre>');
    });

    it('preserves code split across syntax-highlighted spans as contiguous text', () => {
        const source = 'g = f + d - e    # operations in conditional branch';
        const root = setupDOM(`<pre><code><span>g = f + d </span><span>- </span><span>e    # operations in conditional branch</span></code></pre>`);
        const { html, tokens } = skeletonize(root.querySelector('pre') as HTMLElement);

        const restored = new JSDOM(rehydrate(html, tokens));
        expect(restored.window.document.querySelector('code')?.textContent).toContain(source);
    });

    it('tokenizes normalized ReDoc JSON locally and rehydrates a fenced JSON response', () => {
        const root = setupDOM(`<main><div id="redoc"><div class="api-content"><section data-section-id="tag/Pet-Data/paths/~1v2~1pet/get"><div class="redoc-json"><code>{"id":"pet_1","active":true}</code></div></section></div></div></main>`);
        const main = root.querySelector('main') as HTMLElement;

        const { html, tokens } = skeletonize(main);

        // The normalizer rewrites .redoc-json code to <pre><code class="language-json">,
        // then skeletonize replaces text nodes with tokens.
        expect(html).toContain('<pre><code class="language-json">');
        expect(html).not.toContain('pet_1');
        expect(html).not.toContain('active');

        // The code-context splitter may produce multiple tokens for the JSON string lines.
        // At least one token value must contain the raw JSON content.
        const tokenValues = Object.values(tokens);
        expect(tokenValues.some(v => v.includes('"id":"pet_1"') || v.includes('pet_1'))).toBe(true);

        // Build the simulated Markdown from the actual token keys in order.
        const codeTokens = Object.keys(tokens).filter(k =>
            tokens[k].includes('pet_1') || tokens[k].includes('active') || tokens[k].includes('"id"')
        );
        const markdownLines = codeTokens.map(k => k);
        const markdown = '```json\n' + markdownLines.join('\n') + '\n```';

        // Rehydrate should restore the original JSON content.
        const restored = rehydrate(markdown, tokens);
        expect(restored).toContain('pet_1');
        expect(restored).toContain('active');
    });
});
