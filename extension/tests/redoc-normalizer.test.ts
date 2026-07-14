import { expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { normalizeRenderedReDoc } from '../src/redoc-normalizer';

function rootFrom(html: string): HTMLElement {
    const dom = new JSDOM(html);
    global.document = dom.window.document;
    return dom.window.document.querySelector('main') as HTMLElement;
}

// JSON normalization: rewrites visual JSON trees into fenced code blocks

it('rewrites a confirmed ReDoc JSON viewer without changing outer content', () => {
    const root = rootFrom(`<main data-page="docs"><header>Outside</header><div id="redoc"><div class="api-content"><section data-section-id="tag/Player-Data/paths/~1v2~1player/get"><div class="redoc-json"><code><button>copy</button><span>{</span><ul><li><span>"success"</span>: <span>true</span></li></ul><span>}</span></code></div></section></div></div><footer>Still outside</footer></main>`);

    const summary = normalizeRenderedReDoc(root);

    expect(summary).toMatchObject({ adapter: 'redoc-ce-v2', normalizedJsonSamples: 1, fallbacks: 0 });
    expect(root.outerHTML).toContain('data-page="docs"');
    expect(root.textContent).toContain('Outside');
    expect(root.textContent).toContain('Still outside');
    expect(root.querySelector('.api-content .redoc-json pre code')?.className).toBe('language-json');
    expect(root.querySelector('.api-content .redoc-json pre code')?.hasAttribute('data-mdz-redoc-json')).toBe(false);
    expect(root.querySelector('.api-content .redoc-json pre code')?.textContent).toBe('{\n  "success": true\n}');
    expect(root.querySelector('.redoc-json button')).toBeNull();
});

it('leaves invalid or visibly truncated JSON untouched', () => {
    const root = rootFrom(`<main><div id="redoc"><div class="api-content"><section data-section-id="tag/Player-Data/paths/~1v2~1player/get"><div class="redoc-json"><code>{"result": \u2026}</code></div></section></div></div></main>`);

    const original = root.querySelector('.redoc-json')?.outerHTML;
    const summary = normalizeRenderedReDoc(root);

    expect(summary).toMatchObject({ normalizedJsonSamples: 0, fallbacks: 1 });
    expect(root.querySelector('.redoc-json')?.outerHTML).toBe(original);
});

// Scope isolation: sidebar and branding are removed, API content remains

it('normalizes only a confirmed ReDoc CE v2 API-content region', () => {
    const root = rootFrom(`<main><p>Before docs</p><div id="redoc"><aside class="menu-content"><ul role="navigation"><li>Player Data</li></ul><a>Documentation Powered by ReDoc</a></aside><div class="api-content"><section data-section-id="tag/Player-Data/paths/~1v2~1player/get"><h2>Player</h2><div class="redoc-json"><code>{"success":true}</code></div></section></div></div><p>After docs</p></main>`);

    const summary = normalizeRenderedReDoc(root);

    expect(summary).toMatchObject({ adapter: 'redoc-ce-v2', normalizedJsonSamples: 1 });
    expect(root.textContent).toContain('Before docs');
    expect(root.textContent).toContain('After docs');
    expect(root.textContent).toContain('Player');
    expect(root.textContent).not.toContain('Player Data');
    expect(root.textContent).not.toContain('Documentation Powered by ReDoc');
    expect(root.querySelector('.api-content .redoc-json pre code')?.className).toBe('language-json');
});

// False-positive resistance: partial ReDoc signatures must not activate the adapter

it.each([
    '<main><div data-section-id="tag/A/paths/~1x/get"><div class="redoc-json"><code>{"a":1}</code></div></div></main>',
    '<main><div id="redoc"><div class="api-content"><div data-section-id="tag/A/paths/~1x/not-a-method"></div></div></div></main>',
    '<main><div id="redoc"><div data-section-id="tag/A/paths/~1x/get"></div></div></main>',
])('leaves a partial ReDoc signature unchanged: %s', (html) => {
    const root = rootFrom(html);
    const before = root.outerHTML;

    expect(normalizeRenderedReDoc(root).adapter).toBe('none');
    expect(root.outerHTML).toBe(before);
});

// Schema tables: four-column property tables become nested definition lists

it('normalizes an unambiguous ReDoc CE v2 property table into a nested definition list', () => {
    const root = rootFrom(`<main><p>Page introduction</p><div id="redoc"><div class="api-content"><section data-section-id="tag/Pet-Data/paths/~1v2~1pet/get"><h2>GET /pets/{id}</h2><table><tbody><tr><th>id</th><td>string</td><td>required</td><td>Stable pet ID</td></tr><tr><th>owner</th><td>object</td><td>nullable</td><td><table><tbody><tr><th>name</th><td>string</td><td>required</td><td>Owner name</td></tr></tbody></table></td></tr></tbody></table></section></div></div><p>Page conclusion</p></main>`);

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
    const root = rootFrom(`<main><div id="redoc"><div class="api-content"><section data-section-id="tag/Pet-Data/paths/~1v2~1pet/get"><table><tr><th>Status</th><td>Description</td></tr><tr><td>200</td><td>OK</td></tr></table></section></div></div></main>`);
    const original = root.querySelector('table')?.outerHTML;

    normalizeRenderedReDoc(root);

    expect(root.querySelector('table')?.outerHTML).toBe(original);
});

// Redocly adapter: matches only when Redocly host and operation markers agree

it('uses the Redocly adapter only when a Redocly host and operation marker agree', () => {
    const root = rootFrom(`<main><div data-redocly-root="true"><article data-redocly-operation="getPet"><div data-redocly-json="true"><code>{"id":"pet_1"}</code></div></article></div></main>`);

    const summary = normalizeRenderedReDoc(root);

    expect(summary).toMatchObject({ adapter: 'redocly', normalizedJsonSamples: 1 });
    expect(root.querySelector('[data-redocly-json] code')?.className).toBe('language-json');
});

it('keeps duplicate panels when equality cannot be proven', () => {
    const root = rootFrom(`<main><div id="redoc"><div class="api-content"><section data-section-id="tag/Pet-Data/paths/~1v2~1pet/get"><div class="redoc-json"><code>{"id":"one"}</code></div><div class="redoc-json"><code>{"id":"two"}</code></div></section></div></div></main>`);

    normalizeRenderedReDoc(root);

    expect(root.querySelectorAll('.redoc-json pre code').length).toBe(2);
});

// Operation metadata, parameter tables, and response toolbar controls

it('rewrites real ReDoc operation UI and parameter rows without touching response tables', () => {
    const root = rootFrom(`<main><div id="redoc"><div class="api-content"><section data-section-id="tag/Player-Data/paths/~1v2~1player/get"><div><button><span type="get" class="http-verb get">get</span><span>/v2/player</span><svg></svg></button><div aria-hidden="true"><div role="button"><div><span>https://api.hypixel.net</span>/v2/player</div></div></div></div><div><h5>query Parameters</h5><table><tbody><tr><td kind="field" title="uuid"><span>uuid</span><div>required</div></td><td><div><span>string</span><p>Player UUID</p></div></td></tr></tbody></table></div><h3>Responses</h3><table><tbody><tr><td>200</td><td>A successful response</td></tr></tbody></table><div data-tabs="true"><div role="tabpanel"><div><span>Content type</span><div>application/json</div></div><div><button>Copy</button><button>Expand all</button><button>Collapse all</button></div><div class="redoc-json"><code>{"success":true}</code></div></div></div></section></div></div></main>`);

    normalizeRenderedReDoc(root);

    expect(root.textContent).not.toContain('Copy');
    expect(root.textContent).not.toContain('Expand all');
    expect(root.textContent).not.toContain('Collapse all');
    expect(root.querySelector('[data-mdz-redoc-operation="true"]')?.textContent).toContain('GET /v2/player');
    expect(root.querySelector('[data-mdz-redoc-operation="true"] a')?.getAttribute('href')).toBe('https://api.hypixel.net/v2/player');
    expect(root.querySelector('[data-mdz-redoc-parameters="true"] thead')?.textContent).toContain('Parameter');
    expect(root.querySelector('[data-mdz-redoc-parameters="true"] tbody')?.textContent).toContain('uuid');
    const tables = root.querySelectorAll('table');
    expect(tables[1].outerHTML).toContain('A successful response');
});

it('leaves operation metadata unchanged when method or server node is missing', () => {
    const root = rootFrom(`<main><div id="redoc"><div class="api-content"><section data-section-id="tag/Player-Data/paths/~1v2~1player/get"><div><span>/v2/player</span></div></section></div></div></main>`);
    const original = root.querySelector('section')?.innerHTML;

    normalizeRenderedReDoc(root);

    expect(root.querySelector('[data-mdz-redoc-operation="true"]')).toBeNull();
    expect(root.querySelector('section')?.innerHTML).toBe(original);
});

it('leaves a two-cell table unchanged when not preceded by an h5 with query Parameters', () => {
    const root = rootFrom(`<main><div id="redoc"><div class="api-content"><section data-section-id="tag/Player-Data/paths/~1v2~1player/get"><h5>Response Codes</h5><table><tbody><tr><td kind="field">200</td><td>OK</td></tr></tbody></table></section></div></div></main>`);
    const original = root.querySelector('table')?.outerHTML;

    normalizeRenderedReDoc(root);

    expect(root.querySelector('[data-mdz-redoc-parameters="true"]')).toBeNull();
    expect(root.querySelector('table')?.outerHTML).toBe(original);
});
