// Contract tests for the popup content-script loader (Task 3).
//
// Behaviors locked:
//  1. sendWithInjectionRetry returns the first successful sendMessage response.
//  2. On first-send failure: injectContentScript runs once, then up to
//     `attempts` retries with `delayMs` between them.
//  3. After `attempts` failed retries the last error is thrown.
//  4. injectContentScript strips a leading '/' from the ?script path and calls
//     insertCSS (when style file resolves) then executeScript.
//  5. waitForContentScript semantics preserved: preview-session's ping uses the
//     same loader (verified in popup-preview.test.tsx — must stay green).
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// CRXJS turns these imports into extension assets during a production build.
// Vitest does not run that transform, so mock the asset paths; the leading
// slash mimics an extension-page path and locks the strip-'/' behavior.
vi.mock('../src/content/index.ts?script', () => ({ default: '/content.js' }));
vi.mock('../src/preview/content-preview.css?url', () => ({ default: '/content.css' }));

function createChromeMock() {
    return {
        tabs: { sendMessage: vi.fn() },
        scripting: {
            executeScript: vi.fn(async () => []),
            insertCSS: vi.fn(async () => undefined),
        },
        runtime: {
            getManifest: vi.fn(() => ({
                content_scripts: [{ js: ['content.js'], css: ['content.css'] }],
            })),
        },
    };
}

describe('content-script-loader', () => {
    let chrome: ReturnType<typeof createChromeMock>;
    let loader: typeof import('../src/popup/content-script-loader');

    beforeEach(async () => {
        chrome = createChromeMock();
        vi.stubGlobal('chrome', chrome);
        vi.resetModules();
        loader = await import('../src/popup/content-script-loader');
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns the first successful sendMessage response', async () => {
        const response = { success: true, markdown: '# hi' };
        chrome.tabs.sendMessage.mockResolvedValue(response);

        const result = await loader.sendWithInjectionRetry<{ success: boolean; markdown: string }>(42, { action: 'convert_page' });

        expect(result).toBe(response);
        expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
        expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    });

    it('injects the content script once on first-send failure, then retries with delayMs between attempts', async () => {
        chrome.tabs.sendMessage
            .mockRejectedValueOnce(new Error('Receiving end does not exist'))
            .mockResolvedValue({ success: true });

        const started = Date.now();
        const result = await loader.sendWithInjectionRetry<{ success: boolean }>(
            7,
            { action: 'convert_page' },
            { attempts: 2, delayMs: 30 },
        );

        expect(result).toEqual({ success: true });
        // Injection ran exactly once, before the retry loop
        expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
        expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
            target: { tabId: 7 },
            files: ['content.js'],
        });
        // Initial send + one successful retry
        expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
        // The retry waited `delayMs` before the second attempt
        expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    });

    it('throws the last error after `attempts` failed retries', async () => {
        chrome.tabs.sendMessage
            .mockRejectedValueOnce(new Error('first failure'))
            .mockRejectedValue(new Error('last failure'));

        await expect(
            loader.sendWithInjectionRetry(7, { action: 'convert_page' }, { attempts: 2, delayMs: 5 }),
        ).rejects.toThrow('last failure');

        // Initial send + 2 retries = 3 calls; injection happened exactly once
        expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(3);
        expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
    });

    it('strips a leading slash from asset paths and injects CSS before the script', async () => {
        await loader.injectContentScript(42);

        expect(chrome.scripting.insertCSS).toHaveBeenCalledWith({
            target: { tabId: 42 },
            files: ['content.css'],
        });
        expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
            target: { tabId: 42 },
            files: ['content.js'],
        });
    });
});
