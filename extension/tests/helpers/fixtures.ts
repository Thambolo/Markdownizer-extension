import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface FixturePage {
    name: string;
    html: string;
}

export const ARTICLE_PAGE: FixturePage = {
    name: 'article',
    html: `<!DOCTYPE html>
<html lang="en">
<head><title>Article Page</title></head>
<body>
  <header><nav><a href="/">Home</a></nav></header>
  <article>
    <h1>Characterization Article</h1>
    <p>Lead paragraph with <strong>bold</strong> and <a href="https://example.com/docs">a link</a>.</p>
    <ul><li>Item one</li><li>Item two</li></ul>
    <pre><code class="language-ts">export function hello(name: string): string {
  return \`Hello, \${name}!\`;
}</code></pre>
    <table><thead><tr><th>Name</th><th>Value</th></tr></thead>
    <tbody><tr><td>alpha</td><td>1</td></tr></tbody></table>
  </article>
  <footer>Footer text</footer>
</body></html>`,
};

export const MAIN_PAGE: FixturePage = {
    name: 'main',
    html: `<!DOCTYPE html>
<html lang="en">
<head><title>Main Page</title></head>
<body>
  <nav>Nav</nav>
  <main>
    <h1>Main Heading</h1>
    <p>Main content paragraph.</p>
  </main>
</body></html>`,
};

export const BODY_PAGE: FixturePage = {
    name: 'body',
    html: `<!DOCTYPE html>
<html lang="en">
<head><title>Body Page</title></head>
<body>
  <h1>Body Heading</h1>
  <p>No semantic landmarks here.</p>
</body></html>`,
};

export const EMPTY_PAGE: FixturePage = {
    name: 'empty',
    html: `<!DOCTYPE html>
<html lang="en">
<head><title>Empty Page</title></head>
<body></body>
</html>`,
};

/** Build a page with `count` paragraphs — used to exceed size limits. */
export function buildParagraphPage(count: number): FixturePage {
    const paragraphs = Array.from(
        { length: count },
        (_, i) => `<p>Paragraph number ${i} with some fill text.</p>`,
    ).join('\n    ');
    return {
        name: `paragraphs-${count}`,
        html: `<!DOCTYPE html>
<html lang="en">
<head><title>Big Page</title></head>
<body><main>${paragraphs}</main></body>
</html>`,
    };
}

/** Load a saved fixture file from tests/fixtures/. */
export async function loadFixture(name: string): Promise<string> {
    const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
    return readFile(path.join(fixturesDir, `${name}.html`), 'utf8');
}
