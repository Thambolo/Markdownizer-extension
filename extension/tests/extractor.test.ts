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

    it('clones semantic content while preserving hidden authored nodes', () => {
        setupDOM('<body><main><p hidden>Hidden text</p><p style="visibility: hidden">Invisible text</p><dialog>Closed dialog</dialog><p aria-hidden="true">ARIA label</p><p inert>Inert label</p><nav>Section navigation</nav><script>secret()</script><style>.x { color: red; }</style><noscript>No JavaScript</noscript><template>Template text</template></main></body>');
        const source = document.querySelector('main') as HTMLElement;
        const result = getBestContent();

        expect(result?.element).not.toBe(source);
        expect(result?.element.textContent).toContain('Hidden text');
        expect(result?.element.textContent).toContain('Invisible text');
        expect(result?.element.textContent).toContain('Closed dialog');
        expect(result?.element.textContent).toContain('ARIA label');
        expect(result?.element.textContent).toContain('Inert label');
        expect(result?.element.textContent).toContain('Section navigation');
        expect(result?.element.querySelector('script, style, noscript, template')).toBeNull();
        expect(source.querySelector('script')).not.toBeNull();
    });

    it('uses visible body content when no semantic root exists', () => {
        setupDOM('<body><div class="wrap"><h1>Assignment 2</h1><p>Submit Friday.</p><pre>g = f + d - e</pre></div></body>');
        const result = getBestContent();

        expect(result?.strategy).toBe('visible-body');
        expect(result?.element.textContent).toContain('Assignment 2');
        expect(result?.element.textContent).toContain('Submit Friday.');
    });

    it('removes non-content nodes while preserving hidden authored body content', () => {
        setupDOM('<body><header>Course navigation</header><script>secret()</script><style>.x { color: red; }</style><noscript>No JavaScript</noscript><template>template text</template><p hidden>Hidden text</p><p style="visibility: hidden">Invisible text</p><dialog>Closed dialog</dialog><p>Visible instructions</p></body>');
        const result = getVisibleBodyContent();

        expect(result?.element.textContent).toContain('Course navigation');
        expect(result?.element.textContent).toContain('Visible instructions');
        expect(result?.element.textContent).toContain('Hidden text');
        expect(result?.element.textContent).toContain('Invisible text');
        expect(result?.element.textContent).toContain('Closed dialog');
        expect(result?.element.querySelector('script, style, noscript, template')).toBeNull();
    });
});
