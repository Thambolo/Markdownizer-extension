import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { getBestContent, getVisibleBodyContent } from '../src/extractor';

function setupDOM(html: string): void {
    const dom = new JSDOM(html, { url: 'https://example.test/' });
    global.window = dom.window as unknown as Window & typeof globalThis;
    global.document = dom.window.document;
    global.NodeFilter = dom.window.NodeFilter;
    // @ts-expect-error - JSDOM global injection for browser-like extractor tests
    global.Node = dom.window.Node;
}

describe('visible-body extraction', () => {
    it('uses a semantic main element before the visible body', () => {
        setupDOM('<body><header>Site nav</header><main><h1>Assignment</h1><p>Instructions</p></main></body>');
        const result = getBestContent();

        expect(result?.strategy).toBe('semantic-html');
        expect(result?.element.tagName).toBe('MAIN');
    });

    it('uses visible body content when no semantic root exists', () => {
        setupDOM('<body><div class="wrap"><h1>Assignment 2</h1><p>Submit Friday.</p><pre>g = f + d - e</pre></div></body>');
        const result = getBestContent();

        expect(result?.strategy).toBe('visible-body');
        expect(result?.element.textContent).toContain('Assignment 2');
        expect(result?.element.textContent).toContain('Submit Friday.');
    });

    it('removes objectively non-content nodes but retains visible navigation', () => {
        setupDOM('<body><header>Course navigation</header><script>secret()</script><style>.x { color: red; }</style><template>template text</template><p hidden>Hidden text</p><dialog>Closed dialog</dialog><p>Visible instructions</p></body>');
        const result = getVisibleBodyContent();

        expect(result?.element.textContent).toContain('Course navigation');
        expect(result?.element.textContent).toContain('Visible instructions');
        expect(result?.element.textContent).not.toContain('template text');
        expect(result?.element.querySelector('script, style, template, [hidden], dialog')).toBeNull();
    });
});
