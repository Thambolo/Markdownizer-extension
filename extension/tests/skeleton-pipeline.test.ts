// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createSkeletonPipeline } from '../src/skeleton/pipeline';
import { skeletonize } from '../src/skeleton/skeletonizer';
import { recoverGeneratedText } from '../src/skeleton/generated-text';
import { serializeNativeControls } from '../src/skeleton/native-controls';
import { normalizeRenderedReDoc } from '../src/skeleton/redoc-normalizer';
import { compactSkeleton } from '../src/skeleton/compactor';
import { ARTICLE_PAGE, MAIN_PAGE } from './helpers/fixtures';

function setupDom(html: string): HTMLElement {
    document.documentElement.innerHTML = html;
    return document.body;
}

describe('createSkeletonPipeline', () => {
    it('applies transforms in registration order with (root, clone)', () => {
        const order: string[] = [];
        const first = vi.fn(() => { order.push('first'); });
        const second = vi.fn(() => { order.push('second'); });

        const pipeline = createSkeletonPipeline([first, second]);
        const body = setupDom('<main><p>Hello</p></main>');
        const root = body.querySelector('main') as HTMLElement;
        const clone = root.cloneNode(true) as HTMLElement;

        pipeline(root, clone);

        expect(order).toEqual(['first', 'second']);
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(1);
        expect(first).toHaveBeenCalledWith(root, clone);
        expect(second).toHaveBeenCalledWith(root, clone);
    });

    it('composing the four real transforms matches skeletonize output for order-insensitive fixtures', () => {
        // Current pipeline order (pre-reorder): the contract that process()
        // applies these four transforms in sequence to (source, clone) and
        // then tokenizes. normalizeRenderedReDoc and compactSkeleton only
        // mutate the element they are passed, so they must be wired to the
        // CLONE (the bare module references would be handed the live source
        // root by the pipeline and mutate the live page). Article/main
        // fixtures carry no buttons, inputs, or pseudo-element text, so they
        // are order-insensitive: they must match skeletonize both before and
        // after the normalizeRenderedReDoc move.
        const pipeline = createSkeletonPipeline([
            recoverGeneratedText,
            (_root: HTMLElement, clone: HTMLElement) => { normalizeRenderedReDoc(clone); },
            serializeNativeControls,
            (_root: HTMLElement, clone: HTMLElement) => { compactSkeleton(clone); },
        ]);

        for (const [name, html] of [['article', ARTICLE_PAGE.html], ['main', MAIN_PAGE.html]] as const) {
            const body = setupDom(html);
            const root = body.querySelector(name === 'article' ? 'article' : 'main') as HTMLElement;
            const clone = root.cloneNode(true) as HTMLElement;

            pipeline(root, clone);

            // Tokenize the pipeline output exactly the way process() does.
            const viaPipeline = skeletonize(clone);
            const direct = skeletonize(root);
            expect(viaPipeline.html).toBe(direct.html);
            expect(viaPipeline.tokens).toEqual(direct.tokens);
        }
    });

    it('empty transform list is a no-op', () => {
        const pipeline = createSkeletonPipeline([]);
        const body = setupDom('<main data-x="1"><p>Hello</p></main>');
        const root = body.querySelector('main') as HTMLElement;
        const clone = root.cloneNode(true) as HTMLElement;
        const before = clone.outerHTML;

        pipeline(root, clone);

        expect(clone.outerHTML).toBe(before);
    });
});