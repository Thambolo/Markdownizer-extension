import contentScriptPath from '../content/index.ts?script';
import contentStylePath from '../preview/content-preview.css?url';

// ── Content-Script Readiness (deduplicated policy) ───────────────────────────
//
// Ping → inject → retry, with a default budget of 5 × 200ms. Both the preview
// session ping and the conversion path go through sendWithInjectionRetry so
// the readiness behavior lives in exactly one place.

const DEFAULT_RETRY_INTERVAL_MS = 200;
const DEFAULT_MAX_RETRIES = 5;

export async function injectContentScript(tabId: number): Promise<void> {
    // Vite emits extension-relative paths for these imports. Strip a leading
    // slash when running from an extension page so Chrome's scripting APIs get
    // a path relative to the extension root. The manifest fallback keeps the
    // test/dev mock path working when Vite does not process ?script imports.
    const manifestContentScript = chrome.runtime.getManifest().content_scripts?.[0];
    const scriptFile = (typeof contentScriptPath === 'string'
        ? contentScriptPath
        : manifestContentScript?.js?.[0])?.replace(/^\/+/, '');
    const styleFile = (typeof contentStylePath === 'string'
        ? contentStylePath
        : manifestContentScript?.css?.[0])?.replace(/^\/+/, '');

    if (!scriptFile) {
        throw new Error('Content script asset unavailable');
    }

    if (styleFile) {
        await chrome.scripting.insertCSS({
            target: { tabId },
            files: [styleFile],
        });
    }

    await chrome.scripting.executeScript({
        target: { tabId },
        files: [scriptFile],
    });
}

export async function sendWithInjectionRetry<TResponse>(
    tabId: number,
    message: unknown,
    options: { attempts?: number; delayMs?: number } = {},
): Promise<TResponse> {
    const attempts = options.attempts ?? DEFAULT_MAX_RETRIES;
    const delayMs = options.delayMs ?? DEFAULT_RETRY_INTERVAL_MS;
    try {
        return await chrome.tabs.sendMessage(tabId, message) as TResponse;
    } catch {
        await injectContentScript(tabId);
        let lastError: unknown;
        for (let i = 0; i < attempts; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            try {
                return await chrome.tabs.sendMessage(tabId, message) as TResponse;
            } catch (err) {
                lastError = err;
            }
        }
        throw lastError || new Error('Failed to establish connection to content script');
    }
}

/** Readiness ping for the preview session: resolves once the content script
 * answers preview_ready (injecting + retrying when it is not there yet). */
export async function waitForContentScript(tabId: number): Promise<void> {
    await sendWithInjectionRetry<unknown>(tabId, { action: 'preview_ready' });
}
