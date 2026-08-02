import { Readability } from './readability.js';
import { recoverGeneratedText } from './generated-text.js';
import { serializeNativeControls } from './native-controls';
import type { CaptureMode } from './preview-protocol.js';
import {
    createIframeBudget,
    expandSameOriginIframes,
    hasEligibleIframesInRoot,
    type IframeBudget,
    type IframeSanitizer,
} from './iframe-capture';

/**
 * Extractor Strategy Module
 * Priority: Semantic HTML > visible body > Readability (Fallback)
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

function sanitizeVisibleContent(
    sourceRoot: HTMLElement,
    options: ExtractionOptions = {},
    budget: IframeBudget = createIframeBudget(),
    rootDepth = 0,
    serializeControls = false,
): HTMLElement | null {
    const sourceElements = [sourceRoot, ...Array.from(sourceRoot.querySelectorAll<HTMLElement>('*'))];
    const cloneRoot = sourceRoot.cloneNode(true) as HTMLElement;
    const cloneElements = [cloneRoot, ...Array.from(cloneRoot.querySelectorAll<HTMLElement>('*'))];
    if (sourceElements.length !== cloneElements.length) return null;

    recoverGeneratedText(sourceRoot, cloneRoot, undefined, (source) => !isNonContentElement(source));
    if (options.includeIframes === true) {
        const sanitizeFrame: IframeSanitizer = (frameRoot, sharedBudget, frameDepth) =>
            sanitizeVisibleContent(frameRoot, options, sharedBudget, frameDepth, true);
        expandSameOriginIframes(sourceRoot, cloneRoot, sanitizeFrame, budget, rootDepth + 1);
    }
    sourceElements.forEach((source, index) => {
        const clone = cloneElements[index];
        if (cloneRoot.contains(clone) && isNonContentElement(source)) clone.remove();
    });

    if (serializeControls) serializeNativeControls(sourceRoot, cloneRoot);

    return cloneRoot.textContent?.trim() ? cloneRoot : null;
}

export function getContentForMode(
    mode: CaptureMode,
    options: ExtractionOptions = {},
): InitialExtractionResult | null {
    return mode === 'full-page'
        ? getVisibleBodyContent(document.body, options)
        : getBestContent(options);
}

export function selectCaptureRoot(mode: CaptureMode): HTMLElement | null {
    if (mode === 'full-page') return document.body;
    const candidates = [
        document.querySelector<HTMLElement>('article'),
        document.querySelector<HTMLElement>('main'),
        document.querySelector<HTMLElement>('[role="main"]'),
    ];
    return candidates.find((candidate) => candidate && hasOrdinaryCaptureText(candidate))
        ?? document.body;
}

function hasOrdinaryCaptureText(root: HTMLElement): boolean {
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (parent?.closest('script,style,noscript,template')) continue;
        if (node.textContent?.trim()) return true;
    }
    return false;
}

/**
 * Extraction-path iframe eligibility check.
 *
 * Preview startup must use hasEligibleIframesLightweight() instead; this
 * helper intentionally performs the full sanitizing traversal.
 */
export function hasEligibleIframesByExtraction(sourceRoot: HTMLElement): boolean {
    const sanitizeFrame: IframeSanitizer = (frameRoot, sharedBudget, frameDepth) =>
        sanitizeVisibleContent(frameRoot, { includeIframes: true }, sharedBudget, frameDepth);
    return hasEligibleIframesInRoot(sourceRoot, sanitizeFrame);
}

function isNonContentElement(source: HTMLElement): boolean {
    return ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(source.tagName);
}
