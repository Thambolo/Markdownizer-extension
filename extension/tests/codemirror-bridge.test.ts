import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';

// ── DOM helpers ─────────────────────────────────────────────────────────────

function setupDOM(html: string, url = 'https://example.test/'): void {
    const dom = new JSDOM(html, { url, pretendToBeVisual: true });
    global.window = dom.window as unknown as Window & typeof globalThis;
    global.document = dom.window.document;
    // @ts-expect-error - JSDOM global injection
    global.NodeFilter = dom.window.NodeFilter;
    // @ts-expect-error - JSDOM global injection
    if (!global.Node) global.Node = dom.window.Node;
}

describe('bodyRelativePath (via collectCodeMirrorCaptureInMainWorld)', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        document.body.replaceChildren();
    });

    it('returns path [0] for the first child of body', () => {
        setupDOM('<body><div class="CodeMirror"></div></body>');
        const editor = document.querySelector('.CodeMirror') as HTMLElement;
        Object.defineProperty(editor, 'CodeMirror', {
            configurable: true,
            value: { getValue: () => 'hello' },
        });

        // Dynamic import to get the module after DOM setup
        return import('../src/extraction/codemirror-bridge').then(({ collectCodeMirrorCaptureInMainWorld }) => {
            const capture = collectCodeMirrorCaptureInMainWorld();
            expect(capture.editors).toHaveLength(1);
            expect(capture.editors[0].path).toEqual([0]);
            expect(capture.editors[0].value).toBe('hello');
        });
    });

    it('returns nested path for a deeply nested editor', () => {
        setupDOM('<body><div><div><div class="CodeMirror"></div></div></div></body>');
        const editor = document.querySelector('.CodeMirror') as HTMLElement;
        Object.defineProperty(editor, 'CodeMirror', {
            configurable: true,
            value: { getValue: () => 'deep value' },
        });

        return import('../src/extraction/codemirror-bridge').then(({ collectCodeMirrorCaptureInMainWorld }) => {
            const capture = collectCodeMirrorCaptureInMainWorld();
            expect(capture.editors).toHaveLength(1);
            expect(capture.editors[0].path).toEqual([0, 0, 0]);
            expect(capture.editors[0].value).toBe('deep value');
        });
    });
});

