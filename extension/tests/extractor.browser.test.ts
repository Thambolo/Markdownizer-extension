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
    it('removes display-none and visibility-hidden nodes but keeps aria-hidden text', () => {
        addStyle('.off { display: none; } .invisible { visibility: hidden; }');
        document.body.innerHTML = '<p class="off">Off</p><p class="invisible">Invisible</p><p aria-hidden="true">Visible label</p><p>Instructions</p>';

        const result = getVisibleBodyContent();
        expect(result?.element.textContent).not.toContain('Off');
        expect(result?.element.textContent).not.toContain('Invisible');
        expect(result?.element.textContent).toContain('Visible label');
    });

    it('preserves body context while normalizing nested ReDoc JSON', () => {
        document.body.innerHTML = '<h1>API assignment</h1><p>Read these instructions.</p><div id="redoc"><div class="api-content"><section data-section-id="tag/Examples/paths/~1v1~1examples/get"><div class="redoc-json"><code>{"id":"example"}</code></div></section></div></div>';

        const { html, tokens } = skeletonize(getBestContent()!.element);

        expect(Object.values(tokens)).toContain('API assignment');
        expect(Object.values(tokens).join('')).toContain('Read these instructions');
        expect(html).toContain('language-json');
    });
});
