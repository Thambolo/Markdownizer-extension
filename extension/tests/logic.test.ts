import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { remark } from 'remark';
import { rehydrateMarkdown, skeletonize } from '../src/logic';

interface MarkdownNode { type: string; value?: string; children?: MarkdownNode[]; }
function nodesOfType(node: MarkdownNode, type: string): MarkdownNode[] {
    return [node, ...(node.children ?? []).flatMap((child) => nodesOfType(child, type))].filter((child) => child.type === type);
}

function setupDOM(html: string): HTMLElement {
    const dom = new JSDOM(html);
    global.document = dom.window.document;
    global.NodeFilter = dom.window.NodeFilter;
    // @ts-expect-error - JSDOM global injection
    global.Node = dom.window.Node;
    return dom.window.document.body;
}

describe('Skeleton Protocol', () => {
    it('replaces visible text with tokens', () => {
        const root = setupDOM('<article><h1>Hello World</h1><p>This is a <b>test</b>.</p></article>');
        const { html, tokens } = skeletonize(root.querySelector('article') as HTMLElement);

        expect(html).toContain('{{MDZ0}}');
        expect(Object.values(tokens)).toContain('Hello World');
        expect(Object.values(tokens)).toContain('test');
    });

    it('keeps standard-text whitespace outside token values', () => {
        const { html, tokens } = skeletonize(setupDOM('<strong> Joint work </strong>').querySelector('strong') as HTMLElement);

        expect(html).toContain('<strong> {{MDZ0}} </strong>');
        expect(tokens['{{MDZ0}}']).toBe('Joint work');
    });

    it('preserves code lines and indentation in token values', () => {
        const source = 'function test() {\n    return "value | pipe";\n}';
        const { tokens } = skeletonize(setupDOM(`<pre><code>${source}</code></pre>`).querySelector('pre') as HTMLElement);

        expect(Object.values(tokens).join('\n')).toBe(source);
    });

    it('rehydrates normalized ReDoc JSON through a fenced code node', () => {
        const root = setupDOM('<main><div id="redoc"><div class="api-content"><section data-section-id="tag/Pet-Data/paths/~1v2~1pet/get"><div class="redoc-json"><code>{"id":"pet_1","active":true}</code></div></section></div></div></main>');
        const { html, tokens } = skeletonize(root.querySelector('main') as HTMLElement);
        const code = new JSDOM(html).window.document.querySelector('code')?.textContent;
        const markdown = rehydrateMarkdown(`\`\`\`json\n${code}\n\`\`\``, tokens);
        const tree = remark().parse(markdown) as { children: Array<{ type: string; value?: string }> };

        expect(tree.children.find((node) => node.type === 'code')?.value).toContain('pet_1');
    });

    it('normalizes excessive internal standard-text whitespace', () => {
        expect(Object.values(skeletonize(setupDOM('<div>  Line 1    Line 2   </div>').querySelector('div') as HTMLElement).tokens)[0]).toBe('Line 1 Line 2');
    });

    it('splits preformatted code by newline', () => {
        const { html, tokens } = skeletonize(setupDOM('<pre>line1\nline2</pre>').querySelector('pre') as HTMLElement);
        expect(Object.keys(tokens)).toHaveLength(2);
        expect(html).toContain('{{MDZ0}}\n{{MDZ1}}');
    });

    it('keeps ordinary code operators in token values', () => {
        const { tokens } = skeletonize(setupDOM('<pre><code>g = f + d - e * 2 / 3 <= 4\n\t# comment</code></pre>').querySelector('pre') as HTMLElement);
        expect(Object.values(tokens)).toEqual(['g = f + d - e * 2 / 3 <= 4', '\t# comment']);
    });

    it('joins syntax-highlighted code fragments semantically', () => {
        const { html, tokens } = skeletonize(setupDOM('<pre><code><span>g = f + d </span><span>- </span><span>e</span></code></pre>').querySelector('pre') as HTMLElement);
        const markdown = rehydrateMarkdown(`\`\`\`\n${new JSDOM(html).window.document.querySelector('code')?.textContent}\n\`\`\``, tokens);
        expect(markdown).toContain('g = f + d - e');
    });

    it('keeps mixed strong token values', () => {
        const { tokens } = skeletonize(setupDOM('<p><strong> Joint work</strong> is <strong>not permitted</strong>.</p>').querySelector('p') as HTMLElement);
        expect(tokens['{{MDZ0}}']).toBe('Joint work');
    });

    it('retains trailing preformatted blank-line tokens', () => {
        const { tokens } = skeletonize(setupDOM('<pre>one\n</pre>').querySelector('pre') as HTMLElement);
        expect(Object.keys(tokens)).toHaveLength(2);
    });

    it('rehydrates a real skeletonized canonical URL and visible inline code', () => {
        const root = setupDOM('<main>https://api.hypixel.net/v2/player <code>npm install</code></main>');
        const { html, tokens } = skeletonize(root.querySelector('main') as HTMLElement);
        const skeleton = new JSDOM(html).window.document;
        const source = skeleton.querySelector('main')?.childNodes[0].textContent;
        const codeToken = skeleton.querySelector('code')?.textContent;
        const markdown = rehydrateMarkdown(`${source}\n\n\`${codeToken}\``, tokens);

        const tree = remark().parse(markdown) as unknown as MarkdownNode;
        expect(markdown).not.toContain('\\.');
        expect(nodesOfType(tree, 'text').map((node) => node.value)).toContain('https://api.hypixel.net/v2/player');
        expect(nodesOfType(tree, 'inlineCode')[0].value).toBe('npm install');
    });
});
