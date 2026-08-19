// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { rehydrateMarkdown, skeletonize } from '../src/skeleton/skeletonizer';
import { ARTICLE_PAGE, MAIN_PAGE, loadFixture } from './helpers/fixtures';

function setupDom(html: string): HTMLElement {
    document.documentElement.innerHTML = html;
    return document.body;
}

describe('Skeleton golden corpus', () => {
    it('article skeleton keeps structure, strips chrome, and preserves code + language classes', () => {
        const body = setupDom(ARTICLE_PAGE.html);
        const article = body.querySelector('article')!;
        const { html, tokens } = skeletonize(article);
        const values = Object.values(tokens);

        expect(values).not.toContain('Home'); // header nav link text is outside the article root, so never tokenized
        expect(html).toContain('href="https://example.com/docs"');
        expect(html).toContain('<table>');
        expect(html).toContain('language-ts');
        expect(values).toContain('Characterization Article');
        expect(values).toContain('Lead paragraph with');
        expect(values).toContain('export function hello(name: string): string {');
        expect(values).toContain('  return `Hello, ${name}!`;');
    });

    it('skeletonization is deterministic across runs', () => {
        const body = setupDom(ARTICLE_PAGE.html);
        const article = body.querySelector('article')!;
        const first = skeletonize(article);
        const second = skeletonize(article);
        expect(second.tokens).toEqual(first.tokens);
    });

    it('main-landmark page yields semantic extraction candidates', () => {
        const body = setupDom(MAIN_PAGE.html);
        const main = body.querySelector('main')!;
        const { tokens } = skeletonize(main);
        expect(Object.values(tokens)).toContain('Main Heading');
        expect(Object.values(tokens)).toContain('Main content paragraph.');
    });

    it('redoc fixture is normalized: operation button becomes a semantic heading + server link', async () => {
        const body = setupDom(await loadFixture('redoc-page'));
        const root = body.querySelector('#redoc')!;
        const { html, tokens } = skeletonize(root);
        const values = Object.values(tokens);

        // Pipeline order (P4 fix): normalizeRenderedReDoc now runs BEFORE
        // serializeNativeControls, so the operation button is normalized into
        // a semantic heading + server link instead of an mdz-control marker.
        expect(values).toContain('GET /pets'); // normalizeOperationUI heading
        expect(values).toContain('Pet identifier'); // schema dl description
        expect(html).toContain('href="https://api.example.com/v1"'); // server link
        expect(values).not.toContain('label: "get/pets"'); // button no longer serialized as control
        expect(html).toContain('<dl>'); // schema definition list
        expect(html).toContain('language-json'); // json viewer → fenced code
        expect(values).not.toContain('Sidebar menu'); // .menu-content chrome removed
    });

    it('full round trip: token lookup by value and local rehydration', () => {
        const body = setupDom(ARTICLE_PAGE.html);
        const article = body.querySelector('article')!;
        const { tokens } = skeletonize(article);

        const valueToToken = new Map(Object.entries(tokens).map(([id, value]) => [value, id]));
        const headingToken = valueToToken.get('Characterization Article');
        expect(headingToken).toBeDefined();

        const markdown = rehydrateMarkdown(`# ${headingToken}`, tokens);
        expect(markdown).toContain('# Characterization Article');
    });
});
