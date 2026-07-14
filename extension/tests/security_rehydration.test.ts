import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import { rehydrateMarkdown, skeletonize } from '../src/logic';

interface MarkdownNode {
    type: string;
    value?: string;
    url?: string;
    children?: MarkdownNode[];
}

function parseMarkdown(markdown: string): MarkdownNode {
    return remark().use(remarkGfm).parse(markdown) as unknown as MarkdownNode;
}

function nodesOfType(node: MarkdownNode, type: string): MarkdownNode[] {
    return [node, ...(node.children ?? []).flatMap((child) => nodesOfType(child, type))]
        .filter((child) => child.type === type);
}

function semanticTree(markdown: string): MarkdownNode {
    return JSON.parse(JSON.stringify(parseMarkdown(markdown), (key, value) => key === 'position' ? undefined : value));
}

describe('Security & Robustness Rehydration Tests', () => {

    it.each([
        ['heading', '# {{MDZ0}}', { '{{MDZ0}}': 'Release notes' }, (tree: MarkdownNode) => expect(nodesOfType(tree, 'heading')[0].children?.[0].value).toBe('Release notes')],
        ['paragraph', 'Before {{MDZ0}} after.', { '{{MDZ0}}': 'the update' }, (tree: MarkdownNode) => expect(nodesOfType(tree, 'paragraph')[0].children?.[0].value).toBe('Before the update after.')],
        ['nested list', '- Parent\n  - {{MDZ0}}', { '{{MDZ0}}': 'Child' }, (tree: MarkdownNode) => {
            const lists = nodesOfType(tree, 'list');
            expect(lists).toHaveLength(2);
            expect(nodesOfType(lists[1], 'text')[0].value).toBe('Child');
        }],
        ['blockquote', '> {{MDZ0}}', { '{{MDZ0}}': 'Quoted text' }, (tree: MarkdownNode) => expect(nodesOfType(tree, 'blockquote')[0].children?.[0].children?.[0].value).toBe('Quoted text')],
        ['emphasis and strong text', '*{{MDZ0}}* and **{{MDZ1}}**', { '{{MDZ0}}': 'emphasis', '{{MDZ1}}': 'strong' }, (tree: MarkdownNode) => {
            expect(nodesOfType(tree, 'emphasis')[0].children?.[0].value).toBe('emphasis');
            expect(nodesOfType(tree, 'strong')[0].children?.[0].value).toBe('strong');
        }],
        ['fenced code', '```ts\n{{MDZ0}}\n```', { '{{MDZ0}}': 'const secret = true;' }, (tree: MarkdownNode) => expect(nodesOfType(tree, 'code')[0].value).toBe('const secret = true;')],
        ['inline code', 'Use `{{MDZ0}}`.', { '{{MDZ0}}': 'secret' }, (tree: MarkdownNode) => expect(nodesOfType(tree, 'inlineCode')[0].value).toBe('secret')],
        ['link label', '[{{MDZ0}}](https://example.com/{{MDZ1}})', { '{{MDZ0}}': 'Example', '{{MDZ1}}': 'secret' }, (tree: MarkdownNode) => {
            const link = nodesOfType(tree, 'link')[0];
            expect(link.children?.[0].value).toBe('Example');
            expect(link.url).toBe('https://example.com/{{MDZ1}}');
        }],
        ['GFM table', '| Name | Value |\n| --- | --- |\n| {{MDZ0}} | {{MDZ1}} |', { '{{MDZ0}}': 'Status', '{{MDZ1}}': 'Ready' }, (tree: MarkdownNode) => expect(nodesOfType(tree, 'tableRow')[1].children?.map((cell) => cell.children?.[0].value)).toEqual(['Status', 'Ready'])],
        ['multiline value', '{{MDZ0}}', { '{{MDZ0}}': 'First line\nSecond line' }, (tree: MarkdownNode) => expect(nodesOfType(tree, 'text')[0].value).toBe('First line\nSecond line')],
        ['adjacent tokens', '{{MDZ0}}{{MDZ1}}', { '{{MDZ0}}': 'Hello', '{{MDZ1}}': 'World' }, (tree: MarkdownNode) => expect(nodesOfType(tree, 'text')[0].value).toBe('HelloWorld')],
        ['unknown token', 'Value: {{MDZ99}}', {}, (tree: MarkdownNode) => expect(nodesOfType(tree, 'text')[0].value).toBe('Value: {{MDZ99}}')],
        ['literal punctuation', '{{MDZ0}}', { '{{MDZ0}}': '.-*[]' }, (tree: MarkdownNode) => expect(nodesOfType(tree, 'text')[0].value).toBe('.-*[]')],
    ])('preserves %s semantics', (_name, markdown, tokens, assertResult) => {
        assertResult(parseMarkdown(rehydrateMarkdown(markdown, tokens)));
    });

    it('keeps password and hidden values out of token maps and Markdown while retaining other control markers', () => {
        const dom = new JSDOM('<main><input type="password" value="do-not-export"><input type="hidden" value="also-private"><button>Send</button><input type="checkbox" checked><select><option selected>Canada</option></select><textarea>Notes</textarea><input type="file"><input disabled value="Visible disabled value"></main>');
        global.document = dom.window.document;
        global.NodeFilter = dom.window.NodeFilter;
        // @ts-expect-error - JSDOM global injection
        global.Node = dom.window.Node;
        const root = dom.window.document.querySelector('main') as HTMLElement;

        const { html, tokens } = skeletonize(root);
        const markdown = rehydrateMarkdown(html, tokens);
        expect(html).not.toContain('do-not-export');
        expect(html).not.toContain('also-private');
        expect(Object.values(tokens)).not.toContain('do-not-export');
        expect(Object.values(tokens)).not.toContain('also-private');
        expect(markdown).not.toContain('do-not-export');
        expect(markdown).not.toContain('also-private');

        const controls = new JSDOM(html).window.document;
        const button = controls.querySelector('mdz-control[data-kind="button"]');
        const checkbox = controls.querySelector('mdz-control[data-kind="checkbox"]');
        const select = controls.querySelector('mdz-control[data-kind="select"]');
        const textarea = controls.querySelector('mdz-control[data-kind="textarea"]');
        const file = controls.querySelector('mdz-control[data-kind="file"]');
        const disabled = controls.querySelector('mdz-control[data-kind="input"][data-type="text"]');

        expect(button?.getAttribute('data-type')).toBe('submit');
        expect(button?.getAttribute('data-state')).toBe('label');
        expect(checkbox?.getAttribute('data-type')).toBe('checkbox');
        expect(checkbox?.getAttribute('data-state')).toBe('checked');
        expect(select?.getAttribute('data-type')).toBe('select');
        expect(select?.getAttribute('data-state')).toBe('selected');
        expect(textarea?.getAttribute('data-type')).toBe('textarea');
        expect(textarea?.getAttribute('data-state')).toBe('value');
        expect(file?.getAttribute('data-type')).toBe('file');
        expect(file?.getAttribute('data-state')).toBe('files');
        expect(disabled?.getAttribute('data-state')).toBe('value');
        expect(disabled?.textContent).toMatch(/^\{\{MDZ\d+\}\}$/);
        expect(Object.values(tokens)).toContain('value: "Visible disabled value"');
    });

    it('rehydrates representative tokenized Markdown within a bounded time', () => {
        const lineCount = 4_000;
        const tokens: Record<string, string> = {};
        const lines = Array.from({ length: lineCount }, (_, index) => {
            const token = `{{MDZ${index}}}`;
            tokens[token] = `Representative value ${index}`;
            return `- ${token}`;
        });
        const markdown = `# Export\n\n${lines.join('\n')}`;
        const startedAt = performance.now();
        const result = rehydrateMarkdown(markdown, tokens);
        const elapsedMs = performance.now() - startedAt;

        expect(markdown.length).toBeLessThan(1_000_000);
        expect(result).toContain('Representative value 3999');
        expect(result.length).toBeGreaterThan(90_000);
        expect(elapsedMs).toBeLessThan(3_000);
    });

    it('rehydrates adjacent URL tokens without escaped periods', () => {
        const tokens = {
            '{{MDZ0}}': 'https://api.hypixel.net',
            '{{MDZ1}}': '/v2/player'
        };

        const result = rehydrateMarkdown('{{MDZ0}}{{MDZ1}}', tokens);
        expect(nodesOfType(parseMarkdown(result), 'text')[0].value).toBe('https://api.hypixel.net/v2/player');
        expect(result).not.toContain('\\.');
    });

    it('restores a real skeletonized URL without escaped periods', () => {
        const dom = new JSDOM('<main>https://api.hypixel.net/v2/player</main>');
        global.document = dom.window.document;
        global.NodeFilter = dom.window.NodeFilter;
        // @ts-expect-error - JSDOM global injection
        global.Node = dom.window.Node;
        const { html, tokens } = skeletonize(dom.window.document.querySelector('main') as HTMLElement);
        const token = new JSDOM(html).window.document.querySelector('main')?.textContent;

        const result = rehydrateMarkdown(token!, tokens);
        expect(nodesOfType(parseMarkdown(result), 'text')[0].value).toBe('https://api.hypixel.net/v2/player');
        expect(result).not.toContain('\\.');
    });

    it('normalizes token-free Markdown semantically', () => {
        const markdown = '# Heading\n\n- item  \n- [reference][id]\n\n[id]: https://example.com\n\n| Name | Value |\n| :--- | ---: |\n| A    | B     |\n';

        expect(semanticTree(rehydrateMarkdown(markdown, {}))).toEqual(semanticTree(markdown));
    });

    it('patches only authorized text-token ranges in mixed Markdown', () => {
        const markdown = '> {{MDZ0}}  \n> `{{MDZ1}}`\n\n[{{MDZ2}}](https://example.com/{{MDZ3}})\n\n<input value="{{MDZ4}}">\n';

        const result = rehydrateMarkdown(markdown, {
            '{{MDZ0}}': 'Visible prose',
            '{{MDZ1}}': 'code secret',
            '{{MDZ2}}': 'Visible label',
            '{{MDZ3}}': 'link secret',
            '{{MDZ4}}': 'attribute secret',
        });
        const tree = parseMarkdown(result);
        expect(nodesOfType(tree, 'text').map((node) => node.value)).toContain('Visible prose');
        expect(nodesOfType(tree, 'inlineCode')[0].value).toBe('code secret');
        expect(nodesOfType(tree, 'link')[0].url).toBe('https://example.com/{{MDZ3}}');
        expect(result).toContain('<input value="{{MDZ4}}">');
    });

    it('rehydrates tokens in inline code', () => {
        expect(nodesOfType(parseMarkdown(rehydrateMarkdown('Use `{{MDZ0}}`.', { '{{MDZ0}}': 'secret' })), 'inlineCode')[0].value).toBe('secret');
    });

    it('rehydrates a tokenized normalized ReDoc JSON fence without private markers', () => {
        const dom = new JSDOM('<main><div id="redoc"><div class="api-content"><section data-section-id="tag/Pets/paths/~1pets/get"><div class="redoc-json"><code>{"id":"pet_1"}</code></div></section></div></div></main>');
        global.document = dom.window.document;
        global.NodeFilter = dom.window.NodeFilter;
        // @ts-expect-error - JSDOM global injection
        global.Node = dom.window.Node;
        const { html, tokens } = skeletonize(dom.window.document.querySelector('main') as HTMLElement);
        const code = new JSDOM(html).window.document.querySelector('code')?.textContent;

        expect(code).toBeDefined();
        const result = rehydrateMarkdown(`\`\`\`json\n${code}\n\`\`\``, tokens);

        expect(nodesOfType(parseMarkdown(result), 'code')[0].value).toBe('{\n  "id": "pet_1"\n}');
        expect(result).not.toContain('MDZREDOCJSON');
    });

    it('rehydrates tokens in link labels but not destinations', () => {
        const markdown = '[{{MDZ0}}](https://example.com/{{MDZ1}})';

        const result = rehydrateMarkdown(markdown, {
            '{{MDZ0}}': 'Example',
            '{{MDZ1}}': 'secret'
        });
        const link = nodesOfType(parseMarkdown(result), 'link')[0];
        expect(link.children?.[0].value).toBe('Example');
        expect(link.url).toBe('https://example.com/{{MDZ1}}');
    });

    it('leaves unknown text tokens unchanged', () => {
        expect(nodesOfType(parseMarkdown(rehydrateMarkdown('Value: {{MDZ99}}', {})), 'text')[0].value).toBe('Value: {{MDZ99}}');
    });

    it('does not replace placeholder-like text in inline code', () => {
        const result = rehydrateMarkdown('{{MDZ0}} `MDZREHYDRATE0PLACEHOLDER`', {
            '{{MDZ0}}': 'Visible'
        });

        expect(nodesOfType(parseMarkdown(result), 'inlineCode')[0].value).toBe('MDZREHYDRATE0PLACEHOLDER');
    });

    it('does not replace placeholder-like text in raw HTML or native-control attributes', () => {
        const result = rehydrateMarkdown('<input data-mdz="MDZREHYDRATE0PLACEHOLDER"> {{MDZ0}}', {
            '{{MDZ0}}': 'Visible'
        });

        expect(result).toContain('data-mdz="MDZREHYDRATE0PLACEHOLDER"');
        expect(result).toContain('Visible');
    });

    it('does not replace placeholder-like text in link destinations', () => {
        const result = rehydrateMarkdown('[{{MDZ0}}](https://example.com/MDZREHYDRATE0PLACEHOLDER)', {
            '{{MDZ0}}': 'Visible'
        });

        expect(nodesOfType(parseMarkdown(result), 'link')[0].url).toBe('https://example.com/MDZREHYDRATE0PLACEHOLDER');
    });

    it('preserves placeholder-like text in token values', () => {
        const result = rehydrateMarkdown('{{MDZ0}}{{MDZ1}}', {
            '{{MDZ0}}': 'MDZREHYDRATE1PLACEHOLDER',
            '{{MDZ1}}': 'Visible'
        });

        expect(nodesOfType(parseMarkdown(result), 'text')[0].value).toBe('MDZREHYDRATE1PLACEHOLDERVisible');
    });

    it.each([
        'const fence = "```";\nconst tilde = "~~~";',
        '````\n~~~\n```',
        '# heading\n- list\n[link](https://example.test)\n<html>',
    ])('preserves fence-collision code values exactly', (value) => {
        const result = rehydrateMarkdown('```ts\n{{MDZ0}}\n```', { '{{MDZ0}}': value });
        expect(nodesOfType(parseMarkdown(result), 'code')[0].value).toBe(value);
    });

    it('preserves inline-code backticks, spaces, Unicode, CRLF, and Markdown punctuation', () => {
        const inline = ' `backtick` Unicode cafe \ud83d\ude00 ';
        const code = '  # heading\r\n- [item](https://example.test)\r\n~~~';
        const result = rehydrateMarkdown('`{{MDZ0}}`\n\n```\n{{MDZ1}}\n```', {
            '{{MDZ0}}': inline,
            '{{MDZ1}}': code,
        });
        const tree = parseMarkdown(result);
        expect(nodesOfType(tree, 'inlineCode')[0].value).toBe(inline);
        expect(nodesOfType(tree, 'code')[0].value).toBe(code);
    });

    it('should handle Link Injection with Pre-Escaped Tokens', () => {
        // NOTE: In the real app, `skeletonize` runs BEFORE the backend, 
        // and it escapes markdown characters. 
        // So a text like "evil](..." becomes "evil\\]\\(...\\\\".
        // The token map passed to `rehydrate` ALREADY contains escaped strings.
        
        const tokens = {
            '{{MDZ0}}': 'evil\\]\\(https://evil.com\\)' // Pre-escaped by skeletonize
        };
        
        // Backend produces: [Link Text]({{MDZ0}})
        // But here we test simple substitution
        const skeletonA = `See {{MDZ0}}`;
        const resultA = rehydrateMarkdown(skeletonA, tokens);
        
        // Rehydrate should simply put the (escaped) string back.
        expect(nodesOfType(parseMarkdown(resultA), 'text')[0].value).toBe('See evil\\]\\(');
    });

    it('should handle Backslashes with Pre-Escaped Tokens', () => {
        // Input text: C:\Windows\
        // Skeletonize escapes it to: C:\\Windows\\
        const tokens = {
            '{{MDZ0}}': 'C:\\\\Windows\\\\' // This needs to be C:\\Windows\\ in the string literal
        };
        
        const skeleton = `Path: {{MDZ0}}`;
        const result = rehydrateMarkdown(skeleton, tokens);
        
        expect(nodesOfType(parseMarkdown(result), 'text')[0].value).toBe('Path: C:\\\\Windows\\\\');
    });

    it('should handle adjacent tokens without merging incorrectly', () => {
        const tokens = {
            '{{MDZ0}}': 'Hello',
            '{{MDZ1}}': 'World'
        };
        const skeleton = `{{MDZ0}}{{MDZ1}}`;
        const result = rehydrateMarkdown(skeleton, tokens);
        expect(nodesOfType(parseMarkdown(result), 'text')[0].value).toBe('HelloWorld');
    });

    it('should rehydrate URL-Encoded tokens from attributes', () => {
        const tokens = {
            '{{MDZ0}}': 'https://example.com/image.png'
        };
        // Backend (html-to-markdown) might encode the token in an href
        // <a href="{{MDZ0}}"> -> [Link](%7B%7BMDZ0%7D%7D)
        const skeleton = `[Link](%7B%7BMDZ0%7D%7D)`;
        
        const result = rehydrateMarkdown(skeleton, tokens);
        expect(nodesOfType(parseMarkdown(result), 'link')[0].url).toBe('%7B%7BMDZ0%7D%7D');
    });
});
