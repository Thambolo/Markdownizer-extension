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

    it('does not recover generated text from hidden pseudo-elements', () => {
        addStyle(`
            .display-hidden::after { content: attr(data-secret); display: none; }
            .visibility-hidden::after { content: attr(data-secret); visibility: hidden; }
        `);
        document.body.innerHTML = `
            <div class="wrap">
                <p>${'Context '.repeat(100)}</p>
                <p><span class="display-hidden" data-secret="display-secret">visible display label</span></p>
                <p><span class="visibility-hidden" data-secret="visibility-secret">visible visibility label</span></p>
            </div>
        `;

        const result = getReadabilityContent();
        expect(result?.strategy).toBe('readability');
        expect(result!.element.textContent).not.toContain('display-secret');
        expect(result!.element.textContent).not.toContain('visibility-secret');

        const { html, tokens } = skeletonize(result!.element);
        const restored = document.createElement('div');
        restored.innerHTML = rehydrate(html, tokens);
        expect(restored.textContent).not.toContain('display-secret');
        expect(restored.textContent).not.toContain('visibility-secret');
    });

    it('does not recover generated text from collapsed or content-hidden pseudo-elements', () => {
        addStyle(`
            .visibility-collapse::after { content: attr(data-secret); visibility: collapse; }
            .content-visibility-hidden::after { content: attr(data-secret); content-visibility: hidden; }
        `);
        document.body.innerHTML = `
            <div class="wrap">
                <p>${'Context '.repeat(100)}</p>
                <pre><code><span class="visibility-collapse" data-secret="collapse-secret">visible collapse label</span></code></pre>
                <pre><code><span class="content-visibility-hidden" data-secret="content-visibility-secret">visible content label</span></code></pre>
            </div>
        `;

        const result = getReadabilityContent();
        expect(result?.strategy).toBe('readability');
        expect(result!.element.textContent).toContain('visible collapse label');
        expect(result!.element.textContent).toContain('visible content label');
        expect(result!.element.textContent).not.toContain('collapse-secret');
        expect(result!.element.textContent).not.toContain('content-visibility-secret');

        const { html, tokens } = skeletonize(result!.element);
        const restored = document.createElement('div');
        restored.innerHTML = rehydrate(html, tokens);

        expect(restored.textContent).toContain('visible collapse label');
        expect(restored.textContent).toContain('visible content label');
        expect(restored.textContent).not.toContain('collapse-secret');
        expect(restored.textContent).not.toContain('content-visibility-secret');
    });

    it('recovers a visible pseudo-element below a visibility-hidden ancestor', () => {
        addStyle(`
            .hidden-ancestor { visibility: hidden; }
            .visible-source, .visible-source::after { visibility: visible; }
            .visible-source::after { content: attr(data-generated); }
        `);
        document.body.innerHTML = '<p class="hidden-ancestor"><span class="visible-source" data-generated=" generated">authored</span></p>';

        const { html, tokens } = skeletonize(document.querySelector('p') as HTMLElement);
        const restored = document.createElement('div');
        restored.innerHTML = rehydrate(html, tokens);

        expect(restored.textContent).toBe('authored generated');
    });

    it('recovers generated text on a closed details summary but not its hidden content', () => {
        addStyle(`
            summary::after { content: attr(data-generated); }
            .hidden-label::after { content: attr(data-generated); }
        `);
        document.body.innerHTML = `
            <details>
                <summary data-generated=" summary-generated">Summary</summary>
                <p><span class="hidden-label" data-generated=" hidden-generated">Hidden</span></p>
            </details>
        `;

        const summary = document.querySelector('summary') as HTMLElement;
        expect(getComputedStyle(summary, '::after').content).toBe('" summary-generated"');
        expect(getComputedStyle(summary, '::after').display).not.toBe('none');
        expect(getComputedStyle(summary, '::after').visibility).toBe('visible');

        const { html, tokens } = skeletonize(document.querySelector('details') as HTMLElement);
        const restored = document.createElement('div');
        restored.innerHTML = rehydrate(html, tokens);

        expect(Object.values(tokens)).toContain('summary\\-generated');
        expect(Object.values(tokens)).not.toContain('hidden\\-generated');
        expect(restored.textContent).not.toContain('hidden-generated');
    });
});
