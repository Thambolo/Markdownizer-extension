import { afterEach, describe, expect, it } from 'vitest';
import { getBestContent, getReadabilityContent, getVisibleBodyContent } from '../src/extractor';
import { rehydrate, skeletonize } from '../src/logic';

afterEach(() => document.body.replaceChildren());

function markdownFor(root: HTMLElement): string {
    const { html, tokens } = skeletonize(root);
    return rehydrate(html, tokens);
}

function skeletonizeFiles(files: File[]): { html: string, tokens: Record<string, string>, markdown: string } {
    document.body.innerHTML = '<input type="file">';
    const input = document.querySelector('input') as HTMLInputElement;
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    Object.defineProperty(input, 'files', { value: transfer.files });

    const { html, tokens } = skeletonize(document.body);
    return { html, tokens, markdown: rehydrate(html, tokens) };
}

describe('native controls in Chromium', () => {
    it('keeps readable control state local while rendering markers in source order', () => {
        document.body.innerHTML = `
            <p>key <input id="key" placeholder="1" value="stale"></p>
            <label><input id="choice" type="radio" checked> Option A</label>
            <select id="country"><option>Australia</option><option selected>Canada</option></select>
            <textarea id="notes" placeholder="Explain">line one\nline two</textarea>
        `;
        (document.querySelector('#key') as HTMLInputElement).value = 'live';

        const { html, tokens } = skeletonize(document.body);
        const markdown = rehydrate(html, tokens);

        expect(html).not.toContain('live');
        expect(html).not.toContain('Canada');
        expect(markdown).toContain('placeholder: "1"; value: "live"');
        expect(html).toContain('data-kind="radio"');
        expect(html).toContain('data-state="checked"');
        expect(markdown).toContain('Canada');
        expect(markdown).toContain('line one');
        const positions = [
            html.indexOf('data-kind="input"'),
            html.indexOf('data-kind="radio"'),
            html.indexOf('data-kind="select"'),
            html.indexOf('data-kind="textarea"')
        ];
        expect(positions).toEqual([...positions].sort((left, right) => left - right));
    });

    it('uses button label fallbacks without marker attributes carrying labels', () => {
        document.body.innerHTML = `
            <button>Visible text</button><button aria-label="Aria label"></button>
            <input type="button" value="Input value"><input type="image" alt="Image alt">
            <input type="submit">
        `;

        const { html, tokens } = skeletonize(document.body);
        const markdown = rehydrate(html, tokens);

        expect(markdown).toContain('Visible text');
        expect(markdown).toContain('Aria label');
        expect(markdown).toContain('Input value');
        expect(markdown).toContain('Image alt');
        expect(markdown).toContain('submit');
        expect(html).not.toContain('data-label');
        expect(html).not.toContain('Visible text');
    });

    it('preserves label text and checked state for associated controls', () => {
        document.body.innerHTML = `
            <label for="for-choice">For label</label><input id="for-choice" type="checkbox" checked>
            <label>Wrapping label <input type="radio"></label>
            <span id="labelled">Aria labelled</span><input type="checkbox" aria-labelledby="labelled">
        `;

        const { html, tokens } = skeletonize(document.body);
        const markdown = rehydrate(html, tokens);
        expect(markdown).toContain('For label');
        expect(markdown).toContain('Wrapping label');
        expect(markdown).toContain('Aria labelled');
        expect(html).toContain('data-kind="checkbox"');
        expect(html).toContain('data-kind="radio"');
        expect(html).toContain('data-state="checked"');
        expect(html).toContain('data-state="unchecked"');
    });

    it('serializes selected options', () => {
        document.body.innerHTML = '<select multiple><optgroup label="A"><option selected>One</option></optgroup><option selected>Two</option></select>';

        expect(markdownFor(document.body)).toContain('One, Two');
    });

    it('serializes a zero-file selection as no files selected', () => {
        const { markdown } = skeletonizeFiles([]);

        expect(markdown).toContain('no files selected');
    });

    it('serializes one selected file name in tokenized and rehydrated text', () => {
        const { html, tokens, markdown } = skeletonizeFiles([
            new File(['secret body'], 'notes.txt', { type: 'text/plain' })
        ]);
        const tokenizedText = Object.values(tokens).join(' ');

        expect(tokenizedText).toContain('notes\\.txt');
        expect(markdown).toContain('notes\\.txt');
        expect(html).not.toContain('notes.txt');
        expect(markdown).not.toContain('secret body');
    });

    it('serializes multiple selected file names in tokenized and rehydrated text', () => {
        const { html, tokens, markdown } = skeletonizeFiles([
            new File(['secret body'], 'notes.txt', { type: 'text/plain' }),
            new File(['another secret'], 'image.png', { type: 'image/png' })
        ]);
        const tokenizedText = Object.values(tokens).join(' ');

        expect(tokenizedText).toContain('notes\\.txt');
        expect(tokenizedText).toContain('image\\.png');
        expect(markdown).toContain('notes\\.txt');
        expect(markdown).toContain('image\\.png');
        expect(html).not.toContain('notes.txt');
        expect(html).not.toContain('image.png');
        expect(markdown).not.toContain('secret body');
        expect(markdown).not.toContain('another secret');
    });

    it('does not read guarded password or hidden values', () => {
        document.body.innerHTML = '<input type="password"><input type="hidden">';
        for (const control of document.querySelectorAll('input')) {
            Object.defineProperty(control, 'value', { get: () => { throw new Error('value read'); } });
        }

        expect(() => skeletonize(document.body)).not.toThrow();
        const { html, tokens } = skeletonize(document.body);
        expect(html).not.toContain('value hidden');
        expect(Object.values(tokens)).not.toContain('value hidden');
    });

    it('does not tokenize structural markers while tokenizing value-bearing marker text', () => {
        document.body.innerHTML = `
            <label>First <input type="checkbox" checked> last</label>
            <label><input type="radio"> second</label>
            <input type="password" value="secret"><input type="hidden" value="internal">
            <input type="text" value="live"><select><option selected>Canada</option></select>
            <textarea>notes</textarea><input type="file">
        `;

        const { html, tokens } = skeletonize(document.body);
        const tokenizedText = Object.values(tokens).join(' ');

        expect(tokenizedText).not.toContain('Checkbox: checked');
        expect(tokenizedText).not.toContain('Radio: unchecked');
        expect(tokenizedText).not.toContain('value hidden');
        expect(tokenizedText).toContain('value: "live"');
        expect(tokenizedText).toContain('selected: "Canada"');
        expect(tokenizedText).toContain('value: "notes"');
        expect(tokenizedText).toContain('no files selected');
        expect(html).not.toContain('live');
        expect(html).not.toContain('Canada');
        expect(html).not.toContain('notes');
        expect(html).not.toContain('secret');
        expect(html).not.toContain('internal');
        expect(html.indexOf('{{MDZ0}}')).toBeLessThan(html.indexOf('data-kind="checkbox"'));
        expect(html.indexOf('data-kind="checkbox"')).toBeLessThan(html.indexOf('{{MDZ1}}'));
    });

    it('rehydrates a representative backend control response in label DOM order', () => {
        document.body.innerHTML = '<label>First <input type="checkbox" checked> last</label>';

        const { html, tokens } = skeletonize(document.body);
        const tokenIds = Object.keys(tokens);
        const backendMarkerResponse = `${tokenIds[0]} [Checkbox: checked] ${tokenIds[1]}`;

        expect(html).toContain('data-kind="checkbox"');
        expect(Object.values(tokens)).toEqual(['First', 'last']);
        expect(rehydrate(backendMarkerResponse, tokens)).toBe('First [Checkbox: checked] last');
    });

    it('retains controls through inactive tabs, nested layouts, lists, tables, and prose after code', () => {
        document.body.innerHTML = '<section class="tab"><div><table><tr><td><input value="table value"></td></tr></table><ul><li><input type="checkbox" checked> Item</li></ul></div></section><pre><code>const x = 1;</code></pre><p>After code <textarea>notes</textarea></p>';
        const { html, tokens } = skeletonize(document.body);
        const markdown = rehydrate(html, tokens);

        expect(markdown).toContain('table value');
        expect(html).toContain('data-kind="checkbox"');
        expect(html).toContain('data-state="checked"');
        expect(markdown).toContain('After code');
        expect(markdown).toContain('notes');
    });

    it.each([
        ['semantic root', () => getBestContent()],
        ['visible body', () => getVisibleBodyContent()],
    ])('keeps control state from a %s', (_name, extract) => {
        document.body.innerHTML = `<main><p>${'Context '.repeat(100)}</p><input value="extracted live"></main>`;
        const result = extract();
        expect(result).not.toBeNull();

        const { html, tokens } = skeletonize(result!.element);
        expect(html).not.toContain('extracted live');
        expect(rehydrate(html, tokens)).toContain('extracted live');
    });

    it('can skeletonize a Readability candidate containing surrounding control prose', () => {
        document.body.innerHTML = `<main><p>${'Context '.repeat(100)}</p><p>Choose an option below.</p><input value="extracted live"></main>`;
        const result = getReadabilityContent();
        expect(result).not.toBeNull();

        const { html, tokens } = skeletonize(result!.element);
        expect(html).not.toContain('Choose an option below.');
        expect(rehydrate(html, tokens)).toContain('Choose an option below\\.');
    });
});
