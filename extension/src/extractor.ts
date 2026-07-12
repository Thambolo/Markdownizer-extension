import { Readability } from './readability.js';
import { recoverGeneratedText } from './generated-text.js';

/**
 * Extractor Strategy Module
 * Priority: Semantic HTML > Documentation roots > Readability (Fallback)
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
    // Priority: Semantic HTML -> Documentation roots -> Readability
    const semanticContent = extractSemanticHTML();
    if (semanticContent) {
        return { element: semanticContent as HTMLElement, strategy: "semantic-html" };
    }

    const documentationRoot = extractDocumentationRoot();
    if (documentationRoot) {
        return { element: documentationRoot as HTMLElement, strategy: "documentation-root" };
    }

    // Fallback: Readability with generated-text recovery
    return getReadabilityContent();
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