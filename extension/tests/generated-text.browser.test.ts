import { afterEach, describe, expect, it } from 'vitest';
import { rehydrateMarkdown, skeletonize } from '../src/logic';
import { getReadabilityContent } from '../src/extractor';

const styles: HTMLStyleElement[] = [];

function addStyle(css: string): void {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    styles.push(style);
}

afterEach(() => {
    document.body.replaceChildren();
    styles.splice(0).forEach((style) => style.remove());
});

describe('CSS-generated text in Chromium', () => {
    it('preserves an attr-generated operator through backend-shaped code rehydration', () => {
        addStyle('.swap::after { content: attr(data-seen); }');
        document.body.innerHTML = '<pre><code>g = f + d <span class="swap" data-seen="- "></span>e    # operations in conditional branch</code></pre>';

        const { tokens } = skeletonize(document.querySelector('pre') as HTMLElement);

        expect(Object.values(tokens)).toEqual([
            'g = f + d ',
            '- ',
            'e    # operations in conditional branch',
        ]);
        expect(rehydrateMarkdown('```\n{{MDZ0}}{{MDZ1}}{{MDZ2}}\n```', tokens))
            .toContain('g = f + d - e    # operations in conditional branch');
    });

    it('recovers generated code text in token order', () => {
        const style = document.createElement('style');
        style.textContent = '.label::before { content: "prefix "; }';
        document.head.append(style);
        styles.push(style);
        document.body.innerHTML = '<pre><code><span class="label">middle</span> tail</code></pre>';

        const { tokens } = skeletonize(document.querySelector('pre') as HTMLElement);

        expect(Object.values(tokens)).toEqual(['prefix ', 'middle', ' tail']);
    });

    it.each([
        ['a subtraction operator', '.swap::after { content: "- "; }', '<pre><code>g <span class="swap"></span>e</code></pre>', '- '],
        ['visible paragraph text', '.label::after { content: " visible"; }', '<p><span class="label">authored</span></p>', 'visible'],
        ['unsupported URL content', '.label::after { content: url(icon.svg); }', '<p><span class="label">content</span></p>', 'content'],
        ['generated text in code', '.label::after { content: " generated"; }', '<pre><code><span class="label">code</span></code></pre>', 'generated'],
        ['generated text in prose', '.label::before { content: "prefix "; }', '<p><span class="label">content</span></p>', 'prefix'],
        ['multiple generated fragments', '.one::after { content: " A"; }.two::before { content: "B "; }', '<p><span class="one">one</span><span class="two">two</span></p>', 'A'],
        ['generated list text', '.label::before { content: "item "; }', '<ul><li><span class="label">one</span></li></ul>', 'item'],
        ['generated heading text', '.label::after { content: "!"; }', '<h1><span class="label">Heading</span></h1>', '!'],
        ['generated summary text', '.label::after { content: " summary"; }', '<details><summary><span class="label">Open</span></summary></details>', 'summary'],
    ])('captures %s', (_name, css, html, expected) => {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.append(style);
        styles.push(style);
        document.body.innerHTML = html;
        expect(Object.values(skeletonize(document.body).tokens).join(' ')).toContain(expected);
    });

    it('uses generated text instead of zero-size conflicting content', () => {
        addStyle('.swap { font-size: 0; }.swap::after { content: attr(data-seen); }.hidden { font-size: 0; }');
        document.body.innerHTML = '<p><span class="swap" data-seen="wait-list"><span class="hidden">rejected</span></span></p>';
        const values = Object.values(skeletonize(document.querySelector('p') as HTMLElement).tokens).join(' ');
        expect(values).toContain('wait-list');
        expect(values).not.toContain('rejected');
    });

    it('excludes hidden, collapsed, and content-hidden pseudo-elements', () => {
        addStyle('.a::after { content: attr(data-secret); display: none; }.b::after { content: attr(data-secret); visibility: collapse; }.c::after { content: attr(data-secret); content-visibility: hidden; }');
        document.body.innerHTML = '<p><span class="a" data-secret="a">one</span><span class="b" data-secret="b">two</span><span class="c" data-secret="c">three</span></p>';
        const values = Object.values(skeletonize(document.querySelector('p') as HTMLElement).tokens).join(' ');
        expect(values).not.toContain('a');
        expect(values).not.toContain('b');
        expect(values).not.toContain('c');
    });

    it('excludes visibility-hidden generated text', () => {
        addStyle('.hidden::after { content: attr(data-secret); visibility: hidden; }');
        document.body.innerHTML = '<p><span class="hidden" data-secret="hidden-secret">visible</span></p>';
        expect(Object.values(skeletonize(document.querySelector('p') as HTMLElement).tokens).join(' ')).not.toContain('hidden-secret');
    });

    it('recovers visible descendants of a hidden ancestor', () => {
        addStyle('.hidden { visibility: hidden; }.visible, .visible::after { visibility: visible; }.visible::after { content: attr(data-generated); }');
        document.body.innerHTML = '<p class="hidden"><span class="visible" data-generated=" generated">authored</span></p>';
        expect(Object.values(skeletonize(document.querySelector('p') as HTMLElement).tokens).join(' ')).toContain('generated');
    });

    it('recovers generated code before Readability removes its class', () => {
        addStyle('.swap::after { content: attr(data-seen); }');
        document.body.innerHTML = `<div><p>${'Context '.repeat(100)}</p><pre><code>g <span class="swap" data-seen="- "></span>e</code></pre></div>`;
        const result = getReadabilityContent();
        expect(result?.strategy).toBe('readability');
        expect(Object.values(skeletonize(result!.element).tokens).join(' ')).toContain('- ');
    });

    it('uses generated text over zero-size conflicts through Readability', () => {
        addStyle('.swap::after { content: attr(data-seen); }.hidden { font-size: 0; }');
        document.body.innerHTML = `<div><p>${'Context '.repeat(100)}</p><p><span class="swap" data-seen="wait-list"><span class="hidden">rejected</span></span></p></div>`;
        const result = getReadabilityContent();
        const values = Object.values(skeletonize(result!.element).tokens).join(' ');
        expect(values).toContain('wait-list');
        expect(values).not.toContain('rejected');
    });

    it('recovers closed-details summary generation but not hidden detail content', () => {
        addStyle('summary::after { content: attr(data-generated); }.hidden::after { content: attr(data-generated); }');
        document.body.innerHTML = '<details><summary data-generated=" summary-generated">Summary</summary><p><span class="hidden" data-generated=" hidden-generated">Hidden</span></p></details>';
        const values = Object.values(skeletonize(document.querySelector('details') as HTMLElement).tokens).join(' ');
        expect(values).toContain('summary-generated');
        expect(values).not.toContain('hidden-generated');
    });
});
