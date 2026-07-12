import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import {
    type ComputedStyleReader,
    parseGeneratedContent,
    recoverGeneratedText,
} from '../src/generated-text';

function roots(html: string): { source: HTMLElement; clone: HTMLElement } {
    const dom = new JSDOM(html);
    const source = dom.window.document.querySelector('#source') as HTMLElement;
    return { source, clone: source.cloneNode(true) as HTMLElement };
}

function reader(styles: Record<string, { before?: string; after?: string; visible?: boolean }>): ComputedStyleReader {
    return {
        content(element, pseudo) {
            const value = styles[element.id]?.[pseudo === '::before' ? 'before' : 'after'];
            return value ?? 'none';
        },
        textHasVisibleLayout(text) {
            const parentId = text.parentElement?.id;
            if (parentId && styles[parentId]?.visible !== undefined) {
                return styles[parentId].visible;
            }
            return true;
        },
    };
}

describe('parseGeneratedContent', () => {
    it.each([
        ['"- "', '- '],
        ["'wait-list'", 'wait-list'],
        ['none', null],
        ['normal', null],
        ['url(icon.svg)', null],
        ['counter(item)', null],
        ['counters(item, ".")', null],
        ['open-quote', null],
        ['close-quote', null],
        ['no-open-quote', null],
        ['no-close-quote', null],
        ['"left" "right"', null],
        ['""', null],
        ['"   "', null],
        ['plain-text', null],
        [`"${'x'.repeat(4096)}"`, 'x'.repeat(4096)],
        [`"${'x'.repeat(4097)}"`, null],
    ])('parses %j as %j', (content, expected) => {
        expect(parseGeneratedContent(content)).toBe(expected);
    });
});

it('inserts generated text into the clone without changing the source', () => {
    const { source, clone } = roots('<div id="source"><code id="code">g = f + d <span id="operator"></span>e</code></div>');

    recoverGeneratedText(source, clone, reader({ operator: { after: '"- "' } }));

    expect(source.querySelector('#operator')?.textContent).toBe('');
    expect(clone.querySelector('#code')?.textContent).toBe('g = f + d - e');
});

it('inserts before and after generated text around existing clone text', () => {
    const { source, clone } = roots('<div id="source"><span id="label">content</span></div>');

    recoverGeneratedText(source, clone, reader({ label: { before: '"["', after: '"]"' } }));

    expect(clone.querySelector('#label')?.textContent).toBe('[content]');
});

it('replaces one zero-size source text value with generated text', () => {
    const { source, clone } = roots('<div id="source"><span id="swap"><span id="hidden">rejected</span></span></div>');

    recoverGeneratedText(source, clone, reader({
        swap: { after: '"wait-list"' },
        hidden: { visible: false },
    }));

    expect(clone.textContent).toBe('wait-list');
});

it('keeps hidden text when source text has visible layout', () => {
    const { source, clone } = roots('<div id="source"><span id="swap"><span id="hidden">rejected</span></span></div>');

    recoverGeneratedText(source, clone, reader({
        swap: { after: '"wait-list"' },
        hidden: { visible: true },
    }));

    expect(clone.textContent).toBe('rejectedwait-list');
});

it('leaves an ambiguous replacement unchanged', () => {
    const { source, clone } = roots('<div id="source"><span id="swap"><span id="hidden">rejected</span><span>also visible</span></span></div>');

    recoverGeneratedText(source, clone, reader({ swap: { after: '"wait-list"' }, hidden: { visible: false } }));

    expect(clone.textContent).toBe('rejectedalso visiblewait-list');
});

it('leaves the clone unchanged when source and clone element counts differ', () => {
    const { source, clone } = roots('<div id="source"><span id="label">content</span></div>');
    clone.appendChild(clone.ownerDocument.createElement('span'));
    const original = clone.outerHTML;

    recoverGeneratedText(source, clone, reader({ label: { after: '"generated"' } }));

    expect(clone.outerHTML).toBe(original);
});
