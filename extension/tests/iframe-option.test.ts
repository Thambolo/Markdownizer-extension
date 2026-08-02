import { describe, expect, it } from 'vitest';
import {
    applyIframeEligibility,
    initialIframeOptionState,
    setIframePreference,
    isIframeIncluded,
} from '../src/popup/iframe-option';

describe('iframe popup option state', () => {
    it('defaults to auto and includes the first eligible result', () => {
        const state = initialIframeOptionState();
        expect(applyIframeEligibility(state, true)).toEqual({ eligible: true, preference: 'auto' });
        expect(isIframeIncluded(applyIframeEligibility(state, true))).toBe(true);
    });

    it('keeps an explicit exclusion through eligibility changes', () => {
        let state = applyIframeEligibility(initialIframeOptionState(), true);
        state = setIframePreference(state, 'exclude');
        state = applyIframeEligibility(state, false);
        state = applyIframeEligibility(state, true);
        expect(state.preference).toBe('exclude');
        expect(isIframeIncluded(state)).toBe(false);
    });

    it('allows an explicit re-enable after exclusion', () => {
        let state = applyIframeEligibility(initialIframeOptionState(), true);
        state = setIframePreference(state, 'exclude');
        state = setIframePreference(state, 'include');
        state = applyIframeEligibility(state, true);
        expect(isIframeIncluded(state)).toBe(true);
    });
});
