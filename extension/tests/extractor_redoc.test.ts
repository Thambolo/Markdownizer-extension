import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { getBestContent } from '../src/extractor';
import { skeletonize } from '../src/logic';

describe('Extractor - API documentation pages', () => {
    function setupDOM(html: string) {
        const dom = new JSDOM(html, { url: 'https://developer.hypixel.net/' });
        global.document = dom.window.document;
        global.NodeFilter = dom.window.NodeFilter;
        // @ts-expect-error - JSDOM global injection for browser-like extractor tests
        global.Node = dom.window.Node;
    }

    it('should prefer a ReDoc documentation root over Readability fallback', () => {
        setupDOM(`
            <html>
                <body>
                    <div id="redoc">
                        <div id="section/Introduction" data-section-id="section/Introduction">
                            <h1>Hypixel Public API</h1>
                            <p>Official documentation for the Hypixel Public API.</p>
                        </div>
                        <div id="tag/SkyBlock/paths/~1v2~1skyblock~1garden/get" data-section-id="tag/SkyBlock/paths/~1v2~1skyblock~1garden/get">
                            <h2>Garden data</h2>
                            <div>
                                <h3>Response samples</h3>
                                <div class="redoc-json">
                                    <code>
                                        <span class="token punctuation">{</span>
                                        <ul class="obj collapsible">
                                            <li><div class="hoverable"><span class="property token string">"success"</span>: <span class="token boolean">true</span></div></li>
                                        </ul>
                                        <span class="token punctuation">}</span>
                                    </code>
                                </div>
                            </div>
                        </div>
                    </div>
                    <script>window.__redoc_state = { noisy: true };</script>
                </body>
            </html>
        `);

        const result = getBestContent();

        expect(result).not.toBeNull();
        expect(result?.strategy).not.toBe('readability');
        expect(result?.strategy).toBe('documentation-root');
        expect(result?.element.id).toBe('redoc');
        expect(result?.element.querySelector('.redoc-json')).not.toBeNull();
        expect(result?.element.textContent).toContain('Garden data');
    });

    it.each([
        ['redoc custom element', '<redoc><h1>ReDoc API docs</h1></redoc>', 'REDOC'],
        ['Swagger UI root', '<div class="swagger-ui"><h1>Swagger API docs</h1></div>', 'DIV'],
        ['RapiDoc root', '<rapi-doc><h1>RapiDoc API docs</h1></rapi-doc>', 'RAPI-DOC'],
        ['RapiDoc mini root', '<rapi-doc-mini><h1>RapiDoc mini API docs</h1></rapi-doc-mini>', 'RAPI-DOC-MINI'],
        ['Scalar API reference root', '<scalar-api-reference><h1>Scalar API docs</h1></scalar-api-reference>', 'SCALAR-API-REFERENCE'],
        ['Stoplight Elements root', '<div class="sl-elements"><h1>Stoplight API docs</h1></div>', 'DIV'],
    ])('should recognize %s before Readability fallback', (_name, rootHtml, expectedTagName) => {
        setupDOM(`
            <html>
                <body>
                    <header>Navigation chrome</header>
                    ${rootHtml}
                    <footer>Footer chrome</footer>
                </body>
            </html>
        `);

        const result = getBestContent();

        expect(result).not.toBeNull();
        expect(result?.strategy).toBe('documentation-root');
        expect(result?.element.tagName).toBe(expectedTagName);
        expect(result?.element.textContent).toContain('API docs');
    });

    it('should keep semantic article content higher priority than documentation roots', () => {
        setupDOM(`
            <html>
                <body>
                    <article><h1>Article should win</h1></article>
                    <div id="redoc"><h1>Documentation root should lose</h1></div>
                </body>
            </html>
        `);

        const result = getBestContent();

        expect(result).not.toBeNull();
        expect(result?.strategy).toBe('semantic-html');
        expect(result?.element.tagName).toBe('ARTICLE');
        expect(result?.element.textContent).toContain('Article should win');
    });

    it('should select <main> and preserve outer text alongside nested ReDoc JSON', () => {
        setupDOM(`
            <html>
                <body>
                    <main>
                        <header>API Overview</header>
                        <div id="redoc">
                            <div class="api-content">
                                <section data-section-id="tag/Pet-Data/paths/~1v2~1pet/get">
                                    <h2>GET /pets</h2>
                                    <div class="redoc-json">
                                        <code>{"id":"pet_1","active":true}</code>
                                    </div>
                                </section>
                            </div>
                        </div>
                        <footer>Terms of service</footer>
                    </main>
                </body>
            </html>
        `);

        const result = getBestContent();

        expect(result).not.toBeNull();
        expect(result?.strategy).toBe('semantic-html');
        expect(result?.element.tagName).toBe('MAIN');
        expect(result?.element.textContent).toContain('API Overview');
        expect(result?.element.textContent).toContain('Terms of service');
        expect(result?.element.querySelector('.redoc-json')).not.toBeNull();

        // Pass the selected element through skeletonize and verify output
        const { html, tokens } = skeletonize(result!.element);
        // Outer text is tokenized, so check that the token map contains the original values
        expect(Object.values(tokens)).toContain('API Overview');
        expect(Object.values(tokens)).toContain('Terms of service');
        // The normalized ReDoc JSON should produce a language-json code block
        expect(html).toContain('language-json');
    });
});
