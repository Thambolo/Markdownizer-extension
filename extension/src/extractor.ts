import { Readability } from './readability.js';

/**
 * Extractor Strategy Module
 * Priority: Semantic HTML > Documentation roots > Readability (Fallback)
 */

interface ExtractionResult {
    element: HTMLElement;
    strategy: string;
}

export function getBestContent(): ExtractionResult | null {
    // Priority: Semantic HTML -> Documentation roots -> Readability
    const semanticContent = extractSemanticHTML();
    if (semanticContent) {
        return { element: semanticContent as HTMLElement, strategy: "semantic-html" };
    }

    const documentationRoot = extractDocumentationRoot();
    if (documentationRoot) {
        return { element: documentationRoot as HTMLElement, strategy: "documentation-root" };
    }

    // Fallback: Readability.js
    // We clone the document so Readability doesn't destroy the live page
    const clone = document.cloneNode(true) as Document;
    // @ts-expect-error - Readability is a JS library without types here
    const reader = new Readability(clone);
    const article = reader.parse();

    if (article && article.content) {
        // Readability returns HTML string, we need a DOM element
        const div = document.createElement('div');
        div.innerHTML = article.content;
        return { element: div, strategy: "readability" };
    }

    return null;
}

function extractSemanticHTML(): Element | null {
    return document.querySelector('article') 
        || document.querySelector('main') 
        || document.querySelector('[role="main"]');
}

function extractDocumentationRoot(): Element | null {
    return document.querySelector('#redoc')
        || document.querySelector('redoc')
        || document.querySelector('.swagger-ui')
        || document.querySelector('rapi-doc')
        || document.querySelector('rapi-doc-mini')
        || document.querySelector('scalar-api-reference')
        || document.querySelector('.sl-elements');
}