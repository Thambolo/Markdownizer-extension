import { recoverGeneratedText } from '../skeleton/generated-text.js';
import { serializeNativeControls } from '../skeleton/native-controls';
import type { CodeMirrorDocumentCapture } from './codemirror-bridge';
import type { ExtractionOptions } from './extractor';
import {
    bodyRelativePath,
    createIframeBudget,
    expandSameOriginIframes,
    type IframeBudget,
    type IframeSanitizer,
} from './iframe-capture';

interface CodeMirrorHost extends HTMLElement {
    CodeMirror?: {
        getValue?: () => unknown;
    };
}

export function sanitizeVisibleContent(
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
        const sanitizeFrame: IframeSanitizer = (frameRoot, sharedBudget, frameDepth, framePath) => {
            // Look up child capture by frame path
            let childCapture: CodeMirrorDocumentCapture | undefined;
            if (options.codeMirrorCapture && framePath) {
                const pathKey = JSON.stringify(framePath);
                childCapture = options.codeMirrorCapture.frames[pathKey];
            }
            return sanitizeVisibleContent(frameRoot, { ...options, codeMirrorCapture: childCapture }, sharedBudget, frameDepth, true);
        };
        expandSameOriginIframes(sourceRoot, cloneRoot, sanitizeFrame, budget, rootDepth + 1);
    }
    sourceElements.forEach((source, index) => {
        const clone = cloneElements[index];
        if (cloneRoot.contains(clone) && isNonContentElement(source)) clone.remove();
    });

    recoverCodeMirrorText(sourceRoot, cloneRoot, options.codeMirrorCapture);
    if (serializeControls) serializeNativeControls(sourceRoot, cloneRoot);

    return cloneRoot.textContent?.trim() ? cloneRoot : null;
}

/**
 * CodeMirror 5 virtualizes its visible line DOM and keeps the full editor
 * contents in the page-owned editor instance. Clone the model into a normal
 * code block so extraction does not depend on the editor's scroll position.
 *
 * When a main-world capture is available, editor values are looked up by
 * body-relative path. The direct-property fallback is retained for
 * same-world test contexts where the CodeMirror instance is accessible.
 */
function recoverCodeMirrorText(
    sourceRoot: HTMLElement,
    cloneRoot: HTMLElement,
    capture?: CodeMirrorDocumentCapture,
): void {
    const sourceEditors = Array.from(sourceRoot.querySelectorAll<CodeMirrorHost>('.CodeMirror'));
    const cloneEditors = Array.from(cloneRoot.querySelectorAll<HTMLElement>('.CodeMirror'));
    if (sourceEditors.length !== cloneEditors.length) return;

    sourceEditors.forEach((sourceEditor, index) => {
        let value: string | null = null;

        // Prefer main-world capture lookup by path
        if (capture) {
            const path = bodyRelativePath(sourceEditor);
            const pathKey = JSON.stringify(path);
            const editorCapture = capture.editors.find((e) => JSON.stringify(e.path) === pathKey);
            if (editorCapture) {
                value = editorCapture.value;
            }
        }

        // Fallback: direct property access (works in same-world test contexts)
        if (value === null) {
            const getValue = sourceEditor.CodeMirror?.getValue;
            if (typeof getValue !== 'function') return;

            let raw: unknown;
            try {
                raw = getValue.call(sourceEditor.CodeMirror);
            } catch {
                return;
            }
            if (typeof raw !== 'string') return;
            value = raw;
        }

        const ownerDocument = cloneEditors[index].ownerDocument;
        const pre = ownerDocument.createElement('pre');
        const code = ownerDocument.createElement('code');
        code.textContent = value;
        pre.appendChild(code);
        cloneEditors[index].replaceWith(pre);
    });
}

function isNonContentElement(source: HTMLElement): boolean {
    return ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(source.tagName);
}
