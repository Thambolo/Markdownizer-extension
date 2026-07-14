import { describe, expect, it } from 'vitest';
import { MAX_SKELETON_BYTES, shouldUseReadability, skeletonSize } from '../src/payload';

describe('payload sizing', () => {
    it('measures skeletons as UTF-8 bytes', () => {
        expect(skeletonSize('a')).toBe(1);
        expect(skeletonSize('§')).toBe(2);
    });

    it('accepts a skeleton exactly at the byte limit', () => {
        expect(shouldUseReadability('a'.repeat(MAX_SKELETON_BYTES))).toBe(false);
    });

    it('rejects a skeleton one byte over the limit', () => {
        expect(shouldUseReadability('a'.repeat(MAX_SKELETON_BYTES + 1))).toBe(true);
    });
});
