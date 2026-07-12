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
    const semanticContent = extractSemanticHTML();
    if (semanticContent) {
        return { element: semanticContent as HTMLElement, strategy: 'semantic-html' };
    }

    return getVisibleBodyContent();
}

export function getVisibleBodyContent(): ExtractionResult | null {
    if (!document.body) return null;

    const sourceElements = [document.body, ...Array.from(document.body.querySelectorAll<HTMLElement>('*'))];
    const body = document.body.cloneNode(true) as HTMLElement;
    const cloneElements = [body, ...Array.from(body.querySelectorAll<HTMLElement>('*'))];
    if (sourceElements.length !== cloneElements.length) return null;

    recoverGeneratedText(document.body, body);
    sourceElements.forEach((source, index) => {
        const clone = cloneElements[index];
        if (body.contains(clone) && isRemovedFromVisibleBody(source)) clone.remove();
    });

    return body.textContent?.trim() ? { element: body, strategy: 'visible-body' } : null;
}

function isRemovedFromVisibleBody(source: HTMLElement): boolean {
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(source.tagName)) return true;
    if (source.hasAttribute('hidden')) return true;
    if (source.tagName === 'DIALOG' && !(source as HTMLDialogElement).open) return true;

    const style = window.getComputedStyle(source);
    return style.display === 'none' || style.visibility === 'hidden';
}

function extractSemanticHTML(): Element | null {
    return document.querySelector('article') 
        || document.querySelector('main') 
        || document.querySelector('[role="main"]');
}
