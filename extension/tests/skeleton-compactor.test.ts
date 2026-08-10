import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { compactSkeleton } from '../src/skeleton-compactor';

function rootFrom(html: string): HTMLElement {
    const dom = new JSDOM(`<main>${html}</main>`);
    // @ts-expect-error - JSDOM global injection
    global.NodeFilter = dom.window.NodeFilter;
    return dom.window.document.querySelector('main') as HTMLElement;
}

describe('compactSkeleton', () => {
    it('removes comments and complete backend-discarded subtrees', () => {
        const root = rootFrom(`
            <!-- noisy comment -->
            <p>keep</p>
            <object><p>discard object fallback</p></object>
            <iframe><p>discard frame fallback</p></iframe>
            <embed src="large.bin">
            <meta name="x" content="large">
            <link rel="stylesheet" href="large.css">
            <applet>discard applet fallback</applet>
            <frame src="frame.html">
            <frameset><frame src="child.html"></frameset>
            <script>discard()</script>
            <style>.discard { color: red }</style>
            <noscript>discard noscript</noscript>
            <template>discard template</template>
        `);

        compactSkeleton(root);

        expect(root.outerHTML).toContain('<p>keep</p>');
        expect(root.outerHTML).not.toContain('noisy comment');
        expect(root.outerHTML).not.toContain('discard');
        expect(root.querySelector('object,iframe,embed,meta,link,applet,frame,frameset,script,style,noscript,template')).toBeNull();
    });

    it('keeps only backend-consumed attributes', () => {
        const root = rootFrom(`
            <a id="jump" class="nav" style="color:red" data-route="large" aria-label="go" href="/docs">Docs</a>
            <img id="hero" class="image" src="hero.png" alt="Hero" title="ignored" loading="lazy">
            <ol id="steps" start="4"><li value="9">Step</li></ol>
            <table><tr><th align="right" scope="col">H</th><td align="center" colspan="2">C</td></tr></table>
            <mdz-control data-kind="checkbox" data-type="checkbox" data-state="checked" data-extra="remove">ignored</mdz-control>
        `);

        compactSkeleton(root);

        expect(root.querySelector('a')?.outerHTML).toBe('<a href="/docs">Docs</a>');
        expect(root.querySelector('img')?.outerHTML).toBe('<img src="hero.png" alt="Hero">');
        expect(root.querySelector('ol')?.outerHTML).toContain('start="4"');
        expect(root.querySelector('ol')?.hasAttribute('id')).toBe(false);
        expect(root.querySelector('li')?.attributes).toHaveLength(0);
        expect(root.querySelector('th')?.getAttribute('align')).toBe('right');
        expect(root.querySelector('th')?.hasAttribute('scope')).toBe(false);
        expect(root.querySelector('td')?.getAttribute('align')).toBe('center');
        expect(root.querySelector('td')?.hasAttribute('colspan')).toBe(false);
        expect(root.querySelector('mdz-control')?.outerHTML).toContain('data-kind="checkbox"');
        expect(root.querySelector('mdz-control')?.outerHTML).toContain('data-type="checkbox"');
        expect(root.querySelector('mdz-control')?.outerHTML).toContain('data-state="checked"');
        expect(root.querySelector('mdz-control')?.hasAttribute('data-extra')).toBe(false);
    });

    it('keeps only recognized language class tokens on converter-inspected elements', () => {
        const root = rootFrom(`
            <div class="highlight position-relative highlight-source-shell">
                <pre class="notranslate language-bash extra"><code class="pl-k language-typescript other">code</code></pre>
            </div>
            <span class="language-rust">not inspected</span>
        `);

        compactSkeleton(root);

        expect(root.querySelector('div')?.getAttribute('class')).toBe('highlight-source-shell');
        expect(root.querySelector('pre')?.getAttribute('class')).toBe('language-bash');
        expect(root.querySelector('code')?.getAttribute('class')).toBe('language-typescript');
        expect(root.querySelector('span')?.hasAttribute('class')).toBe(false);
    });

    it('retains svg structure and text but strips geometry and presentation attributes', () => {
        const root = rootFrom(`
            <svg viewBox="0 0 16 16" width="16" aria-hidden="true">
                <title>Chart</title>
                <desc>Quarterly revenue</desc>
                <path d="M0 0 L16 16" fill="red"></path>
                <a href="/details" class="shape-link"><text x="2" y="4">Details</text></a>
            </svg>
        `);

        compactSkeleton(root);

        expect(root.querySelector('svg')).not.toBeNull();
        expect(root.textContent).toContain('Chart');
        expect(root.textContent).toContain('Quarterly revenue');
        expect(root.textContent).toContain('Details');
        expect(root.querySelector('path')).not.toBeNull();
        expect(root.querySelector('path')?.attributes).toHaveLength(0);
        expect(root.querySelector('svg')?.attributes).toHaveLength(0);
        expect(root.querySelector('a')?.getAttribute('href')).toBe('/details');
        expect(root.querySelector('a')?.hasAttribute('class')).toBe(false);
        expect(root.querySelector('text')?.attributes).toHaveLength(0);
    });
});
