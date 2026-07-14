import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { serializeNativeControls } from '../src/native-controls';

function roots(html: string): { source: HTMLElement, clone: HTMLElement } {
    const dom = new JSDOM(html);
    const source = dom.window.document.querySelector('#source') as HTMLElement;
    return { source, clone: source.cloneNode(true) as HTMLElement };
}

describe('serializeNativeControls', () => {
    it('serializes text input placeholder and value into clone text', () => {
        const { source, clone } = roots('<div id="source"><input type="text" placeholder="Search" value="initial"></div>');
        const input = source.querySelector('input') as HTMLInputElement;
        input.value = 'edited';
        const sourceHtml = source.innerHTML;

        serializeNativeControls(source, clone);

        expect(clone.querySelector('mdz-control')?.getAttribute('data-kind')).toBe('input');
        expect(clone.querySelector('mdz-control')?.textContent).toBe('placeholder: "Search"; value: "edited"');
        expect(source.innerHTML).toBe(sourceHtml);
        expect(source.querySelector('input')?.value).toBe('edited');
    });

    it('does not read password or hidden values or emit marker text for them', () => {
        const { source, clone } = roots('<div id="source"><input type="password"><input type="hidden"></div>');
        const controls = Array.from(source.querySelectorAll('input'));
        for (const control of controls) {
            Object.defineProperty(control, 'value', { get: () => { throw new Error('value read'); } });
        }

        expect(() => serializeNativeControls(source, clone)).not.toThrow();
        expect(clone.textContent).toBe('');
        expect(clone.textContent).not.toContain('value read');
    });

    it('classifies disabled text inputs with their normal value marker', () => {
        const { source, clone } = roots('<div id="source"><input type="text" disabled value="Visible disabled value"></div>');

        serializeNativeControls(source, clone);

        const marker = clone.querySelector('mdz-control');
        expect(marker?.getAttribute('data-kind')).toBe('input');
        expect(marker?.getAttribute('data-type')).toBe('text');
        expect(marker?.getAttribute('data-state')).toBe('value');
        expect(marker?.textContent).toBe('value: "Visible disabled value"');
    });

    it.each([
        ['text', '<input type="text" value="x">', 'input'],
        ['search', '<input type="search" value="x">', 'input'],
        ['email', '<input type="email" value="x">', 'input'],
        ['url', '<input type="url" value="x">', 'input'],
        ['tel', '<input type="tel" value="x">', 'input'],
        ['number', '<input type="number" value="2">', 'input'],
        ['date', '<input type="date" value="2026-07-14">', 'input'],
        ['time', '<input type="time" value="12:30">', 'input'],
        ['datetime-local', '<input type="datetime-local" value="2026-07-14T12:30">', 'input'],
        ['month', '<input type="month" value="2026-07">', 'input'],
        ['week', '<input type="week" value="2026-W29">', 'input'],
        ['range', '<input type="range" value="7">', 'input'],
        ['color', '<input type="color" value="#112233">', 'input'],
        ['checkbox', '<input type="checkbox" checked>', 'checkbox'],
        ['radio', '<input type="radio">', 'radio'],
        ['file', '<input type="file">', 'file'],
        ['submit', '<input type="submit" value="Send">', 'button'],
        ['reset', '<input type="reset" value="Clear">', 'button'],
        ['button', '<input type="button" value="Open">', 'button'],
        ['image', '<input type="image" alt="Map">', 'button'],
        ['select', '<select><option selected>Canada</option></select>', 'select'],
        ['textarea', '<textarea>Notes</textarea>', 'textarea'],
    ])('classifies %s controls', (type, control, kind) => {
        const { source, clone } = roots(`<div id="source">${control}</div>`);

        serializeNativeControls(source, clone);

        const marker = clone.querySelector('mdz-control');
        expect(marker?.getAttribute('data-kind')).toBe(kind);
        expect(marker?.getAttribute('data-type')).toBe(type);
        expect(marker?.attributes.length).toBe(3);
        if (['checkbox', 'radio', 'password', 'hidden'].includes(type)) {
            expect(marker?.textContent).toBe('');
        } else {
            expect(marker?.textContent).not.toBe('');
        }
    });

    it('leaves the clone unchanged when source and clone controls cannot be paired', () => {
        const { source, clone } = roots('<div id="source"><input value="live"></div>');
        clone.append(clone.ownerDocument.createElement('textarea'));
        const before = clone.innerHTML;

        serializeNativeControls(source, clone);

        expect(clone.innerHTML).toBe(before);
        expect(source.querySelector('input')?.value).toBe('live');
    });
});
