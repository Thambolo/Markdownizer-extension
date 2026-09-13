// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { getCaptureStrategy, SmartStrategy, FullPageStrategy } from '../src/content/strategies';
import { getContentForMode, selectCaptureRoot } from '../src/extraction/extractor';
import { ARTICLE_PAGE, MAIN_PAGE, BODY_PAGE, EMPTY_PAGE } from './helpers/fixtures';
import type { CaptureMode } from '../src/shared/preview-protocol';
import type { ExtractionOptions, InitialExtractionResult } from '../src/extraction/extractor';

const FIXTURES = [ARTICLE_PAGE, MAIN_PAGE, BODY_PAGE, EMPTY_PAGE];
const MODES: CaptureMode[] = ['smart', 'full-page'];
const OPTION_SETS: ExtractionOptions[] = [{}, { includeIframes: true }];

/**
 * Equivalence contract: the strategy extract result must deep-equal the
 * legacy getContentForMode result — same element.outerHTML, same strategy
 * label, same live sourceElement, and consistent null-ness.
 */
function compareExtraction(
    strategyResult: InitialExtractionResult | null,
    legacyResult: InitialExtractionResult | null,
): void {
    expect(strategyResult === null).toBe(legacyResult === null);
    expect(strategyResult?.strategy).toBe(legacyResult?.strategy);
    expect(strategyResult?.element?.outerHTML).toBe(legacyResult?.element?.outerHTML);
    expect(strategyResult?.sourceElement).toBe(legacyResult?.sourceElement);
}

function setupDom(html: string): void {
    document.documentElement.innerHTML = html;
}

describe('capture strategies equivalence contract', () => {
    it.each(FIXTURES.flatMap((fixture) => MODES.map((mode) => ({ fixture, mode }))))(
        'extract matches legacy getContentForMode ($fixture.name, $mode)',
        ({ fixture, mode }) => {
            setupDom(fixture.html);
            for (const options of OPTION_SETS) {
                compareExtraction(
                    getCaptureStrategy(mode).extract(options),
                    getContentForMode(mode, options),
                );
            }
        },
    );

    it.each(FIXTURES.flatMap((fixture) => MODES.map((mode) => ({ fixture, mode }))))(
        'selectRoot matches legacy selectCaptureRoot ($fixture.name, $mode)',
        ({ fixture, mode }) => {
            setupDom(fixture.html);
            expect(getCaptureStrategy(mode).selectRoot()).toBe(selectCaptureRoot(mode));
        },
    );

    it('returns the strategy matching the mode', () => {
        expect(getCaptureStrategy('smart')).toBeInstanceOf(SmartStrategy);
        expect(getCaptureStrategy('full-page')).toBeInstanceOf(FullPageStrategy);
    });
});

describe('unknown or undefined mode defaults to smart', () => {
    it('returns a smart strategy instance', () => {
        expect(getCaptureStrategy('bogus' as CaptureMode)).toBeInstanceOf(SmartStrategy);
        expect(getCaptureStrategy(undefined as unknown as CaptureMode)).toBeInstanceOf(SmartStrategy);
        expect(getCaptureStrategy('bogus' as CaptureMode).mode).toBe('smart');
        expect(getCaptureStrategy(undefined as unknown as CaptureMode).mode).toBe('smart');
    });

    it('extract matches legacy smart extraction', () => {
        setupDom(ARTICLE_PAGE.html);
        for (const mode of ['bogus' as CaptureMode, undefined as unknown as CaptureMode]) {
            for (const options of OPTION_SETS) {
                compareExtraction(
                    getCaptureStrategy(mode).extract(options),
                    getContentForMode('smart', options),
                );
            }
        }
    });

    it('selectRoot matches legacy smart selectRoot', () => {
        setupDom(ARTICLE_PAGE.html);
        expect(getCaptureStrategy('bogus' as CaptureMode).selectRoot()).toBe(selectCaptureRoot('smart'));
        expect(getCaptureStrategy(undefined as unknown as CaptureMode).selectRoot()).toBe(selectCaptureRoot('smart'));
    });
});