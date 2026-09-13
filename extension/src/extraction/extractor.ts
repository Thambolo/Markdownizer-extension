import { Readability } from './readability.js';
import { recoverGeneratedText } from '../skeleton/generated-text.js';
import type { CaptureMode } from '../shared/preview-protocol.js';
import type { CodeMirrorDocumentCapture } from './codemirror-bridge';
import { getCaptureStrategy } from '../content/strategies';
import {
    hasEligibleIframesInRoot,
    type IframeSanitizer,
} from './iframe-capture';
import { sanitizeVisibleContent } from './sanitize';

export { getBestContent, getVisibleBodyContent } from '../content/strategies';
export { sanitizeVisibleContent } from './sanitize';

/**
 * Extractor Module
 * Priority: capture strategies (content/strategies.ts) do Semantic HTML >
 * visible body; Readability remains the fallback used by the conversion
 * pipeline for oversized smart-mode extractions.
 */

export interface ExtractionResult {
    element: HTMLElement;
    strategy: string;
}

export interface InitialExtractionResult extends ExtractionResult {
    sourceElement: HTMLElement;
}

export interface ExtractionOptions {
    includeIframes?: boolean;
    codeMirrorCapture?: CodeMirrorDocumentCapture;
}

export function getReadabilityContent(): ExtractionResult | null {
    const clone = document.cloneNode(true) as Document;
    if (!document.body || !clone.body) return null;

    recoverGeneratedText(document.body, clone.body);
    // @ts-expect-error - Readability is a JS library without types here
    const article = new Readability(clone).parse();
    if (!article?.content) return null;

    const element = document.createElement('div');
    element.innerHTML = article.content;
    return { element, strategy: 'readability' };
}

export function getContentForMode(
    mode: CaptureMode,
    options: ExtractionOptions = {},
): InitialExtractionResult | null {
    return getCaptureStrategy(mode).extract(options);
}

export function selectCaptureRoot(mode: CaptureMode): HTMLElement | null {
    return getCaptureStrategy(mode).selectRoot();
}

/**
 * Extraction-path iframe eligibility check.
 *
 * Preview startup must use hasEligibleIframesLightweight() instead; this
 * helper intentionally performs the full sanitizing traversal.
 */
export function hasEligibleIframesByExtraction(sourceRoot: HTMLElement): boolean {
    const sanitizeFrame: IframeSanitizer = (frameRoot, sharedBudget, frameDepth, framePath) => {
        void framePath;
        return sanitizeVisibleContent(frameRoot, { includeIframes: true }, sharedBudget, frameDepth);
    };
    return hasEligibleIframesInRoot(sourceRoot, sanitizeFrame);
}
