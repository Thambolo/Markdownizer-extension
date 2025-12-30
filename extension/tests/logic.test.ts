import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { skeletonize, rehydrate } from '../src/logic';

describe('Skeleton Protocol', () => {
    // Setup JSDOM environment helper
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

        // Verify tokens are created
        expect(html).toContain('{{MDZ0}}');
        expect(Object.values(tokens)).toContain('Hello World');
        expect(Object.values(tokens)).toContain('test');

        // Verify restoration
        const restored = rehydrate(html, tokens);
        expect(restored).toContain('<h1>Hello World</h1>');
        // The dot is escaped because it's a special Markdown char
        expect(restored).toContain('This is a <b>test</b>\\.');
    });

    it('should handle escaped characters from backend markdown converters', () => {
        const tokens = {
            '{{MDZ0}}': 'Simple',
            '{{MDZ1}}': 'Complex'
        };
        // Backend might escape braces: \{\{MDZ0\}\} 
        const messySkeleton = `Title: \\{\\{MDZ0\\}\\}\nBody: \\{\\{MDZ1\\}\\}`;
        
        const result = rehydrate(messySkeleton, tokens);
        expect(result).toBe(`Title: Simple\nBody: Complex`);
    });

    it('should keep leading/trailing whitespace OUTSIDE of tokens', () => {
        const root = setupDOM(`<strong> Joint work </strong>`);
        const strong = root.querySelector('strong') as HTMLElement;
        const { html, tokens } = skeletonize(strong);

        // Verify HTML has spaces outside token
        expect(html).toContain('<strong> {{MDZ0}} </strong>');
        
        // Token itself should be trimmed
        const tokenValue = Object.values(tokens)[0];
        expect(tokenValue).toBe('Joint work');

        // Full rehydration should restore the spaces
        const restored = rehydrate(html, tokens);
        expect(restored).toBe('<strong> Joint work </strong>');
    });

    it('should normalize excessive internal whitespace within standard text', () => {
        const root = setupDOM(`<div>  Line 1    Line 2   </div>`);
        const div = root.querySelector('div') as HTMLElement;
        const { tokens } = skeletonize(div);
        
        // "Line 1 Line 2" (internal space collapsed, outside spaces removed from token)
        const text = Object.values(tokens)[0];
        expect(text).toBe('Line 1 Line 2');
    });

    it('should PRESERVE whitespace and special characters inside <pre> tags', () => {
        const codeSnippet = `function test() {
    return "value | pipe";
}
        `;
        const root = setupDOM(`<pre>${codeSnippet}</pre>`);
        const pre = root.querySelector('pre') as HTMLElement;
        
        const { tokens } = skeletonize(pre);
        const text = Object.values(tokens)[0];

        expect(text).toBe(codeSnippet);
    });

    it('should handle the "Mixed Bold/Italic Spacing" issue via Skeletonization', () => {
        // Original problematic HTML
        const root = setupDOM(`<p><strong> Joint work</strong> is <strong>not permitted</strong>.</p>`);
        const p = root.querySelector('p') as HTMLElement;
        
        const { html, tokens } = skeletonize(p);
        
        // Verify tokenization kept the space out
        expect(html).toContain('<strong> {{MDZ0}}</strong>');
        expect(tokens['{{MDZ0}}']).toBe('Joint work');

        // Simulate backend Markdown conversion:
        // "<p><strong> {{MDZ0}}</strong> is <strong>{{MDZ1}}</strong>.</p>"
        // -> "** {{MDZ0}}** is **{{MDZ1}}**."
        const mockBackendMarkdown = `** {{MDZ0}}** is **{{MDZ1}}**\\.`
        
        const restored = rehydrate(mockBackendMarkdown, tokens);
        
        expect(restored).toContain('** Joint work**');
    });

    it('should NOT escape pipes inside code blocks (checking behavior)', () => {
        // Input: <code>cat file | grep</code>
        // We expect: `cat file | grep` (no backslash before pipe)
        const root = setupDOM(`<code>cat file | grep</code>`);
        const code = root.querySelector('code') as HTMLElement;
        
        const { tokens } = skeletonize(code);
        const text = Object.values(tokens)[0];

        expect(text).toBe('cat file | grep');
        expect(text).not.toContain('\\|');
    });
});
