import { Readability } from './readability.js';
import { recoverGeneratedText } from './generated-text.js';

/**
 * Extractor Strategy Module
 * Priority: Semantic HTML > visible body > Readability (Fallback)
 */

export interface ExtractionResult {
    element: HTMLElement;
    strategy: string;
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

export function getBestContent(): ExtractionResult | null {
    const semanticSource = extractSemanticHTML();
    if (semanticSource) {
        const semanticContent = sanitizeVisibleContent(semanticSource);
        if (semanticContent) return { element: semanticContent, strategy: 'semantic-html' };
    }

    return getVisibleBodyContent();
}

export function getVisibleBodyContent(): ExtractionResult | null {
    if (!document.body) return null;

    const body = sanitizeVisibleContent(document.body);
    return body ? { element: body, strategy: 'visible-body' } : null;
}

function sanitizeVisibleContent(sourceRoot: HTMLElement): HTMLElement | null {
    const sourceElements = [sourceRoot, ...Array.from(sourceRoot.querySelectorAll<HTMLElement>('*'))];
    const cloneRoot = sourceRoot.cloneNode(true) as HTMLElement;
    const cloneElements = [cloneRoot, ...Array.from(cloneRoot.querySelectorAll<HTMLElement>('*'))];
    if (sourceElements.length !== cloneElements.length) return null;

    recoverGeneratedText(sourceRoot, cloneRoot, undefined, (source) => !isRemovedFromVisibleBody(source));
    sourceElements.forEach((source, index) => {
        const clone = cloneElements[index];
        if (cloneRoot.contains(clone) && isRemovedFromVisibleBody(source)) clone.remove();
    });

    return cloneRoot.textContent?.trim() ? cloneRoot : null;
}

function isRemovedFromVisibleBody(source: HTMLElement): boolean {
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(source.tagName)) return true;
    if (source.hasAttribute('hidden')) return true;
    if (source.tagName === 'DIALOG' && !(source as HTMLDialogElement).open) return true;

    const style = window.getComputedStyle(source);
    return style.display === 'none' || style.visibility === 'hidden';
}

function extractSemanticHTML(): HTMLElement | null {
    return document.querySelector<HTMLElement>('article')
        || document.querySelector<HTMLElement>('main')
        || document.querySelector<HTMLElement>('[role="main"]');
}
