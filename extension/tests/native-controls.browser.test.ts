import { afterEach, describe, expect, it } from 'vitest';
import { getBestContent, getReadabilityContent, getVisibleBodyContent } from '../src/extractor';
import { skeletonize } from '../src/logic';

afterEach(() => document.body.replaceChildren());

describe('native controls in Chromium', () => {
    it('serializes readable control state into tokens while keeping markers structural', () => {
        document.body.innerHTML = '<label>Choice <input type="checkbox" checked></label><input value="live"><select><option selected>Canada</option></select><textarea>notes</textarea>';
        const { html, tokens } = skeletonize(document.body);

        expect(html).toContain('data-kind="checkbox"');
        expect(html).toContain('data-state="checked"');
        expect(html).not.toContain('live');
        expect(Object.values(tokens)).toContain('value: "live"');
        expect(Object.values(tokens)).toContain('selected: "Canada"');
        expect(Object.values(tokens)).toContain('value: "notes"');
    });

    it('does not read password or hidden values', () => {
        document.body.innerHTML = '<input type="password" value="secret"><input type="hidden" value="internal">';
        const { html, tokens } = skeletonize(document.body);

        expect(html).not.toContain('secret');
        expect(html).not.toContain('internal');
        expect(Object.values(tokens)).not.toContain('secret');
        expect(Object.values(tokens)).not.toContain('internal');
    });

    it.each([
        ['selected options', '<select multiple><option selected>One</option><option selected>Two</option></select>', 'One, Two'],
        ['button labels', '<button>Visible text</button>', 'Visible text'],
        ['file controls', '<input type="file">', 'no files selected'],
        ['textarea values', '<textarea>line one\nline two</textarea>', 'value: "line one\\nline two"'],
        ['input values', '<input value="live">', 'value: "live"'],
        ['radio markers', '<input type="radio" checked>', ''],
        ['checkbox markers', '<input type="checkbox" checked>', ''],
        ['disabled input values', '<input disabled value="visible">', 'value: "visible"'],
        ['associated labels', '<label for="choice">Choice</label><input id="choice" type="checkbox">', 'Choice'],
        ['control order', '<input value="first"><select><option selected>second</option></select>', 'value: "first"'],
        ['structural markers', '<label>First <input type="checkbox" checked> last</label>', 'First'],
    ])('captures %s without raw rehydration', (_name, html, expected) => {
        document.body.innerHTML = html;
        const { tokens } = skeletonize(document.body);
        if (expected) expect(Object.values(tokens).join(' ')).toContain(expected);
    });

    it('keeps selected file names but excludes file bodies', () => {
        document.body.innerHTML = '<input type="file">';
        const input = document.querySelector('input') as HTMLInputElement;
        const transfer = new DataTransfer();
        transfer.items.add(new File(['secret body'], 'notes.txt'));
        Object.defineProperty(input, 'files', { value: transfer.files });
        const { html, tokens } = skeletonize(document.body);
        expect(Object.values(tokens).join(' ')).toContain('notes.txt');
        expect(Object.values(tokens).join(' ')).not.toContain('secret body');
        expect(html).not.toContain('notes.txt');
    });

    it('keeps multiple selected file names while excluding all file bodies', () => {
        document.body.innerHTML = '<input type="file">';
        const transfer = new DataTransfer();
        transfer.items.add(new File(['first secret'], 'notes.txt'));
        transfer.items.add(new File(['second secret'], 'image.png'));
        Object.defineProperty(document.querySelector('input'), 'files', { value: transfer.files });
        const values = Object.values(skeletonize(document.body).tokens).join(' ');
        expect(values).toContain('notes.txt');
        expect(values).toContain('image.png');
        expect(values).not.toContain('first secret');
        expect(values).not.toContain('second secret');
    });

    it('captures button fallback variants', () => {
        document.body.innerHTML = '<button>Visible text</button><button aria-label="Aria label"></button><input type="button" value="Input value"><input type="image" alt="Image alt"><input type="submit">';
        const values = Object.values(skeletonize(document.body).tokens).join(' ');
        for (const expected of ['Visible text', 'Aria label', 'Input value', 'Image alt', 'submit']) expect(values).toContain(expected);
    });

    it('does not read guarded password or hidden properties', () => {
        document.body.innerHTML = '<input type="password"><input type="hidden">';
        for (const input of document.querySelectorAll('input')) Object.defineProperty(input, 'value', { get: () => { throw new Error('value read'); } });
        expect(() => skeletonize(document.body)).not.toThrow();
    });

    it('preserves native-control marker source order', () => {
        document.body.innerHTML = '<input value="one"><input type="checkbox"><select><option selected>two</option></select>';
        const { html } = skeletonize(document.body);
        expect(html.indexOf('data-kind="input"')).toBeLessThan(html.indexOf('data-kind="checkbox"'));
        expect(html.indexOf('data-kind="checkbox"')).toBeLessThan(html.indexOf('data-kind="select"'));
    });

    it('keeps controls in nested layouts after code', () => {
        document.body.innerHTML = '<section><table><tr><td><input value="table value"></td></tr></table><pre><code>const x = 1;</code></pre><p>After <textarea>notes</textarea></p></section>';
        const { html, tokens } = skeletonize(document.body);
        expect(html).toContain('data-kind="input"');
        expect(Object.values(tokens).join(' ')).toContain('table value');
        expect(Object.values(tokens).join(' ')).toContain('value: "notes"');
    });

    it.each([
        ['semantic root', () => getBestContent()],
        ['visible body', () => getVisibleBodyContent()],
    ])('captures live values from a %s extraction', (_name, extract) => {
        document.body.innerHTML = `<main><p>${'Context '.repeat(100)}</p><input value="extracted live"></main>`;
        const result = extract();
        expect(result).not.toBeNull();
        expect(Object.values(skeletonize(result!.element).tokens).join(' ')).toContain('extracted live');
    });

    it('captures surrounding control prose through Readability', () => {
        document.body.innerHTML = `<main><p>${'Context '.repeat(100)}</p><p>Choose an option below.</p><input value="extracted live"></main>`;
        const result = getReadabilityContent();
        expect(result).not.toBeNull();
        expect(Object.values(skeletonize(result!.element).tokens).join(' ')).toContain('Choose an option below.');
    });
});
