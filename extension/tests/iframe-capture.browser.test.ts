import { afterEach, describe, expect, it } from 'vitest';
import { getVisibleBodyContent } from '../src/extraction/extractor';
import { hasImagesInRoot } from '../src/extraction/iframe-capture';

afterEach(() => {
    document.body.replaceChildren();
});

function waitForLoad(iframe: HTMLIFrameElement): Promise<void> {
    return new Promise((resolve) => iframe.addEventListener('load', () => resolve(), { once: true }));
}

async function appendLoadedFrame(ownerDocument: Document, srcdoc: string, title: string): Promise<HTMLIFrameElement> {
    const iframe = ownerDocument.createElement('iframe');
    iframe.title = title;
    iframe.srcdoc = srcdoc;
    const loaded = waitForLoad(iframe);
    ownerDocument.body.appendChild(iframe);
    await loaded;
    return iframe;
}

describe('same-origin iframe extraction in Chromium', () => {
    it('captures a loaded srcdoc iframe in DOM order with a label', async () => {
        document.body.innerHTML = '<p>Parent before</p><iframe title="Embedded widget" srcdoc="<h2>Frame heading</h2><p>Frame body</p>"></iframe><p>Parent after</p>';
        const iframe = document.querySelector('iframe') as HTMLIFrameElement;
        await waitForLoad(iframe);

        const result = getVisibleBodyContent(document.body, { includeIframes: true });

        expect(result?.element.textContent).toContain('Parent before');
        expect(result?.element.textContent).toContain('Frame heading');
        expect(result?.element.textContent).toContain('Frame body');
        expect(result?.element.textContent).toContain('Parent after');
        expect(result?.element.querySelector('iframe')).toBeNull();
        expect(result?.element.querySelector('strong')?.textContent).toContain('Embedded widget');
    });

    it('skips an empty same-origin iframe without failing the parent extraction', async () => {
        document.body.innerHTML = '<p>Parent content</p><iframe srcdoc=""></iframe>';
        const iframe = document.querySelector('iframe') as HTMLIFrameElement;
        await waitForLoad(iframe);

        const result = getVisibleBodyContent(document.body, { includeIframes: true });

        expect(result?.element.textContent).toContain('Parent content');
        expect(result?.element.querySelector('section')).toBeNull();
    });

    it('includes only the first three nested frame documents', async () => {
        document.body.innerHTML = '<p>Parent content</p>';
        let frame = await appendLoadedFrame(document, '<p>Depth 1</p>', 'Depth 1');

        for (let depth = 2; depth <= 4; depth += 1) {
            const frameDocument = frame.contentDocument;
            expect(frameDocument?.body).not.toBeNull();
            frame = await appendLoadedFrame(frameDocument!, `<p>Depth ${depth}</p>`, `Depth ${depth}`);
        }

        const result = getVisibleBodyContent(document.body, { includeIframes: true });
        const text = result?.element.textContent ?? '';

        expect(text).toContain('Depth 1');
        expect(text).toContain('Depth 2');
        expect(text).toContain('Depth 3');
        expect(text).not.toContain('Depth 4');
    });

    it('stops after the first twenty iframe documents in depth-first order', async () => {
        document.body.replaceChildren();
        const frames = Array.from({ length: 21 }, (_, index) => {
            const iframe = document.createElement('iframe');
            iframe.title = `Sibling ${index}`;
            iframe.srcdoc = `<p>Sibling content ${index}</p>`;
            document.body.appendChild(iframe);
            return iframe;
        });
        await Promise.all(frames.map(waitForLoad));

        const result = getVisibleBodyContent(document.body, { includeIframes: true });
        const text = result?.element.textContent ?? '';

        expect(text).toContain('Sibling content 0');
        expect(text).toContain('Sibling content 19');
        expect(text).not.toContain('Sibling content 20');
    });
});

describe('hasImagesInRoot (browser)', () => {
    it('flips to true when an img is added later', () => {
        const root = document.createElement('div');
        document.body.appendChild(root);
        expect(hasImagesInRoot(root)).toBe(false);
        const img = document.createElement('img');
        img.src = 'https://example.com/lazy.png';
        root.appendChild(img);
        expect(hasImagesInRoot(root)).toBe(true);
        root.remove();
    });

    it('flips to true when an existing img gains a src', () => {
        const root = document.createElement('div');
        document.body.appendChild(root);
        const img = document.createElement('img');
        root.appendChild(img);
        expect(hasImagesInRoot(root)).toBe(false);
        img.src = 'https://example.com/real.png';
        expect(hasImagesInRoot(root)).toBe(true);
        root.remove();
    });
});
