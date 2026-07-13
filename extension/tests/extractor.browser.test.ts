import { afterEach, describe, expect, it } from 'vitest';
import { getBestContent, getVisibleBodyContent } from '../src/extractor';
import { skeletonize } from '../src/logic';

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

describe('visible-body extraction in Chromium', () => {
    it('retains inactive tab panels and their answer choices', () => {
        addStyle('.pane { display: none; } .pane.active { display: block; }');
        document.body.innerHTML = `
            <h1>Assignment 2</h1>
            <section class="pane" data-tab="q1"><h2>Q1 Decision Table</h2><label><input type="radio" name="q1">Option A</label></section>
            <section class="pane" data-tab="q2"><h2>Q2 Control-Flow Graph</h2><label><input type="radio" name="q2">Option B</label></section>
            <section class="pane active" data-tab="q5"><h2>Q5 Halstead</h2><label><input type="radio" name="q5">Option E</label></section>
        `;

        const { html, tokens } = skeletonize(getBestContent()!.element);
        const text = Object.values(tokens).join(' ').replace(/\\-/g, '-');

        expect(text).toContain('Q1 Decision Table');
        expect(text).toContain('Option A');
        expect(text).toContain('Q2 Control-Flow Graph');
        expect(text).toContain('Option B');
        expect(text).toContain('Q5 Halstead');
        expect(text).toContain('Option E');
        expect(html).toContain('data-tab="q1"');
    });

    it('preserves body context while normalizing nested ReDoc JSON', () => {
        document.body.innerHTML = '<h1>API assignment</h1><p>Read these instructions.</p><div id="redoc"><div class="api-content"><section data-section-id="tag/Examples/paths/~1v1~1examples/get"><div class="redoc-json"><code>{"id":"example"}</code></div></section></div></div>';

        const { html, tokens } = skeletonize(getBestContent()!.element);

        expect(Object.values(tokens)).toContain('API assignment');
        expect(Object.values(tokens).join('')).toContain('Read these instructions');
        expect(html).toContain('language-json');
    });

    it('does not recover pseudo-text from a hidden source because its pseudo-element is not rendered', () => {
        addStyle('.off { visibility: hidden; } .off::after { content: "leaked pseudo-text"; }');
        document.body.innerHTML = '<span class="off"></span><p>Instructions</p>';
        expect(getComputedStyle(document.querySelector('.off')!, '::after').content).toBe('"leaked pseudo-text"');

        const result = getVisibleBodyContent();
        const { html, tokens } = skeletonize(result!.element);

        expect(result?.strategy).toBe('visible-body');
        expect(result?.element.textContent).not.toContain('leaked pseudo-text');
        expect(Object.values(tokens)).not.toContain('leaked pseudo-text');
        expect(html).not.toContain('leaked pseudo-text');
    });
});
