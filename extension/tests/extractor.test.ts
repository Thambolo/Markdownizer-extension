import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { CapturePreview, PREVIEW_HOST_ATTRIBUTE } from '../src/capture-preview';
import { getBestContent, getVisibleBodyContent } from '../src/extractor';
import { skeletonize } from '../src/logic';

function setupDOM(html: string): void {
    const dom = new JSDOM(html, { url: 'https://example.test/', pretendToBeVisual: true });
    global.window = dom.window as unknown as Window & typeof globalThis;
    global.document = dom.window.document;
    global.NodeFilter = dom.window.NodeFilter;
    // @ts-expect-error - JSDOM global injection for browser-like extractor tests
    global.Node = dom.window.Node;
    // Expose JSDOM browser APIs as globals for CapturePreview tracking
    if (!global.MutationObserver) global.MutationObserver = dom.window.MutationObserver;
    if (!global.ResizeObserver) {
        global.ResizeObserver = dom.window.ResizeObserver ?? class {
            observe() {}
            unobserve() {}
            disconnect() {}
        } as unknown as typeof ResizeObserver;
    }
    if (!global.requestAnimationFrame) {
        global.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(cb, 0) as unknown as number;
    }
    if (!global.cancelAnimationFrame) {
        global.cancelAnimationFrame = (id: number) => clearTimeout(id);
    }
}

describe('visible-body extraction', () => {
    it('uses a semantic main element before the visible body', () => {
        setupDOM('<body><header>Site nav</header><main><h1>Assignment</h1><p>Instructions</p></main></body>');
        const result = getBestContent();

        expect(result?.strategy).toBe('semantic-html');
        expect(result?.element.tagName).toBe('MAIN');
    });

    it('clones semantic content while preserving hidden authored nodes', () => {
        setupDOM('<body><main><p hidden>Hidden text</p><p style="visibility: hidden">Invisible text</p><dialog>Closed dialog</dialog><p aria-hidden="true">ARIA label</p><p inert>Inert label</p><nav>Section navigation</nav><script>secret()</script><style>.x { color: red; }</style><noscript>No JavaScript</noscript><template>Template text</template></main></body>');
        const source = document.querySelector('main') as HTMLElement;
        const result = getBestContent();

        expect(result?.element).not.toBe(source);
        expect(result?.element.textContent).toContain('Hidden text');
        expect(result?.element.textContent).toContain('Invisible text');
        expect(result?.element.textContent).toContain('Closed dialog');
        expect(result?.element.textContent).toContain('ARIA label');
        expect(result?.element.textContent).toContain('Inert label');
        expect(result?.element.textContent).toContain('Section navigation');
        expect(result?.element.querySelector('script, style, noscript, template')).toBeNull();
        expect(source.querySelector('script')).not.toBeNull();
    });

    it('uses visible body content when no semantic root exists', () => {
        setupDOM('<body><div class="wrap"><h1>Assignment 2</h1><p>Submit Friday.</p><pre>g = f + d - e</pre></div></body>');
        const result = getBestContent();

        expect(result?.strategy).toBe('visible-body');
        expect(result?.element.textContent).toContain('Assignment 2');
        expect(result?.element.textContent).toContain('Submit Friday.');
    });

    it('removes non-content nodes while preserving hidden authored body content', () => {
        setupDOM('<body><header>Course navigation</header><script>secret()</script><style>.x { color: red; }</style><noscript>No JavaScript</noscript><template>template text</template><p hidden>Hidden text</p><p style="visibility: hidden">Invisible text</p><dialog>Closed dialog</dialog><p>Visible instructions</p></body>');
        const result = getVisibleBodyContent();

        expect(result?.element.textContent).toContain('Course navigation');
        expect(result?.element.textContent).toContain('Visible instructions');
        expect(result?.element.textContent).toContain('Hidden text');
        expect(result?.element.textContent).toContain('Invisible text');
        expect(result?.element.textContent).toContain('Closed dialog');
        expect(result?.element.querySelector('script, style, noscript, template')).toBeNull();
    });

    it('returns the live semantic source used to create the extraction clone', () => {
        setupDOM('<body><main><h1>Assignment</h1><script>ignore()</script></main></body>');
        const source = document.querySelector('main') as HTMLElement;

        const result = getBestContent();

        expect(result?.sourceElement).toBe(source);
        expect(result?.element).not.toBe(source);
        expect(result?.element.tagName).toBe('MAIN');
        expect(result?.element.querySelector('script')).toBeNull();
    });

    it('returns the live body when no usable semantic root exists', () => {
        setupDOM('<body><article>   </article><div>Visible instructions</div></body>');

        const result = getBestContent();

        expect(result?.strategy).toBe('visible-body');
        expect(result?.sourceElement).toBe(document.body);
        expect(result?.element).not.toBe(document.body);
    });
});

describe('Preview contamination regression', () => {
    it('never leaks CapturePreview markup or host into extraction or skeleton', () => {
        // Body-fallback page: no semantic root (no <main>, <article>, [role="main"])
        setupDOM('<body><h1>Assignment</h1><p>Submit Friday.</p></body>');

        // Show the preview overlay on document.body
        const preview = new CapturePreview();
        preview.show(document.body);

        // Extract content (should take the visible-body path)
        const extraction = getBestContent();
        expect(extraction).not.toBeNull();
        expect(extraction!.strategy).toBe('visible-body');

        // The extraction clone must not contain the preview host
        expect(extraction!.element.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`)).toBeNull();

        // Skeletonize the extraction result
        const skeleton = skeletonize(extraction!.element);

        // Skeleton HTML must not contain any preview-related markup or color
        expect(skeleton.html).not.toContain('markdownizer-preview');
        expect(skeleton.html).not.toContain('#6366f1');
        expect(skeleton.html).not.toContain(PREVIEW_HOST_ATTRIBUTE);

        // Token values must not contain the word 'Preview'
        const allTokenValues = Object.values(skeleton.tokens).join(' ');
        expect(allTokenValues).not.toContain('Preview');

        // Clean up
        preview.remove();
    });
});
