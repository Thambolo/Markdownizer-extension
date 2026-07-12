import { expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { normalizeRenderedReDoc } from '../src/redoc-normalizer';

function rootFrom(html: string): HTMLElement {
    const dom = new JSDOM(html);
    global.document = dom.window.document;
    return dom.window.document.querySelector('main') as HTMLElement;
}

it('rewrites a recognized ReDoc JSON viewer without changing outer content', () => {
    const root = rootFrom(`<main data-page="docs"><header>Outside</header><div id="redoc"><div data-section-id="operation/getGarden"><div class="redoc-json"><code><button>copy</button><span>{</span><ul><li><span>"success"</span>: <span>true</span></li></ul><span>}</span></code></div></div></div><footer>Still outside</footer></main>`);

    const summary = normalizeRenderedReDoc(root);

    expect(summary).toMatchObject({ adapter: 'redoc-ce-v2', normalizedJsonSamples: 1, fallbacks: 0 });
    expect(root.outerHTML).toContain('data-page="docs"');
    expect(root.textContent).toContain('Outside');
    expect(root.textContent).toContain('Still outside');
    expect(root.querySelector('.redoc-json pre code')?.className).toBe('language-json');
    expect(root.querySelector('.redoc-json pre code')?.textContent).toBe('{\n  "success": true\n}');
    expect(root.querySelector('.redoc-json button')).toBeNull();
});

it('leaves invalid or visibly truncated JSON untouched', () => {
    const root = rootFrom(`<main><div id="redoc"><div data-section-id="operation/getGarden"><div class="redoc-json"><code>{"result": …}</code></div></div></div></main>`);

    const original = root.querySelector('.redoc-json')?.outerHTML;
    const summary = normalizeRenderedReDoc(root);

    expect(summary).toMatchObject({ normalizedJsonSamples: 0, fallbacks: 1 });
    expect(root.querySelector('.redoc-json')?.outerHTML).toBe(original);
});

it('normalizes an unambiguous ReDoc CE v2 property table into a nested definition list', () => {
    const root = rootFrom(`<main><p>Page introduction</p><div id="redoc"><section data-section-id="operation/getPet"><h2>GET /pets/{id}</h2><table><tbody><tr><th>id</th><td>string</td><td>required</td><td>Stable pet ID</td></tr><tr><th>owner</th><td>object</td><td>nullable</td><td><table><tbody><tr><th>name</th><td>string</td><td>required</td><td>Owner name</td></tr></tbody></table></td></tr></tbody></table></section></div><p>Page conclusion</p></main>`);

    const summary = normalizeRenderedReDoc(root);
    const schema = root.querySelector('[data-mdz-redoc-schema]');

    expect(summary.normalizedSchemas).toBe(1);
    expect(root.textContent).toContain('Page introduction');
    expect(root.textContent).toContain('Page conclusion');
    expect(schema?.querySelector('dt')?.textContent).toBe('id');
    expect(schema?.textContent).toContain('string');
    expect(schema?.textContent).toContain('required');
    expect(schema?.textContent).toContain('Owner name');
    expect(schema?.querySelectorAll('dl').length).toBeGreaterThan(1);
    expect(schema?.querySelector('dd dl')).not.toBeNull();
});

it('does not rewrite a table without an explicit schema fixture marker and complete field rows', () => {
    const root = rootFrom(`<main><div id="redoc"><div data-section-id="operation/getPet"><table><tr><th>Status</th><td>Description</td></tr><tr><td>200</td><td>OK</td></tr></table></div></div></main>`);
    const original = root.querySelector('table')?.outerHTML;

    normalizeRenderedReDoc(root);

    expect(root.querySelector('table')?.outerHTML).toBe(original);
});

it('uses the Redocly adapter only when a Redocly host and operation marker agree', () => {
    const root = rootFrom(`<main><div data-redocly-root="true"><article data-redocly-operation="getPet"><div data-redocly-json="true"><code>{"id":"pet_1"}</code></div></article></div></main>`);

    const summary = normalizeRenderedReDoc(root);

    expect(summary).toMatchObject({ adapter: 'redocly', normalizedJsonSamples: 1 });
    expect(root.querySelector('[data-redocly-json] code')?.className).toBe('language-json');
});

it('keeps duplicate panels when equality cannot be proven', () => {
    const root = rootFrom(`<main><div id="redoc"><div data-section-id="operation/getPet"><div class="redoc-json"><code>{"id":"one"}</code></div><div class="redoc-json"><code>{"id":"two"}</code></div></div></div></main>`);

    normalizeRenderedReDoc(root);

    expect(root.querySelectorAll('.redoc-json pre code').length).toBe(2);
});
