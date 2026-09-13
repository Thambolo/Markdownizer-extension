import { describe, expect, it } from 'vitest';
import { normalizeZipPhase, withZipDoneDefaults } from '../src/zip/protocol';

describe('zip protocol normalization', () => {
    it.each([
        ['build', 'build'], ['fetch', 'fetch'], [undefined, 'fetch'], ['weird', 'fetch'], [null, 'fetch'],
    ])('normalizeZipPhase(%s) → %s', (input, expected) => {
        expect(normalizeZipPhase(input as string | null | undefined)).toBe(expected);
    });

    it('withZipDoneDefaults fills every field with documented defaults', () => {
        expect(withZipDoneDefaults({})).toEqual({
            downloaded: 'md', filename: 'download', totalImages: 0, bundledImages: 0, skippedImages: 0,
        });
        expect(withZipDoneDefaults({ downloaded: 'zip', filename: 'page.zip', totalImages: 1, bundledImages: 1, skippedImages: 0 }))
            .toEqual({ downloaded: 'zip', filename: 'page.zip', totalImages: 1, bundledImages: 1, skippedImages: 0 });
    });
});