describe('collectCodeMirrorCaptureInMainWorld', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        document.body.replaceChildren();
    });

    it('captures a single CodeMirror editor value from the main document', () => {
        setupDOM('<body><div class="CodeMirror"><div class="CodeMirror-code"><pre>visible line 1</pre></div></div></body>');
        const editor = document.querySelector('.CodeMirror') as HTMLElement;
        Object.defineProperty(editor, 'CodeMirror', {
            configurable: true,
            value: { getValue: () => 'line 1\nline 2\nline 3' },
        });

        return import('../src/extraction/codemirror-bridge').then(({ collectCodeMirrorCaptureInMainWorld }) => {
            const capture = collectCodeMirrorCaptureInMainWorld();
            expect(capture.editors).toHaveLength(1);
            expect(capture.editors[0].value).toBe('line 1\nline 2\nline 3');
            expect(capture.editors[0].path).toEqual([0]);
            expect(Object.keys(capture.frames)).toHaveLength(0);
        });
    });

    it('captures editors from both main document and a same-origin iframe', () => {
        setupDOM('<body><div class="CodeMirror"></div><iframe title="Widget"></iframe></body>');

        const mainEditor = document.querySelector('.CodeMirror') as HTMLElement;
        Object.defineProperty(mainEditor, 'CodeMirror', {
            configurable: true,
            value: { getValue: () => 'main editor content' },
        });

        const iframe = document.querySelector('iframe') as HTMLIFrameElement;
        const frameDocument = new JSDOM(
            '<body><div class="CodeMirror"></div></body>',
            { url: 'https://example.test/widget' },
        ).window.document;
        const frameEditor = frameDocument.querySelector('.CodeMirror') as HTMLElement;
        Object.defineProperty(frameEditor, 'CodeMirror', {
            configurable: true,
            value: { getValue: () => 'iframe editor content' },
        });
        Object.defineProperty(iframe, 'contentDocument', { configurable: true, get: () => frameDocument });

        return import('../src/extraction/codemirror-bridge').then(({ collectCodeMirrorCaptureInMainWorld }) => {
            const capture = collectCodeMirrorCaptureInMainWorld();
            expect(capture.editors).toHaveLength(1);
            expect(capture.editors[0].value).toBe('main editor content');

            const frameKeys = Object.keys(capture.frames);
            expect(frameKeys).toHaveLength(1);
            // The iframe is the second child of body (index 1)
            const frameCapture = capture.frames[frameKeys[0]];
            expect(frameCapture.editors).toHaveLength(1);
            expect(frameCapture.editors[0].value).toBe('iframe editor content');
        });
    });

    it('skips an editor whose getValue throws', () => {
        setupDOM('<body><div class="CodeMirror"></div><div class="CodeMirror"></div></body>');
        const editors = document.querySelectorAll('.CodeMirror');

        Object.defineProperty(editors[0], 'CodeMirror', {
            configurable: true,
            value: { getValue: () => { throw new Error('broken'); } },
        });
        Object.defineProperty(editors[1], 'CodeMirror', {
            configurable: true,
            value: { getValue: () => 'good editor' },
        });

        return import('../src/extraction/codemirror-bridge').then(({ collectCodeMirrorCaptureInMainWorld }) => {
            const capture = collectCodeMirrorCaptureInMainWorld();
            expect(capture.editors).toHaveLength(1);
            expect(capture.editors[0].value).toBe('good editor');
        });
    });

    it('skips an editor whose getValue returns a non-string', () => {
        setupDOM('<body><div class="CodeMirror"></div></body>');
        const editor = document.querySelector('.CodeMirror') as HTMLElement;
        Object.defineProperty(editor, 'CodeMirror', {
            configurable: true,
            value: { getValue: () => 42 },
        });

        return import('../src/extraction/codemirror-bridge').then(({ collectCodeMirrorCaptureInMainWorld }) => {
            const capture = collectCodeMirrorCaptureInMainWorld();
            expect(capture.editors).toHaveLength(0);
        });
    });

    it('skips a .CodeMirror host without a CodeMirror property', () => {
        setupDOM('<body><div class="CodeMirror"></div></body>');

        return import('../src/extraction/codemirror-bridge').then(({ collectCodeMirrorCaptureInMainWorld }) => {
            const capture = collectCodeMirrorCaptureInMainWorld();
            expect(capture.editors).toHaveLength(0);
        });
    });

    it('returns empty capture when no editors exist', () => {
        setupDOM('<body><p>No editors here</p></body>');

        return import('../src/extraction/codemirror-bridge').then(({ collectCodeMirrorCaptureInMainWorld }) => {
            const capture = collectCodeMirrorCaptureInMainWorld();
            expect(capture.editors).toHaveLength(0);
            expect(Object.keys(capture.frames)).toHaveLength(0);
        });
    });

    it('skips cross-origin iframes (contentDocument throws)', () => {
        setupDOM('<body><iframe src="https://other.example.com"></iframe></body>');
        const iframe = document.querySelector('iframe') as HTMLIFrameElement;
        Object.defineProperty(iframe, 'contentDocument', {
            configurable: true,
            get: () => { throw new DOMException('Blocked a frame with origin "null"', 'SecurityError'); },
        });

        return import('../src/extraction/codemirror-bridge').then(({ collectCodeMirrorCaptureInMainWorld }) => {
            const capture = collectCodeMirrorCaptureInMainWorld();
            expect(Object.keys(capture.frames)).toHaveLength(0);
        });
    });

    it('handles nested iframes with distinct path keys', () => {
        setupDOM('<body><iframe id="outer"></iframe></body>');

        const outerIframe = document.querySelector('#outer') as HTMLIFrameElement;
        const outerDoc = new JSDOM(
            '<body><iframe id="inner"></iframe></body>',
            { url: 'https://example.test/outer' },
        ).window.document;
        Object.defineProperty(outerIframe, 'contentDocument', { configurable: true, get: () => outerDoc });

        const innerIframe = outerDoc.querySelector('#inner') as HTMLIFrameElement;
        const innerDoc = new JSDOM(
            '<body><div class="CodeMirror"></div></body>',
            { url: 'https://example.test/inner' },
        ).window.document;
        const innerEditor = innerDoc.querySelector('.CodeMirror') as HTMLElement;
        Object.defineProperty(innerEditor, 'CodeMirror', {
            configurable: true,
            value: { getValue: () => 'nested editor' },
        });
        Object.defineProperty(innerIframe, 'contentDocument', { configurable: true, get: () => innerDoc });

        return import('../src/extraction/codemirror-bridge').then(({ collectCodeMirrorCaptureInMainWorld }) => {
            const capture = collectCodeMirrorCaptureInMainWorld();
            const outerFrameKey = Object.keys(capture.frames)[0];
            const outerFrameCapture = capture.frames[outerFrameKey];
            expect(outerFrameCapture.editors).toHaveLength(0);

            const innerFrameKeys = Object.keys(outerFrameCapture.frames);
            expect(innerFrameKeys).toHaveLength(1);
            const innerFrameCapture = outerFrameCapture.frames[innerFrameKeys[0]];
            expect(innerFrameCapture.editors).toHaveLength(1);
            expect(innerFrameCapture.editors[0].value).toBe('nested editor');
        });
    });
});
