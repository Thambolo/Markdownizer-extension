import { afterEach, describe, expect, it } from 'vitest';
import { rehydrate, skeletonize } from '../src/logic';
import { getReadabilityContent } from '../src/extractor';

const testStyles: HTMLStyleElement[] = [];

function addStyle(css: string): void {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    testStyles.push(style);
}

afterEach(() => {
    document.body.replaceChildren();
    testStyles.splice(0).forEach((style) => style.remove());
});

describe('CSS-generated text in Chromium', () => {
    it('recovers generated before text in token and DOM order', () => {
        addStyle('.label::before { content: "prefix "; }');
        document.body.innerHTML = '<pre><code><span class="label">middle</span> tail</code></pre>';

        const { html, tokens } = skeletonize(document.querySelector('pre') as HTMLElement);

        expect(Object.values(tokens)).toEqual(['prefix ', 'middle', ' tail']);
        const restored = document.createElement('div');
        restored.innerHTML = rehydrate(html, tokens);
        expect(restored.querySelector('code')?.textContent).toBe('prefix middle tail');
    });

    it('preserves a generated subtraction operator inside a code block', () => {
        addStyle('.swap::after { content: attr(data-seen); }');
        document.body.innerHTML = '<pre><code>g = f + d <span class="swap" data-seen="- "></span>e    # operations in conditional branch</code></pre>';

        const { html, tokens } = skeletonize(document.querySelector('pre') as HTMLElement);

        expect(html).not.toContain('>- </');
        expect(Object.values(tokens)).toContain('- ');
        expect(rehydrate('{{MDZ0}}', tokens)).not.toContain('{{MDZ0}}');
        const restored = document.createElement('div');
        restored.innerHTML = rehydrate(html, tokens);
        expect(restored.querySelector('code')?.textContent).toContain('g = f + d - e    # operations in conditional branch');
    });

    it('uses generated text instead of a zero-size conflicting DOM value', () => {
        addStyle('.swap { font-size: 0px; }.swap::after { content: attr(data-seen); }.swap .hidden { font-size: 0px; }');
        document.body.innerHTML = '<p><span class="swap" data-seen="wait-list"><span class="hidden">rejected</span></span></p>';

        const { html, tokens } = skeletonize(document.querySelector('p') as HTMLElement);
        const markdown = rehydrate(html, tokens);

        expect(markdown).toContain('wait-list');
        expect(markdown).not.toContain('rejected');
    });

    it('does not add unsupported generated content', () => {
        addStyle('.icon::after { content: url(icon.svg); }.quote::before { content: open-quote; }');
        document.body.innerHTML = '<p><span class="icon"></span><span class="quote">content</span></p>';

        const { html, tokens } = skeletonize(document.querySelector('p') as HTMLElement);

        expect(rehydrate(html, tokens)).toContain('content');
        expect(Object.values(tokens)).not.toContain('icon.svg');
    });

    it('recovers generated code text before Readability strips its CSS class', () => {
        addStyle('.swap::after { content: attr(data-seen); }');
        document.body.innerHTML = `
            <div class="wrap">
                <p>${'Context '.repeat(100)}</p>
                <pre><code>g = f + d <span class="swap" data-seen="- "></span>e    # operations in conditional branch</code></pre>
            </div>
        `;

        const result = getReadabilityContent();
        expect(result?.strategy).toBe('readability');

        const { html, tokens } = skeletonize(result!.element);
        expect(rehydrate(html, tokens)).toContain('g = f + d - e    # operations in conditional branch');
    });

    it('replaces zero-size conflicting text with generated text via Readability', () => {
        addStyle('.swap::after { content: attr(data-seen); } .cp { font-size: 0; line-height: 0; }');
        document.body.innerHTML = `
            <div class="wrap">
                <p>${'Context '.repeat(100)}</p>
                <p><span class="swap" data-seen="wait-list"><span class="cp">rejected</span></span></p>
            </div>
        `;

        const result = getReadabilityContent();
        expect(result?.strategy).toBe('readability');

        const { html, tokens } = skeletonize(result!.element);
        const markdown = rehydrate(html, tokens);
        expect(markdown).toContain('wait-list');
        expect(markdown).not.toContain('rejected');
    });
});
