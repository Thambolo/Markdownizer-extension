import { expect, it } from 'vitest';
import { ARTICLE_PAGE, MAIN_PAGE, buildParagraphPage, loadFixture } from './helpers/fixtures';

it('inline fixtures are well-formed', () => {
    expect(ARTICLE_PAGE.html).toContain('<article>');
    expect(MAIN_PAGE.html).toContain('<main>');
    expect(buildParagraphPage(3).html.match(/<p>/g)).toHaveLength(3);
});

it('saved fixtures load from disk', async () => {
    expect((await loadFixture('redoc-page')).length).toBeGreaterThan(0);
    expect((await loadFixture('codemirror-page')).length).toBeGreaterThan(0);
    expect((await loadFixture('long-article')).length).toBeGreaterThan(0);
});
