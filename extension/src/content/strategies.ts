import { hasOrdinaryText } from '../shared/dom-traversal';
import { sanitizeVisibleContent } from '../extraction/sanitize';
import type { ExtractionOptions, InitialExtractionResult } from '../extraction/extractor';
import type { CaptureMode } from '../shared/preview-protocol';

/**
 * Capture strategies: each mode of conversion and preview root selection is
 * a strategy with a root-selection policy and an extraction policy.
 * Priority for the smart strategy: Semantic HTML > visible body.
 */

export interface CaptureStrategy {
    readonly mode: CaptureMode;
    selectRoot(): HTMLElement | null;
    extract(options: ExtractionOptions): InitialExtractionResult | null;
}

/**
 * Smart extraction: prefer a semantic landmark (article → main → [role=main])
 * with ordinary text, fall back to the whole visible body.
 */
export class SmartStrategy implements CaptureStrategy {
    readonly mode: CaptureMode = 'smart';

    selectRoot(): HTMLElement | null {
        const candidates = [
            document.querySelector<HTMLElement>('article'),
            document.querySelector<HTMLElement>('main'),
            document.querySelector<HTMLElement>('[role="main"]'),
        ];
        return candidates.find((candidate) => candidate && hasOrdinaryText(candidate))
            ?? document.body;
    }

    extract(options: ExtractionOptions = {}): InitialExtractionResult | null {
        return getBestContent(options);
    }
}

/**
 * Full-page extraction: always use the whole visible body.
 */
export class FullPageStrategy implements CaptureStrategy {
    readonly mode: CaptureMode = 'full-page';

    selectRoot(): HTMLElement | null {
        return document.body;
    }

    extract(options: ExtractionOptions = {}): InitialExtractionResult | null {
        return getVisibleBodyContent(document.body, options);
    }
}

export function getCaptureStrategy(mode: CaptureMode): CaptureStrategy {
    return mode === 'full-page' ? new FullPageStrategy() : new SmartStrategy();
}

export function getBestContent(options: ExtractionOptions = {}): InitialExtractionResult | null {
    const semanticSources = [
        document.querySelector<HTMLElement>('article'),
        document.querySelector<HTMLElement>('main'),
        document.querySelector<HTMLElement>('[role="main"]')
    ];

    for (const semanticSource of semanticSources) {
        if (!semanticSource) continue;
        const semanticContent = sanitizeVisibleContent(semanticSource, options);
        if (semanticContent) {
            return {
                element: semanticContent,
                sourceElement: semanticSource,
                strategy: 'semantic-html'
            };
        }
    }

    return getVisibleBodyContent(document.body, options);
}

export function getVisibleBodyContent(
    sourceRoot: HTMLElement = document.body,
    options: ExtractionOptions = {},
): InitialExtractionResult | null {
    if (!sourceRoot) return null;

    const body = sanitizeVisibleContent(sourceRoot, options);
    return body
        ? { element: body, sourceElement: sourceRoot, strategy: 'visible-body' }
        : null;
}