// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createSkeletonPipeline } from '../src/skeleton/pipeline';
import { SKELETON_PIPELINE, skeletonize } from '../src/skeleton/skeletonizer';
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

    it('production SKELETON_PIPELINE output matches skeletonize for order-insensitive fixtures', () => {
        // ACTUAL production order (locked behaviorally by the redoc golden test):
        // 1. recoverGeneratedText
        // 2. normalizeRenderedReDoc
        // 3. serializeNativeControls
        // 4. compactSkeleton
        //
        // This test consumes the exported SKELETON_PIPELINE constant — the very
        // pipeline process() runs — instead of re-declaring the composition, so
        // a future reorder inside skeletonizer.ts changes what this test locks
        // instead of silently drifting from the production order.
        // normalizeRenderedReDoc and compactSkeleton only mutate the element
        // they are passed, so they are wired to the CLONE (the bare module
        // references would be handed the live source root by the pipeline and
        // mutate the live page). Article/main fixtures carry no buttons,
        // inputs, or pseudo-element text, so they are order-insensitive: they
        // must match skeletonize both before and after the normalizeRenderedReDoc
        // move.
        for (const [name, html] of [['article', ARTICLE_PAGE.html], ['main', MAIN_PAGE.html]] as const) {
            const body = setupDom(html);
            const root = body.querySelector(name === 'article' ? 'article' : 'main') as HTMLElement;
            const clone = root.cloneNode(true) as HTMLElement;

            SKELETON_PIPELINE(root, clone);

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