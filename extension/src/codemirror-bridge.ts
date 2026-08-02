/**
 * Serializable CodeMirror capture model and main-world collector.
 *
 * The collector is a self-contained function suitable for
 * `chrome.scripting.executeScript({ world: 'MAIN', func })`. It
 * recursively walks the current document and readable same-origin
 * iframes, collecting CodeMirror 5 editor values keyed by
 * body-relative child-index paths.
 */

export interface CodeMirrorEditorCapture {
    /** Body-relative child-index path to the .CodeMirror host element. */
    path: number[];
    /** The full editor model text from CodeMirror.getValue(). */
    value: string;
}

export interface CodeMirrorDocumentCapture {
    /** Editor captures for this document. */
    editors: CodeMirrorEditorCapture[];
    /** Child-frame captures keyed by body-relative child-index path string. */
    frames: Record<string, CodeMirrorDocumentCapture>;
}

/**
 * Collect CodeMirror editor values from a document, walking readable
 * same-origin iframes recursively. All helpers are nested so the
 * function can be serialized by Chrome for `chrome.scripting.executeScript`.
 *
 * IMPORTANT: Every runtime helper used here MUST be defined inside this
 * function body. Chrome serializes only the function body for MAIN-world
 * execution, so module-scope bindings are unavailable.
 */
export function collectCodeMirrorCaptureInMainWorld(): CodeMirrorDocumentCapture {
    /** Compute the child-index path from `document.body` to `element`. */
    function bodyRelativePath(element: Element): number[] {
        const path: number[] = [];
        let current: Element | null = element;
        while (current && current !== current.ownerDocument.body) {
            const parent = current.parentElement;
            if (!parent) break;
            const siblings = parent.children;
            const index = Array.from(siblings).indexOf(current);
            if (index >= 0) path.unshift(index);
            current = parent;
        }
        return path;
    }

    // Nested helpers for serialization
    type CMHost = HTMLElement & { CodeMirror?: { getValue?: () => unknown } };

    function collectFromDocument(doc: Document): CodeMirrorDocumentCapture {
        const editors: CodeMirrorEditorCapture[] = [];
        const frames: Record<string, CodeMirrorDocumentCapture> = {};

        // Collect .CodeMirror hosts
        const cmHosts = doc.querySelectorAll<CMHost>('.CodeMirror');
        for (const host of cmHosts) {
            const getValue = host.CodeMirror?.getValue;
            if (typeof getValue !== 'function') continue;

            let value: unknown;
            try {
                value = getValue.call(host.CodeMirror);
            } catch {
                // Editor threw — skip
                continue;
            }
            if (typeof value !== 'string') continue;

            const path = bodyRelativePath(host);
            editors.push({ path, value });
        }

        // Recurse into readable same-origin iframes
        const iframes = doc.querySelectorAll<HTMLIFrameElement>('iframe');
        for (const iframe of iframes) {
            let iframeDoc: Document | null = null;
            try {
                iframeDoc = iframe.contentDocument;
            } catch {
                // Cross-origin — skip
                continue;
            }
            if (!iframeDoc?.body) continue;

            const framePath = bodyRelativePath(iframe);
            const pathKey = JSON.stringify(framePath);

            try {
                frames[pathKey] = collectFromDocument(iframeDoc);
            } catch {
                // Inaccessible frame — skip
                continue;
            }
        }

        return { editors, frames };
    }

    return collectFromDocument(document);
}
