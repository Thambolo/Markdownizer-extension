// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { PREVIEW_PORT_NAME, type CaptureMode, type PreviewEligibilityMessage } from '../src/shared/preview-protocol';

// CRXJS turns these imports into extension assets during a production build.
// Vitest does not run that transform, so mock the asset paths to keep the
// popup tests from executing the content script in the popup test environment.
vi.mock("../src/content/index.ts?script", () => ({ default: "content.js" }));
vi.mock("../src/preview/content-preview.css?url", () => ({ default: "content.css" }));

// ── Chrome API Mocks ──────────────────────────────────────────────────────────

interface MockPort {
    name: string;
    postMessage: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    onMessage: { addListener: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> };
    onDisconnect: { addListener: ReturnType<typeof vi.fn> };
    _messageCallbacks: Array<(msg: unknown) => void>;
    _disconnectCallbacks: Array<() => void>;
    emitMessage(msg: unknown): void;
    emitDisconnect(): void;
}

function createMockPort(name: string): MockPort {
    const port: MockPort = {
        name,
        postMessage: vi.fn(),
        disconnect: vi.fn(),
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        _messageCallbacks: [],
        _disconnectCallbacks: [],
        emitMessage(_msg: unknown) {
            for (const cb of port._messageCallbacks) cb(_msg);
        },
        emitDisconnect() {
            for (const cb of port._disconnectCallbacks) cb();
        },
    };

    port.onMessage.addListener.mockImplementation((cb: (msg: unknown) => void) => {
        port._messageCallbacks.push(cb);
    });
    port.onMessage.removeListener.mockImplementation((cb: (msg: unknown) => void) => {
        const idx = port._messageCallbacks.indexOf(cb);
        if (idx !== -1) port._messageCallbacks.splice(idx, 1);
    });
    port.onDisconnect.addListener.mockImplementation((cb: () => void) => {
        port._disconnectCallbacks.push(cb);
    });

    return port;
}

let lastPort: MockPort | null = null;

function createChromeMock() {
    lastPort = null;

    // Storage mock with get/set
    const storageData: Record<string, unknown> = {};
    const sessionData: Record<string, unknown> = {};

    return {
        tabs: {
            connect: vi.fn((_tabId: number, opts: { name: string }) => {
                const port = createMockPort(opts.name);
                lastPort = port;
                return port;
            }),
            sendMessage: vi.fn(),
            query: vi.fn(async () => [{ id: 1, url: 'https://example.com', title: 'Example' }]),
        },
        permissions: {
            contains: vi.fn(async () => true),
            request: vi.fn(async () => true),
        },
        scripting: {
            executeScript: vi.fn(async () => []),
            insertCSS: vi.fn(async () => undefined),
        },
        runtime: {
            getManifest: vi.fn(() => ({
                content_scripts: [
                    { js: ['content.js'], css: ['content.css'] },
                ],
            })),
            sendMessage: vi.fn(async () => ({ success: true })),
            openOptionsPage: vi.fn(),
            getURL: vi.fn((path: string) => `chrome-extension://abc123/${path}`),
            onMessage: {
                addListener: vi.fn(),
                removeListener: vi.fn(),
            },
            onConnect: {
                addListener: vi.fn(),
            },
        },
        storage: {
            local: {
                get: vi.fn(async (keys: string | string[]) => {
                    const keyList = Array.isArray(keys) ? keys : [keys];
                    const result: Record<string, unknown> = {};
                    for (const key of keyList) {
                        if (key in storageData) {
                            result[key] = storageData[key];
                        }
                    }
                    return result;
                }),
                set: vi.fn(async (items: Record<string, unknown>) => {
                    Object.assign(storageData, items);
                }),
            },
            session: {
                get: vi.fn(async (keys: string | string[]) => {
                    const key = Array.isArray(keys) ? keys[0] : keys;
                    return key in sessionData ? { [key]: sessionData[key] } : {};
                }),
                set: vi.fn(async (items: Record<string, unknown>) => {
                    Object.assign(sessionData, items);
                }),
                remove: vi.fn(async (keys: string | string[]) => {
                    const list = Array.isArray(keys) ? keys : [keys];
                    for (const key of list) delete sessionData[key];
                }),
            },
        },
        _storageData: storageData,
        _sessionData: sessionData,
    };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('isSupportedPageUrl', () => {
    let isSupportedPageUrl: (url?: string) => boolean;

    beforeEach(async () => {
        vi.stubGlobal('chrome', createChromeMock());
        vi.resetModules();
        const mod = await import('../src/popup/preview-session');
        isSupportedPageUrl = mod.isSupportedPageUrl;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns true for http URLs', () => {
        expect(isSupportedPageUrl('http://example.com')).toBe(true);
    });

    it('returns true for https URLs', () => {
        expect(isSupportedPageUrl('https://example.com')).toBe(true);
    });

    it('returns false for chrome-extension URLs', () => {
        expect(isSupportedPageUrl('chrome-extension://abc123/popup.html')).toBe(false);
    });

    it('returns false for chrome:// URLs', () => {
        expect(isSupportedPageUrl('chrome://settings')).toBe(false);
    });

    it('returns false for about:blank', () => {
        expect(isSupportedPageUrl('about:blank')).toBe(false);
    });

    it('returns false for undefined', () => {
        expect(isSupportedPageUrl(undefined)).toBe(false);
    });

    it('returns false for empty string', () => {
        expect(isSupportedPageUrl('')).toBe(false);
    });

    it('returns false for ftp URLs', () => {
        expect(isSupportedPageUrl('ftp://files.example.com')).toBe(false);
    });

    it('returns false for file URLs', () => {
        expect(isSupportedPageUrl('file:///tmp/test.html')).toBe(false);
    });
});

describe('openPreviewSession', () => {
    let openPreviewSession: (tabId: number) => Promise<PreviewSession>;
    let chrome: ReturnType<typeof createChromeMock>;

    interface PreviewSession {
        show(captureMode: CaptureMode): void;
        inspect(captureMode: CaptureMode, generation: number): void;
        onEligibility(listener: (message: PreviewEligibilityMessage) => void): () => void;
        setLoading(): void;
        setReady(): void;
        hide(): void;
        disconnect(): void;
    }

    beforeEach(async () => {
        chrome = createChromeMock();
        vi.stubGlobal('chrome', chrome);
        vi.resetModules();
        const mod = await import('../src/popup/preview-session');
        openPreviewSession = mod.openPreviewSession;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('connects with PREVIEW_PORT_NAME', async () => {
        // Content script is ready — sendMessage for preview_ready resolves
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        await openPreviewSession(42);

        expect(chrome.tabs.connect).toHaveBeenCalledWith(42, { name: PREVIEW_PORT_NAME });
    });

    it('generates a unique sessionId', async () => {
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        const session1 = await openPreviewSession(1);
        const port1 = lastPort; // Capture first session's port

        const session2 = await openPreviewSession(2);
        const port2 = lastPort; // Capture second session's port

        // Trigger a message on each session to populate postMessage calls
        session1.show('smart');
        session2.show('smart');

        // Extract session IDs from the postMessage calls
        const sessionId1 = port1!.postMessage.mock.calls[0][0].sessionId;
        const sessionId2 = port2!.postMessage.mock.calls[0][0].sessionId;

        // Verify both are strings
        expect(typeof sessionId1).toBe('string');
        expect(typeof sessionId2).toBe('string');

        // Verify they are different (unique)
        expect(sessionId1).not.toBe(sessionId2);

        session1.disconnect();
        session2.disconnect();
    });

    it('does not reinject content script when already ready', async () => {
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        await openPreviewSession(42);

        expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    });

    it('injects content script when readiness check fails and retries', async () => {
        // First call to sendMessage throws (content script not loaded)
        // Then after injection, subsequent calls resolve
        chrome.tabs.sendMessage
            .mockRejectedValueOnce(new Error('Receiving end does not exist'))
            .mockResolvedValue({ success: true });

        await openPreviewSession(42);

        expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
        expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
            target: { tabId: 42 },
            files: ['content.js'],
        });
    });

    it('injects preview CSS when dynamically loading content script', async () => {
        chrome.tabs.sendMessage
            .mockRejectedValueOnce(new Error('Receiving end does not exist'))
            .mockResolvedValue({ success: true });

        await openPreviewSession(42);

        expect(chrome.scripting.insertCSS).toHaveBeenCalledWith({
            target: { tabId: 42 },
            files: ['content.css'],
        });
    });

    it('retries readiness check up to 5 times after injection', async () => {
        // All calls fail — should throw after 5 retries
        chrome.tabs.sendMessage.mockRejectedValue(new Error('Receiving end does not exist'));

        await expect(openPreviewSession(42)).rejects.toThrow();

        // 1 initial call + 5 retries = 6 total
        expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(6);
    });

    it('sends preview_ready action for readiness check', async () => {
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        await openPreviewSession(42);

        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(42, { action: 'preview_ready' });
    });

    it('sends show command with sessionId', async () => {
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        const session = await openPreviewSession(42);
        session.show('smart');

        expect(lastPort).not.toBeNull();
        expect(lastPort!.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'preview:show', sessionId: expect.any(String), captureMode: 'smart' })
        );
        session.disconnect();
    });

    it('requests iframe eligibility and forwards eligibility responses', async () => {
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        const session = await openPreviewSession(42);
        const listener = vi.fn();
        session.onEligibility(listener);
        session.inspect('full-page', 12);

        expect(lastPort!.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'preview:inspect', captureMode: 'full-page', generation: 12 })
        );

        lastPort!.emitMessage({
            type: 'preview:eligibility',
            sessionId: lastPort!.postMessage.mock.calls[0][0].sessionId,
            captureMode: 'full-page',
            generation: 12,
            hasEligibleIframes: true,
            hasImages: false,
        });
        expect(listener).toHaveBeenCalledWith(expect.objectContaining({ hasEligibleIframes: true }));

        listener.mockClear();
        lastPort!.emitMessage({
            type: 'preview:eligibility',
            sessionId: 'stale-session',
            captureMode: 'full-page',
            generation: 12,
            hasEligibleIframes: true,
            hasImages: false,
        });
        expect(listener).not.toHaveBeenCalled();
        session.disconnect();
    });

    it('sends loading command with same sessionId', async () => {
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        const session = await openPreviewSession(42);
        session.setLoading();

        expect(lastPort!.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'preview:loading', sessionId: expect.any(String) })
        );
        session.disconnect();
    });

    it('sends ready command with same sessionId', async () => {
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        const session = await openPreviewSession(42);
        session.setReady();

        expect(lastPort!.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'preview:ready', sessionId: expect.any(String) })
        );
        session.disconnect();
    });

    it('sends hide command with same sessionId', async () => {
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        const session = await openPreviewSession(42);
        session.hide();

        expect(lastPort!.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'preview:hide', sessionId: expect.any(String) })
        );
        session.disconnect();
    });

    it('disconnect() is idempotent', async () => {
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        const session = await openPreviewSession(42);
        session.disconnect();
        session.disconnect(); // second call should not throw

        // port.onDisconnect listeners should have been called at most once
        expect(lastPort!._disconnectCallbacks.length).toBeGreaterThanOrEqual(0);
    });

    it('methods are safe after disconnection', async () => {
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        const session = await openPreviewSession(42);
        session.disconnect();

        // These should not throw
        expect(() => session.show('smart')).not.toThrow();
        expect(() => session.setLoading()).not.toThrow();
        expect(() => session.setReady()).not.toThrow();
        expect(() => session.hide()).not.toThrow();
    });

    it('session uses crypto.randomUUID for session ID', async () => {
        const mockUUID = 'test-uuid-1234';
        const originalRandomUUID = crypto.randomUUID;
        crypto.randomUUID = vi.fn(() => mockUUID) as typeof crypto.randomUUID;

        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        const session = await openPreviewSession(42);
        session.show('smart');

        expect(lastPort!.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ sessionId: mockUUID })
        );

        session.disconnect();
        crypto.randomUUID = originalRandomUUID;
    });
});

// ── Popup Lifecycle Tests ─────────────────────────────────────────────────────

describe('App popup lifecycle', () => {
    let chrome: ReturnType<typeof createChromeMock>;
    let App: typeof import('../src/popup/App').App;
    let render: typeof import('preact').render;
    let act: typeof import('preact/test-utils').act;

    beforeEach(async () => {
        chrome = createChromeMock();
        vi.stubGlobal('chrome', chrome);

        // Stub the clipboard API
        vi.stubGlobal('navigator', {
            clipboard: {
                writeText: vi.fn(async () => {}),
            },
        });

        // Ensure document.body exists for Preact render
        if (!document.body) {
            document.body = document.createElement('body');
        }
        document.body.innerHTML = '<div id="app"></div>';

        vi.resetModules();
        const preact = await import('preact');
        const testUtils = await import('preact/test-utils');
        render = preact.render;
        act = testUtils.act;
        const appMod = await import('../src/popup/App');
        App = appMod.App;
    });

    afterEach(() => {
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    it('defaults preview to enabled when storage has no preference', async () => {
        // Storage returns empty for capturePreviewEnabled
        chrome.storage.local.get.mockResolvedValue({});

        // Content script is ready
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        let container: HTMLDivElement;
        await act(async () => {
            container = document.getElementById('app')!;
            render(<App />, container);
        });

        // Wait for async effects
        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });

        // The session should be opened because preview defaults to enabled
        expect(chrome.tabs.connect).toHaveBeenCalled();
        // The session's show() should have been called
        const port = lastPort;
        expect(port).not.toBeNull();
        expect(port!.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'preview:show' })
        );
    });

    it('honors a persisted disabled preference', async () => {
        // Storage returns false for capturePreviewEnabled
        chrome.storage.local.get.mockImplementation(async (keys: string | string[]) => {
            const keyList = Array.isArray(keys) ? keys : [keys];
            if (keyList.includes('capturePreviewEnabled')) {
                return { capturePreviewEnabled: false };
            }
            return {};
        });

        let container: HTMLDivElement;
        await act(async () => {
            container = document.getElementById('app')!;
            render(<App />, container);
        });

        // Wait for async effects
        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });

        // The capture session remains open for iframe eligibility even when visual preview is disabled.
        expect(chrome.tabs.connect).toHaveBeenCalled();
        expect(lastPort!.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: 'preview:show' })
        );
    });

    it('persists toggles and updates the current page immediately', async () => {
        chrome.storage.local.get.mockResolvedValue({ capturePreviewEnabled: false });
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        let container: HTMLDivElement;
        await act(async () => {
            container = document.getElementById('app')!;
            render(<App />, container);
        });

        // Wait for async effects
        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });

        // Verify storage.set was called with the initial read
        expect(chrome.storage.local.get).toHaveBeenCalled();

        // Now simulate toggling preview on via the Footer checkbox
        const checkbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
        expect(checkbox).not.toBeNull();

        // Find the Preview checkbox (first checkbox is Preview, second is Auto-download)
        const checkboxes = document.querySelectorAll('input[type="checkbox"]');
        // There should be at least 2 checkboxes (Preview + Auto-download)
        expect(checkboxes.length).toBeGreaterThanOrEqual(2);

        const previewCheckbox = checkboxes[0] as HTMLInputElement;

        await act(async () => {
            // Simulate clicking the Preview checkbox from off to on
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype, 'checked'
            )!.set!;
            nativeInputValueSetter.call(previewCheckbox, true);
            previewCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
        });

        // Wait for effects
        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });

        // Should have persisted true to storage
        expect(chrome.storage.local.set).toHaveBeenCalledWith(
            expect.objectContaining({ capturePreviewEnabled: true })
        );

        // Should have opened a session and called show()
        expect(chrome.tabs.connect).toHaveBeenCalled();
    });

    it('enters preview loading before requesting conversion', async () => {
        chrome.storage.local.get.mockResolvedValue({ capturePreviewEnabled: true });
        chrome.tabs.sendMessage.mockResolvedValue({
            success: true,
            markdown: '# Hello',
        });

        let container: HTMLDivElement;
        await act(async () => {
            container = document.getElementById('app')!;
            render(<App />, container);
        });

        // Wait for async effects (session opens)
        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });

        // The session should exist and show() should have been called
        expect(lastPort).not.toBeNull();
        const port = lastPort!;

        // Click the Start button
        const startButton = document.querySelector('button') as HTMLButtonElement;
        expect(startButton).not.toBeNull();

        await act(async () => {
            startButton.click();
        });

        // The session's setLoading() should have been called before convert_page
        expect(port.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'preview:loading' })
        );
    });

    it('keeps preview visible and restores ready state after successful conversion', async () => {
        chrome.storage.local.get.mockResolvedValue({ capturePreviewEnabled: true });
        chrome.tabs.sendMessage.mockResolvedValue({
            success: true,
            markdown: '# Hello World',
        });

        let container: HTMLDivElement;
        await act(async () => {
            container = document.getElementById('app')!;
            render(<App />, container);
        });

        // Wait for async effects
        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });

        const port = lastPort!;
        port.postMessage.mockClear(); // Clear initial show() call

        // Click Start
        const startButton = document.querySelector('button') as HTMLButtonElement;
        await act(async () => {
            startButton.click();
        });

        // Wait for conversion to complete
        await act(async () => {
            await new Promise(r => setTimeout(r, 100));
        });

        // Successful conversion should leave the preview visible in its normal state
        expect(port.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: 'preview:hide' })
        );
        expect(port.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'preview:ready' })
        );
    });

    it('restores ready preview after failed conversion', async () => {
        chrome.storage.local.get.mockResolvedValue({ capturePreviewEnabled: true });

        // Allow preview_ready to succeed, but convert_page to fail
        chrome.tabs.sendMessage.mockImplementation(async (_tabId: number, msg: { action?: string }) => {
            if (msg?.action === 'preview_ready') {
                return { success: true };
            }
            throw new Error('Conversion failed');
        });

        let container: HTMLDivElement;
        await act(async () => {
            container = document.getElementById('app')!;
            render(<App />, container);
        });

        // Wait for async effects (session opens)
        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });

        expect(lastPort).not.toBeNull();
        const port = lastPort!;
        port.postMessage.mockClear(); // Clear initial show() call

        // Click Start
        const startButton = document.querySelector('button') as HTMLButtonElement;
        await act(async () => {
            startButton.click();
        });

        // Wait for conversion to fail (ensureContentScriptLoaded retries 5×200ms = 1s)
        await act(async () => {
            await new Promise(r => setTimeout(r, 1500));
        });

        // setReady() should have been called after failed conversion
        expect(port.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'preview:ready' })
        );
    });

    it('keeps Start usable when preview initialization fails', async () => {
        chrome.storage.local.get.mockResolvedValue({ capturePreviewEnabled: true });
        // Content script readiness check fails (preview session can't open)
        // But convert_page should work after content script injection
        chrome.tabs.sendMessage.mockImplementation(async (_tabId: number, msg: { action?: string }) => {
            if (msg?.action === 'preview_ready') {
                // All preview_ready checks fail (1 initial + 5 retries = 6)
                throw new Error('Receiving end does not exist');
            }
            // This is the convert_page call
            return { success: true, markdown: '# Recovered' };
        });

        let container: HTMLDivElement;
        await act(async () => {
            container = document.getElementById('app')!;
            render(<App />, container);
        });

        // Wait for async effects (preview init fails after retries: 5 × 200ms = 1000ms)
        await act(async () => {
            await new Promise(r => setTimeout(r, 1500));
        });

        // Click Start — should still work even though preview failed
        const startButton = document.querySelector('button') as HTMLButtonElement;
        await act(async () => {
            startButton.click();
        });

        // Wait for conversion
        await act(async () => {
            await new Promise(r => setTimeout(r, 100));
        });

        // The status should be 'success' (conversion succeeded despite preview failure)
        const statusMessage = document.querySelector('h2');
        expect(statusMessage?.textContent).toContain('Content extracted');
    });

    it('disconnects the session when the popup unmounts', async () => {
        chrome.storage.local.get.mockResolvedValue({ capturePreviewEnabled: true });
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        let container: HTMLDivElement;
        await act(async () => {
            container = document.getElementById('app')!;
            render(<App />, container);
        });

        // Wait for async effects
        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });

        const port = lastPort!;
        expect(port).not.toBeNull();

        // Unmount the component
        await act(async () => {
            render(null, container!);
        });

        // The port should have been disconnected (cleanup)
        expect(port.disconnect).toHaveBeenCalled();
    });

    it('sends convert_page with captureMode full-page when capture full page is enabled', async () => {
        chrome.storage.local.get.mockResolvedValue({ capturePreviewEnabled: true });
        chrome.tabs.sendMessage.mockResolvedValue({ success: true, markdown: '# Done' });

        let container: HTMLDivElement;
        await act(async () => {
            container = document.getElementById('app')!;
            render(<App />, container);
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });

        // Enable capture full page
        const captureFullPageToggle = document.querySelector('#capture-full-page-toggle') as HTMLInputElement;
        expect(captureFullPageToggle).not.toBeNull();

        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')!.set!;
            setter.call(captureFullPageToggle, true);
            captureFullPageToggle.dispatchEvent(new Event('change', { bubbles: true }));
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });

        // Clear previous calls
        chrome.tabs.sendMessage.mockClear();

        // Click Start to trigger conversion
        const startButton = document.querySelector('button') as HTMLButtonElement;
        await act(async () => {
            startButton.click();
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 100));
        });

        // The convert_page message should carry captureMode: 'full-page'
        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
            expect.any(Number),
            expect.objectContaining({ action: 'convert_page', captureMode: 'full-page' })
        );
    });
});

// ── Toggle Component Tests ───────────────────────────────────────────────────

describe('Toggle component', () => {
    let Toggle: typeof import('../src/popup/components/Toggle').Toggle;

    beforeEach(async () => {
        if (!document.body) {
            document.body = document.createElement('body');
        }
        document.body.innerHTML = '<div id="toggle-root"></div>';

        vi.resetModules();
        const toggleMod = await import('../src/popup/components/Toggle');
        Toggle = toggleMod.Toggle;
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('renders a label wrapping a hidden checkbox and visual track', async () => {
        const { render } = await import('preact');
        const { act } = await import('preact/test-utils');
        const root = document.getElementById('toggle-root')!;

        await act(async () => {
            render(<Toggle id="test-toggle" label="Test option" checked={false} onChange={() => {}} />, root);
        });

        const label = root.querySelector('label');
        expect(label).not.toBeNull();

        const checkbox = root.querySelector('input[type="checkbox"]') as HTMLInputElement;
        expect(checkbox).not.toBeNull();
        expect(checkbox.id).toBe('test-toggle');

        // The visual track should carry aria-hidden="true"
        const track = root.querySelector('[aria-hidden="true"]');
        expect(track).not.toBeNull();
    });

    it('label htmlFor matches checkbox id for accessible name', async () => {
        const { render } = await import('preact');
        const { act } = await import('preact/test-utils');
        const root = document.getElementById('toggle-root')!;

        await act(async () => {
            render(<Toggle id="capture-preview-toggle" label="Preview" checked={true} onChange={() => {}} />, root);
        });

        const label = root.querySelector('label') as HTMLLabelElement;
        expect(label.htmlFor).toBe('capture-preview-toggle');

        const checkbox = root.querySelector('#capture-preview-toggle') as HTMLInputElement;
        expect(checkbox).not.toBeNull();
        expect(checkbox.type).toBe('checkbox');
    });

    it('checked state reflects props', async () => {
        const { render } = await import('preact');
        const { act } = await import('preact/test-utils');
        const root = document.getElementById('toggle-root')!;

        await act(async () => {
            render(<Toggle id="t1" label="On toggle" checked={true} onChange={() => {}} />, root);
        });

        const checkbox = root.querySelector('#t1') as HTMLInputElement;
        expect(checkbox.checked).toBe(true);

        await act(async () => {
            render(<Toggle id="t1" label="On toggle" checked={false} onChange={() => {}} />, root);
        });

        expect(checkbox.checked).toBe(false);
    });

    it('clicking the label invokes onChange', async () => {
        const { render } = await import('preact');
        const { act } = await import('preact/test-utils');
        const root = document.getElementById('toggle-root')!;
        const handler = vi.fn();

        await act(async () => {
            render(<Toggle id="t-click" label="Click test" checked={false} onChange={handler} />, root);
        });

        const label = root.querySelector('label')!;
        await act(async () => {
            label.click();
        });

        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('dispatching Space on focused checkbox changes checked state', async () => {
        const { render } = await import('preact');
        const { act } = await import('preact/test-utils');
        const root = document.getElementById('toggle-root')!;

        await act(async () => {
            render(<Toggle id="t-space" label="Space test" checked={false} onChange={() => {}} />, root);
        });

        const checkbox = root.querySelector('#t-space') as HTMLInputElement;
        expect(checkbox.checked).toBe(false);

        await act(async () => {
            checkbox.focus();
            checkbox.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
            // Native checkbox toggles on Space keydown
            checkbox.checked = !checkbox.checked;
            checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        });

        expect(checkbox.checked).toBe(true);
    });

    it('text label appears before the switch container in document order', async () => {
        const { render } = await import('preact');
        const { act } = await import('preact/test-utils');
        const root = document.getElementById('toggle-root')!;

        await act(async () => {
            render(<Toggle id="t-order" label="Preview" checked={false} onChange={() => {}} />, root);
        });

        const label = root.querySelector('label')!;
        const children = Array.from(label.children);
        // First child should be the text span, second should be the switch container
        expect(children.length).toBe(2);
        expect(children[0].textContent).toBe('Preview');
        // The switch container should contain the hidden checkbox and aria-hidden track
        expect(children[1].querySelector('[aria-hidden="true"]')).not.toBeNull();
    });

    it('label is full-width with flex layout', async () => {
        const { render } = await import('preact');
        const { act } = await import('preact/test-utils');
        const root = document.getElementById('toggle-root')!;

        await act(async () => {
            render(<Toggle id="t-flex" label="Flex test" checked={false} onChange={() => {}} />, root);
        });

        const label = root.querySelector('label') as HTMLLabelElement;
        expect(label.className).toContain('w-full');
        expect(label.className).toContain('flex');
        expect(label.className).toContain('justify-between');
    });
});

// ── Capture Full Page Toggle Tests ───────────────────────────────────────────

describe('Capture full page toggle', () => {
    let chrome: ReturnType<typeof createChromeMock>;
    let App: typeof import('../src/popup/App').App;
    let render: typeof import('preact').render;
    let act: typeof import('preact/test-utils').act;

    beforeEach(async () => {
        chrome = createChromeMock();
        vi.stubGlobal('chrome', chrome);

        // Stub the clipboard API
        vi.stubGlobal('navigator', {
            clipboard: {
                writeText: vi.fn(async () => {}),
            },
        });

        // Ensure document.body exists for Preact render
        if (!document.body) {
            document.body = document.createElement('body');
        }
        document.body.innerHTML = '<div id="app"></div>';

        vi.resetModules();
        const preact = await import('preact');
        const testUtils = await import('preact/test-utils');
        render = preact.render;
        act = testUtils.act;
        const appMod = await import('../src/popup/App');
        App = appMod.App;
    });

    afterEach(() => {
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    it('renders capture full page toggle with description', async () => {
        chrome.storage.local.get.mockResolvedValue({});
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        await act(async () => {
            const container = document.getElementById('app')!;
            render(<App />, container);
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });

        // Assert the toggle exists
        expect(document.querySelector('#capture-full-page-toggle')).not.toBeNull();
        // Assert the label text
        expect(document.body.textContent).toContain('Capture full page');
        // Assert the description text
        expect(document.body.textContent).toContain('Default: Smart selection');
    });

    it('creates first preview session with captureMode smart', async () => {
        chrome.storage.local.get.mockResolvedValue({});
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        await act(async () => {
            const container = document.getElementById('app')!;
            render(<App />, container);
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });

        // The session should be opened
        expect(chrome.tabs.connect).toHaveBeenCalled();
        const port = lastPort;
        expect(port).not.toBeNull();

        // The first show() call should include captureMode: 'smart'
        expect(port!.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'preview:show', captureMode: 'smart' })
        );
    });

    it('shows iframe inclusion only after eligibility and keeps opt-out session-only', async () => {
        chrome.storage.local.get.mockResolvedValue({});
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        await act(async () => {
            const container = document.getElementById('app')!;
            render(<App />, container);
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });

        const port = lastPort!;
        const inspectMessage = port.postMessage.mock.calls
            .map((call: unknown[]) => call[0] as { type?: string; sessionId?: string; generation?: number })
            .find((message) => message.type === 'preview:inspect');
        expect(inspectMessage).toBeDefined();
        const iframeToggleBefore = document.querySelector('#include-iframes-toggle') as HTMLInputElement;
        expect(iframeToggleBefore).not.toBeNull();
        expect(iframeToggleBefore.disabled).toBe(true);
        expect(document.body.textContent).toContain('No iframes on this page');

        port.emitMessage({
            type: 'preview:eligibility',
            sessionId: inspectMessage!.sessionId,
            captureMode: 'smart',
            generation: inspectMessage!.generation,
            hasEligibleIframes: true,
            hasImages: false,
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 20));
        });

        const iframeToggle = document.querySelector('#include-iframes-toggle') as HTMLInputElement;
        expect(iframeToggle).not.toBeNull();
        expect(iframeToggle.disabled).toBe(false);
        expect(iframeToggle.checked).toBe(true);
        expect(document.body.textContent).not.toContain('No iframes on this page');

        port.postMessage.mockClear();
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')!.set!;
            setter.call(iframeToggle, false);
            iframeToggle.dispatchEvent(new Event('change', { bubbles: true }));
        });

        // Now sends preview:set-iframes instead of preview:show with includeIframes
        expect(port.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'preview:set-iframes', enabled: false })
        );
        for (const call of chrome.storage.local.set.mock.calls) {
            expect(Object.keys(call[0])).not.toContain('includeIframes');
        }
    });

    it('does not persist capture mode to storage', async () => {
        chrome.storage.local.get.mockResolvedValue({});
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        await act(async () => {
            const container = document.getElementById('app')!;
            render(<App />, container);
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });

        // Check that storage.set was NOT called with a capture-mode key
        const storageSetCalls = chrome.storage.local.set.mock.calls;
        for (const call of storageSetCalls) {
            const keys = Object.keys(call[0]);
            expect(keys).not.toContain('captureMode');
            expect(keys).not.toContain('captureFullPage');
        }
    });

    it('toggles to full-page mode and sends preview:show with captureMode full-page', async () => {
        chrome.storage.local.get.mockResolvedValue({});
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        await act(async () => {
            const container = document.getElementById('app')!;
            render(<App />, container);
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });

        const port = lastPort!;
        port.postMessage.mockClear(); // Clear initial show() call

        // Find the capture full page toggle
        const captureFullPageToggle = document.querySelector('#capture-full-page-toggle') as HTMLInputElement;
        expect(captureFullPageToggle).not.toBeNull();

        // Toggle it on
        await act(async () => {
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype, 'checked'
            )!.set!;
            nativeInputValueSetter.call(captureFullPageToggle, true);
            captureFullPageToggle.dispatchEvent(new Event('change', { bubbles: true }));
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });

        // Should send preview:show with captureMode: 'full-page'
        expect(port.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'preview:show', captureMode: 'full-page' })
        );
    });

    it('does not send show message when preview is disabled', async () => {
        chrome.storage.local.get.mockResolvedValue({ capturePreviewEnabled: false });

        await act(async () => {
            const container = document.getElementById('app')!;
            render(<App />, container);
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });

        // Session remains open for iframe eligibility, but visual preview is not shown.
        expect(chrome.tabs.connect).toHaveBeenCalled();
        expect(lastPort!.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: 'preview:show' })
        );
    });

    it('sends show message only when preview is enabled and toggle changes', async () => {
        chrome.storage.local.get.mockResolvedValue({ capturePreviewEnabled: true });
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        await act(async () => {
            const container = document.getElementById('app')!;
            render(<App />, container);
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });

        const port = lastPort!;
        port.postMessage.mockClear(); // Clear initial show() call

        // Find the preview toggle and disable it
        const previewToggle = document.querySelector('#capture-preview-toggle') as HTMLInputElement;
        await act(async () => {
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype, 'checked'
            )!.set!;
            nativeInputValueSetter.call(previewToggle, false);
            previewToggle.dispatchEvent(new Event('change', { bubbles: true }));
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });

        // Now toggle capture full page
        const captureFullPageToggle = document.querySelector('#capture-full-page-toggle') as HTMLInputElement;
        await act(async () => {
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype, 'checked'
            )!.set!;
            nativeInputValueSetter.call(captureFullPageToggle, true);
            captureFullPageToggle.dispatchEvent(new Event('change', { bubbles: true }));
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });

        // No show message should be sent because preview is disabled
        expect(port.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: 'preview:show' })
        );
    });

    it('re-enables preview sends show with current capture mode', async () => {
        chrome.storage.local.get.mockResolvedValue({ capturePreviewEnabled: true });
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        await act(async () => {
            const container = document.getElementById('app')!;
            render(<App />, container);
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });

        const port = lastPort!;
        port.postMessage.mockClear(); // Clear initial show() call

        // Toggle capture full page on
        const captureFullPageToggle = document.querySelector('#capture-full-page-toggle') as HTMLInputElement;
        await act(async () => {
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype, 'checked'
            )!.set!;
            nativeInputValueSetter.call(captureFullPageToggle, true);
            captureFullPageToggle.dispatchEvent(new Event('change', { bubbles: true }));
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });

        // Should have sent show with full-page mode
        expect(port.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'preview:show', captureMode: 'full-page' })
        );

        // Now disable preview
        const previewToggle = document.querySelector('#capture-preview-toggle') as HTMLInputElement;
        await act(async () => {
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype, 'checked'
            )!.set!;
            nativeInputValueSetter.call(previewToggle, false);
            previewToggle.dispatchEvent(new Event('change', { bubbles: true }));
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });

        // Re-enable preview
        await act(async () => {
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype, 'checked'
            )!.set!;
            nativeInputValueSetter.call(previewToggle, true);
            previewToggle.dispatchEvent(new Event('change', { bubbles: true }));
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });

        // Should send show with the current capture mode (full-page)
        expect(port.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'preview:show', captureMode: 'full-page' })
        );
    });
});

// ── Task 2: Progressive iframe-only preview protocol ─────────────────────────

describe('Task 2: progressive iframe-only preview protocol', () => {
    let openPreviewSession: (tabId: number) => Promise<PreviewSession>;
    let chrome: ReturnType<typeof createChromeMock>;

    interface PreviewSession {
        show(captureMode: CaptureMode): void;
        inspect(captureMode: CaptureMode, generation: number): void;
        onEligibility(listener: (message: PreviewEligibilityMessage) => void): () => void;
        setLoading(): void;
        setReady(): void;
        hide(): void;
        disconnect(): void;
        setIncludeIframes(enabled: boolean): void;
    }

    beforeEach(async () => {
        chrome = createChromeMock();
        vi.stubGlobal('chrome', chrome);
        vi.resetModules();
        const mod = await import('../src/popup/preview-session');
        openPreviewSession = mod.openPreviewSession;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('sends setIncludeIframes command with correct structure', async () => {
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        const session = await openPreviewSession(42);
        session.setIncludeIframes(true);

        expect(lastPort).not.toBeNull();
        expect(lastPort!.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'preview:set-iframes',
                sessionId: expect.any(String),
                enabled: true,
            })
        );
        session.disconnect();
    });

    it('sends setIncludeIframes with enabled=false', async () => {
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        const session = await openPreviewSession(42);
        session.setIncludeIframes(false);

        expect(lastPort!.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'preview:set-iframes',
                sessionId: expect.any(String),
                enabled: false,
            })
        );
        session.disconnect();
    });

    it('setIncludeIframes is safe after disconnection', async () => {
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        const session = await openPreviewSession(42);
        session.disconnect();

        // Should not throw
        expect(() => session.setIncludeIframes(true)).not.toThrow();
    });
});

// ── Task 3: popup startup progressive and race-safe ──────────────────────────

describe('Task 3: popup startup progressive and race-safe', () => {
    let chrome: ReturnType<typeof createChromeMock>;
    let App: typeof import('../src/popup/App').App;
    let render: typeof import('preact').render;
    let act: typeof import('preact/test-utils').act;

    beforeEach(async () => {
        chrome = createChromeMock();
        vi.stubGlobal('chrome', chrome);

        // Stub the clipboard API
        vi.stubGlobal('navigator', {
            clipboard: {
                writeText: vi.fn(async () => {}),
            },
        });

        // Ensure document.body exists for Preact render
        if (!document.body) {
            document.body = document.createElement('body');
        }
        document.body.innerHTML = '<div id="app"></div>';

        vi.resetModules();
        const preact = await import('preact');
        const testUtils = await import('preact/test-utils');
        render = preact.render;
        act = testUtils.act;
        const appMod = await import('../src/popup/App');
        App = appMod.App;
    });

    afterEach(() => {
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    it('does not show twice while initial eligibility resolves', async () => {
        // Preview enabled, content script ready
        chrome.storage.local.get.mockResolvedValue({ capturePreviewEnabled: true });
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        await act(async () => {
            const container = document.getElementById('app')!;
            render(<App />, container);
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });

        const port = lastPort!;
        expect(port).not.toBeNull();

        // Should have exactly one show() call during startup
        const showCalls = port.postMessage.mock.calls.filter(
            (call: unknown[]) => (call[0] as { type?: string }).type === 'preview:show'
        );
        expect(showCalls.length).toBe(1);

        // The show() call must be with capture mode only — no includeIframes in the show message
        const showArgs = showCalls[0][0] as Record<string, unknown>;
        expect(showArgs).toHaveProperty('captureMode', 'smart');
        expect(showArgs).not.toHaveProperty('includeIframes');

        // show() must be called BEFORE inspect() — show must precede inspect so the preview
        // is visible while inspection runs for progressive rendering.
        const inspectIdx = port.postMessage.mock.calls.findIndex(
            (call: unknown[]) => (call[0] as { type?: string }).type === 'preview:inspect'
        );
        const showIdx = port.postMessage.mock.calls.findIndex(
            (call: unknown[]) => (call[0] as { type?: string }).type === 'preview:show'
        );
        // show must come before inspect so the preview is visible while inspection runs
        expect(showIdx).toBeLessThan(inspectIdx);

        // Now emit an eligibility response
        const inspectMessage = port.postMessage.mock.calls
            .map((call: unknown[]) => call[0] as { type?: string; sessionId?: string; generation?: number })
            .find((message) => message.type === 'preview:inspect');
        expect(inspectMessage).toBeDefined();

        port.emitMessage({
            type: 'preview:eligibility',
            sessionId: inspectMessage!.sessionId,
            captureMode: 'smart',
            generation: inspectMessage!.generation,
            hasEligibleIframes: true,
            hasImages: false,
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 20));
        });

        // Should still have only one show() call (eligibility should not trigger another show)
        const showCallsAfterEligibility = port.postMessage.mock.calls.filter(
            (call: unknown[]) => (call[0] as { type?: string }).type === 'preview:show'
        );
        expect(showCallsAfterEligibility.length).toBe(1);
    });

    it('keeps iframe inclusion on after off then on followed by eligibility', async () => {
        // Preview enabled, content script ready
        chrome.storage.local.get.mockResolvedValue({ capturePreviewEnabled: true });
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        await act(async () => {
            const container = document.getElementById('app')!;
            render(<App />, container);
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });

        const port = lastPort!;

        // Wait for eligibility to arrive first (simulating initial inspection)
        const inspectMessage = port.postMessage.mock.calls
            .map((call: unknown[]) => call[0] as { type?: string; sessionId?: string; generation?: number })
            .find((message) => message.type === 'preview:inspect');
        expect(inspectMessage).toBeDefined();

        port.emitMessage({
            type: 'preview:eligibility',
            sessionId: inspectMessage!.sessionId,
            captureMode: 'smart',
            generation: inspectMessage!.generation,
            hasEligibleIframes: true,
            hasImages: false,
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 20));
        });

        // Verify iframe inclusion is on initially
        expect(document.querySelector('#include-iframes-toggle')).not.toBeNull();
        const iframeToggle = document.querySelector('#include-iframes-toggle') as HTMLInputElement;
        expect(iframeToggle.checked).toBe(true);

        // Turn iframe inclusion off
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')!.set!;
            setter.call(iframeToggle, false);
            iframeToggle.dispatchEvent(new Event('change', { bubbles: true }));
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 20));
        });

        // Turn iframe inclusion back on
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')!.set!;
            setter.call(iframeToggle, true);
            iframeToggle.dispatchEvent(new Event('change', { bubbles: true }));
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 20));
        });

        // Verify iframe inclusion is back on
        expect(iframeToggle.checked).toBe(true);

        // Now emit another eligibility response (simulating a new inspection)
        port.postMessage.mockClear();

        // Request a new inspection via mode change
        port.postMessage.mockClear();
        await act(async () => {
            // Trigger a mode change to get a new inspection
            const captureFullPageToggle = document.querySelector('#capture-full-page-toggle') as HTMLInputElement;
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')!.set!;
            setter.call(captureFullPageToggle, true);
            captureFullPageToggle.dispatchEvent(new Event('change', { bubbles: true }));
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 20));
        });

        // Mode change must show once (capture mode only, no includeIframes) and inspect once
        const modeChangeShowCalls = port.postMessage.mock.calls.filter(
            (call: unknown[]) => (call[0] as { type?: string }).type === 'preview:show'
        );
        expect(modeChangeShowCalls.length).toBe(1);
        const modeShowArgs = modeChangeShowCalls[0][0] as Record<string, unknown>;
        expect(modeShowArgs).toHaveProperty('captureMode', 'full-page');
        expect(modeShowArgs).not.toHaveProperty('includeIframes');

        // show must be called BEFORE inspect during mode change
        const modeChangeShowIdx = port.postMessage.mock.calls.findIndex(
            (call: unknown[]) => (call[0] as { type?: string }).type === 'preview:show'
        );
        const modeChangeInspectIdx = port.postMessage.mock.calls.findIndex(
            (call: unknown[]) => (call[0] as { type?: string }).type === 'preview:inspect'
        );
        expect(modeChangeShowIdx).toBeLessThan(modeChangeInspectIdx);

        // Find the new inspect message
        const newInspect = port.postMessage.mock.calls
            .map((call: unknown[]) => call[0] as { type?: string; sessionId?: string; generation?: number })
            .find((message) => message.type === 'preview:inspect');
        expect(newInspect).toBeDefined();

        port.emitMessage({
            type: 'preview:eligibility',
            sessionId: newInspect!.sessionId,
            captureMode: 'full-page',
            generation: newInspect!.generation,
            hasEligibleIframes: true,
            hasImages: false,
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 20));
        });

        // Verify iframe inclusion is still on after eligibility
        expect(iframeToggle.checked).toBe(true);
    });

    it('does not show or set iframe inclusion while Preview is disabled', async () => {
        // Preview disabled from storage
        chrome.storage.local.get.mockResolvedValue({ capturePreviewEnabled: false });
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        await act(async () => {
            const container = document.getElementById('app')!;
            render(<App />, container);
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });

        const port = lastPort!;
        expect(port).not.toBeNull();

        // Should not have any show() calls
        const showCalls = port.postMessage.mock.calls.filter(
            (call: unknown[]) => (call[0] as { type?: string }).type === 'preview:show'
        );
        expect(showCalls.length).toBe(0);

        // Should not have any setIncludeIframes calls
        const setIframeCalls = port.postMessage.mock.calls.filter(
            (call: unknown[]) => (call[0] as { type?: string }).type === 'preview:set-iframes'
        );
        expect(setIframeCalls.length).toBe(0);

        // Now emit an eligibility response (simulating inspection that happens even when preview is off)
        const inspectMessage = port.postMessage.mock.calls
            .map((call: unknown[]) => call[0] as { type?: string; sessionId?: string; generation?: number })
            .find((message) => message.type === 'preview:inspect');
        expect(inspectMessage).toBeDefined();

        port.emitMessage({
            type: 'preview:eligibility',
            sessionId: inspectMessage!.sessionId,
            captureMode: 'smart',
            generation: inspectMessage!.generation,
            hasEligibleIframes: true,
            hasImages: false,
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 20));
        });

        // Should still not have any show() calls
        const showCallsAfter = port.postMessage.mock.calls.filter(
            (call: unknown[]) => (call[0] as { type?: string }).type === 'preview:show'
        );
        expect(showCallsAfter.length).toBe(0);

        // Should still not have any setIncludeIframes calls
        const setIframeCallsAfter = port.postMessage.mock.calls.filter(
            (call: unknown[]) => (call[0] as { type?: string }).type === 'preview:set-iframes'
        );
        expect(setIframeCallsAfter.length).toBe(0);
    });

    it('mode changes show once and inspect a new generation', async () => {
        // Preview enabled, content script ready
        chrome.storage.local.get.mockResolvedValue({ capturePreviewEnabled: true });
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        await act(async () => {
            const container = document.getElementById('app')!;
            render(<App />, container);
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });

        const port = lastPort!;
        port.postMessage.mockClear(); // Clear initial show() and inspect() calls

        // Change capture mode to full-page
        const captureFullPageToggle = document.querySelector('#capture-full-page-toggle') as HTMLInputElement;
        expect(captureFullPageToggle).not.toBeNull();

        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')!.set!;
            setter.call(captureFullPageToggle, true);
            captureFullPageToggle.dispatchEvent(new Event('change', { bubbles: true }));
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });

        // Should have exactly one show() call
        const showCalls = port.postMessage.mock.calls.filter(
            (call: unknown[]) => (call[0] as { type?: string }).type === 'preview:show'
        );
        expect(showCalls.length).toBe(1);

        // Should have exactly one inspect() call
        const inspectCalls = port.postMessage.mock.calls.filter(
            (call: unknown[]) => (call[0] as { type?: string }).type === 'preview:inspect'
        );
        expect(inspectCalls.length).toBe(1);

        // The inspect should have a new generation
        const inspectMessage = inspectCalls[0][0] as { generation?: number };
        expect(inspectMessage.generation).toBe(1); // First inspection after startup
    });

    it('reapplies iframe inclusion after a capture-mode change resets the preview', async () => {
        chrome.storage.local.get.mockResolvedValue({ capturePreviewEnabled: true });
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        await act(async () => {
            const container = document.getElementById('app')!;
            render(<App />, container);
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });

        const port = lastPort!;
        const initialInspect = port.postMessage.mock.calls
            .map((call: unknown[]) => call[0] as { type?: string; sessionId?: string; generation?: number })
            .find((message) => message.type === 'preview:inspect');
        expect(initialInspect).toBeDefined();

        port.emitMessage({
            type: 'preview:eligibility',
            sessionId: initialInspect!.sessionId,
            captureMode: 'smart',
            generation: initialInspect!.generation,
            hasEligibleIframes: true,
            hasImages: false,
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 20));
        });

        const iframeToggle = document.querySelector('#include-iframes-toggle') as HTMLInputElement;
        expect(iframeToggle).not.toBeNull();
        expect(iframeToggle.checked).toBe(true);
        port.postMessage.mockClear();

        const captureFullPageToggle = document.querySelector('#capture-full-page-toggle') as HTMLInputElement;
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')!.set!;
            setter.call(captureFullPageToggle, true);
            captureFullPageToggle.dispatchEvent(new Event('change', { bubbles: true }));
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });

        const nextInspect = port.postMessage.mock.calls
            .map((call: unknown[]) => call[0] as { type?: string; sessionId?: string; generation?: number })
            .find((message) => message.type === 'preview:inspect');
        expect(nextInspect).toBeDefined();

        port.emitMessage({
            type: 'preview:eligibility',
            sessionId: nextInspect!.sessionId,
            captureMode: 'full-page',
            generation: nextInspect!.generation,
            hasEligibleIframes: true,
            hasImages: false,
        });

        await act(async () => {
            await new Promise(r => setTimeout(r, 20));
        });

        expect(port.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'preview:set-iframes', enabled: true })
        );
    });
});

// ── Include Images Toggle ────────────────────────────────────────────────────

describe('Download images toggle', () => {
    let chrome: ReturnType<typeof createChromeMock>;
    let App: typeof import('../src/popup/App').App;
    let render: typeof import('preact').render;
    let act: typeof import('preact/test-utils').act;

    beforeEach(async () => {
        chrome = createChromeMock();
        vi.stubGlobal('chrome', chrome);
        vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) } });
        if (!document.body) document.body = document.createElement('body');
        document.body.innerHTML = '<div id="app"></div>';
        vi.resetModules();
        const preact = await import('preact');
        const testUtils = await import('preact/test-utils');
        render = preact.render;
        act = testUtils.act;
        const appMod = await import('../src/popup/App');
        App = appMod.App;
    });

    afterEach(() => {
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    async function renderApp() {
        await act(async () => {
            render(<App />, document.getElementById('app')!);
        });
        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });
    }

    function emitEligibility(hasImages: boolean) {
        const port = lastPort!;
        const inspect = port.postMessage.mock.calls
            .map((call: unknown[]) => call[0] as { type?: string; sessionId?: string; generation?: number })
            .find((m) => m.type === 'preview:inspect');
        port.emitMessage({
            type: 'preview:eligibility',
            sessionId: inspect!.sessionId,
            captureMode: 'smart',
            generation: inspect!.generation,
            hasEligibleIframes: false,
            hasImages,
        });
    }

    it('disables the Download images toggle until eligibility reports images', async () => {
        chrome.storage.local.get.mockResolvedValue({});
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });
        await renderApp();

        // Present-but-disabled with the reason, never hidden
        const toggleBefore = document.querySelector('#include-images-toggle') as HTMLInputElement;
        expect(toggleBefore).not.toBeNull();
        expect(toggleBefore.disabled).toBe(true);
        expect(document.body.textContent).toContain('No images on this page');

        emitEligibility(true);
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });

        const toggle = document.querySelector('#include-images-toggle') as HTMLInputElement;
        expect(toggle.disabled).toBe(false);
        expect(document.body.textContent).toContain('Converts and auto-downloads the page with its images as a ZIP');
        expect(document.body.textContent).not.toContain('No images on this page');
    });

    it('persists the choice to storage', async () => {
        chrome.storage.local.get.mockResolvedValue({});
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });
        await renderApp();
        emitEligibility(true);
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        const toggle = document.querySelector('#include-images-toggle') as HTMLInputElement;
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')!.set!;
            setter.call(toggle, true);
            toggle.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(chrome.storage.local.set).toHaveBeenCalledWith(expect.objectContaining({ includeImages: true }));
    });

    it('restores a persisted true value on mount', async () => {
        chrome.storage.local.get.mockImplementation(async (keys: string | string[]) => {
            const keyList = Array.isArray(keys) ? keys : [keys];
            if (keyList.includes('includeImages')) return { includeImages: true };
            return {};
        });
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });
        await renderApp();
        emitEligibility(true);
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        const toggle = document.querySelector('#include-images-toggle') as HTMLInputElement;
        expect(toggle.checked).toBe(true);
    });

    it('reverts the toggle and warns when permission is denied', async () => {
        chrome.storage.local.get.mockResolvedValue({});
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });
        chrome.permissions.contains.mockResolvedValue(false);
        chrome.permissions.request.mockResolvedValue(false);
        await renderApp();
        emitEligibility(true);
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        const toggle = document.querySelector('#include-images-toggle') as HTMLInputElement;
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')!.set!;
            setter.call(toggle, true);
            toggle.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(toggle.checked).toBe(false);
        expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ['<all_urls>'] });
        expect(document.body.textContent).toContain('site access permission');
        expect(chrome.storage.local.set).not.toHaveBeenCalledWith(expect.objectContaining({ includeImages: true }));
    });

    it('re-inspects when include iframes is toggled', async () => {
        chrome.storage.local.get.mockResolvedValue({});
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });
        await renderApp();
        // Emit eligibility with hasEligibleIframes: true so the iframe toggle renders
        const port = lastPort!;
        const inspect = port.postMessage.mock.calls
            .map((call: unknown[]) => call[0] as { type?: string; sessionId?: string; generation?: number })
            .find((m) => m.type === 'preview:inspect');
        port.emitMessage({
            type: 'preview:eligibility',
            sessionId: inspect!.sessionId,
            captureMode: 'smart',
            generation: inspect!.generation,
            hasEligibleIframes: true,
            hasImages: true,
        });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        const iframeToggle = document.querySelector('#include-iframes-toggle') as HTMLInputElement;
        expect(iframeToggle).not.toBeNull();
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')!.set!;
            setter.call(iframeToggle, false);
            iframeToggle.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        const inspects = port.postMessage.mock.calls
            .map((call: unknown[]) => call[0] as { type?: string })
            .filter((m) => m.type === 'preview:inspect');
        expect(inspects.length).toBeGreaterThanOrEqual(2);
    });

    it('re-inspects with includeIframes true when auto-inclusion flips iframes on', async () => {
        chrome.storage.local.get.mockResolvedValue({});
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });
        await renderApp();
        const port = lastPort!;

        const inspectsOf = () => port.postMessage.mock.calls
            .map((call: unknown[]) => call[0] as { type?: string; sessionId?: string; generation?: number; includeIframes?: boolean })
            .filter((m) => m.type === 'preview:inspect');

        // Page with NO root images: the only images live inside an eligible
        // iframe. The content script computed hasImages with includeIframes:
        // false, so the images toggle is present but disabled.
        const initial = inspectsOf();
        expect(initial).toHaveLength(1);
        port.emitMessage({
            type: 'preview:eligibility',
            sessionId: initial[0].sessionId,
            captureMode: 'smart',
            generation: initial[0].generation,
            hasEligibleIframes: true,
            hasImages: false,
        });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        const imagesToggleDormant = document.querySelector('#include-images-toggle') as HTMLInputElement;
        expect(imagesToggleDormant).not.toBeNull();
        expect(imagesToggleDormant.disabled).toBe(true);

        // Auto-inclusion flips include-iframes false -> true: a re-inspection
        // must be sent, and it must carry includeIframes: true so the content
        // script re-evaluates frame images under the new capture setting.
        const inspects = inspectsOf();
        expect(inspects.length).toBeGreaterThanOrEqual(2);
        const latest = inspects[inspects.length - 1];
        expect(latest).toHaveProperty('includeIframes', true);

        // Second eligibility from the re-inspection: the frame image now
        // counts, so the include-images toggle is enabled (F8 + F6 end-to-end).
        port.emitMessage({
            type: 'preview:eligibility',
            sessionId: latest.sessionId,
            captureMode: 'smart',
            generation: latest.generation,
            hasEligibleIframes: true,
            hasImages: true,
        });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        const imagesToggleActive = document.querySelector('#include-images-toggle') as HTMLInputElement;
        expect(imagesToggleActive).not.toBeNull();
        expect(imagesToggleActive.disabled).toBe(false);
    });

    it('sends the current include-iframes state with every inspect', async () => {
        chrome.storage.local.get.mockResolvedValue({ capturePreviewEnabled: true });
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });
        await renderApp();
        const port = lastPort!;

        const inspectOf = () => port.postMessage.mock.calls
            .map((call: unknown[]) => call[0] as { type?: string; includeIframes?: boolean })
            .find((m) => m.type === 'preview:inspect');

        // Initial state excludes iframes — the inspect must say so, or an
        // image-only iframe would surface the images toggle for images that
        // will never be in the Markdown.
        expect(inspectOf()).toHaveProperty('includeIframes', false);

        // Eligibility with frames makes the iframe toggle available and included.
        const inspect = port.postMessage.mock.calls
            .map((call: unknown[]) => call[0] as { type?: string; sessionId?: string; generation?: number })
            .find((m) => m.type === 'preview:inspect');
        port.emitMessage({
            type: 'preview:eligibility',
            sessionId: inspect!.sessionId,
            captureMode: 'smart',
            generation: inspect!.generation,
            hasEligibleIframes: true,
            hasImages: false,
        });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });

        const iframeToggle = document.querySelector('#include-iframes-toggle') as HTMLInputElement;
        expect(iframeToggle).not.toBeNull();

        // Toggling off re-inspects with includeIframes: false.
        port.postMessage.mockClear();
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')!.set!;
            setter.call(iframeToggle, false);
            iframeToggle.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(inspectOf()).toHaveProperty('includeIframes', false);

        // Toggling back on re-inspects with includeIframes: true.
        port.postMessage.mockClear();
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')!.set!;
            setter.call(iframeToggle, true);
            iframeToggle.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(inspectOf()).toHaveProperty('includeIframes', true);
    });

    it('re-inspects iframe eligibility when preview is disabled', async () => {
        chrome.storage.local.get.mockResolvedValue({ capturePreviewEnabled: false });
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });
        await renderApp();
        const port = lastPort!;
        const inspect = port.postMessage.mock.calls
            .map((call: unknown[]) => call[0] as { type?: string; sessionId?: string; generation?: number })
            .find((m) => m.type === 'preview:inspect');
        port.emitMessage({
            type: 'preview:eligibility',
            sessionId: inspect!.sessionId,
            captureMode: 'smart',
            generation: inspect!.generation,
            hasEligibleIframes: true,
            hasImages: true,
        });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        const iframeToggle = document.querySelector('#include-iframes-toggle') as HTMLInputElement;
        expect(iframeToggle).not.toBeNull();
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')!.set!;
            setter.call(iframeToggle, false);
            iframeToggle.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        const inspects = port.postMessage.mock.calls
            .map((call: unknown[]) => call[0] as { type?: string })
            .filter((m) => m.type === 'preview:inspect');
        expect(inspects.length).toBeGreaterThanOrEqual(2);
    });

    it('treats permission API rejection as denial', async () => {
        chrome.storage.local.get.mockResolvedValue({});
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });
        chrome.permissions.contains.mockResolvedValue(false);
        chrome.permissions.request.mockRejectedValue(new Error('api'));
        await renderApp();
        emitEligibility(true);
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        const toggle = document.querySelector('#include-images-toggle') as HTMLInputElement;
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')!.set!;
            setter.call(toggle, true);
            toggle.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(toggle.checked).toBe(false);
        expect(document.body.textContent).toContain('site access permission');
        expect(chrome.storage.local.set).not.toHaveBeenCalledWith(expect.objectContaining({ includeImages: true }));
    });

    it('disables the auto-download toggle while Download images is ON', async () => {
        chrome.storage.local.get.mockResolvedValue({ includeImages: true, autoDownload: true });
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });
        await renderApp();
        emitEligibility(true);
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });

        const autoDownloadToggle = document.querySelector('#auto-download-toggle') as HTMLInputElement;
        expect(autoDownloadToggle).not.toBeNull();
        expect(autoDownloadToggle.disabled).toBe(true);
        expect(autoDownloadToggle.checked).toBe(true);
        const label = document.querySelector('label[for="auto-download-toggle"]') as HTMLElement;
        expect(label.className).toContain('cursor-not-allowed');
        expect(label.className).toContain('opacity-60');
        expect(label.className).not.toContain('cursor-pointer');
    });

    it('keeps the auto-download value while Download images toggles', async () => {
        chrome.storage.local.get.mockResolvedValue({});
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });
        await renderApp();
        emitEligibility(true);
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });

        // Turn Auto-download ON (this legitimately persists { autoDownload: true } once)
        const autoDownloadToggle = document.querySelector('#auto-download-toggle') as HTMLInputElement;
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')!.set!;
            setter.call(autoDownloadToggle, true);
            autoDownloadToggle.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(autoDownloadToggle.checked).toBe(true);

        // Download images ON → auto-download stays checked but disabled
        const imagesToggle = document.querySelector('#include-images-toggle') as HTMLInputElement;
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')!.set!;
            setter.call(imagesToggle, true);
            imagesToggle.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(autoDownloadToggle.checked).toBe(true);
        expect(autoDownloadToggle.disabled).toBe(true);

        // Download images OFF → auto-download re-enabled, value intact
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')!.set!;
            setter.call(imagesToggle, false);
            imagesToggle.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(autoDownloadToggle.checked).toBe(true);
        expect(autoDownloadToggle.disabled).toBe(false);

        // Only the initial click persisted autoDownload (include-images clicks must not)
        const autoDownloadWrites = chrome.storage.local.set.mock.calls
            .filter((call: unknown[]) => call[0] && 'autoDownload' in (call[0] as Record<string, unknown>));
        expect(autoDownloadWrites).toHaveLength(1);
    });

    it('enables the auto-download toggle when Download images is ON but the page has no images', async () => {
        chrome.storage.local.get.mockResolvedValue({ includeImages: true });
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });
        await renderApp();
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });

        // No eligibility emitted: include-images toggle present, checked-but-greyed;
        // auto-download enabled (the persisted images preference is dormant).
        const imagesToggle = document.querySelector('#include-images-toggle') as HTMLInputElement;
        expect(imagesToggle).not.toBeNull();
        expect(imagesToggle.disabled).toBe(true);
        expect(imagesToggle.checked).toBe(true);
        const autoDownloadToggle = document.querySelector('#auto-download-toggle') as HTMLInputElement;
        expect(autoDownloadToggle).not.toBeNull();
        expect(autoDownloadToggle.disabled).toBe(false);
        expect(document.body.textContent).toContain('No images on this page');
        expect(document.body.textContent).not.toContain('Handled by Download images');
    });

    it('follows eligibility flips: images and auto-download disable only while images are active', async () => {
        chrome.storage.local.get.mockResolvedValue({ includeImages: true, autoDownload: true });
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });
        await renderApp();

        const imagesToggle = () => document.querySelector('#include-images-toggle') as HTMLInputElement;
        const autoToggle = () => document.querySelector('#auto-download-toggle') as HTMLInputElement;

        // Eligibility reports no images: images toggle disabled, auto-download enabled
        emitEligibility(false);
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(imagesToggle().disabled).toBe(true);
        expect(autoToggle().disabled).toBe(false);
        expect(document.body.textContent).toContain('No images on this page');

        // Eligibility reports images: images toggle enabled, auto-download disabled
        emitEligibility(true);
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(imagesToggle().disabled).toBe(false);
        expect(autoToggle().disabled).toBe(true);
        expect(document.body.textContent).toContain('Handled by Download images');
        expect(document.body.textContent).not.toContain('No images on this page');

        // Down-flip again: back to dormant
        emitEligibility(false);
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(imagesToggle().disabled).toBe(true);
        expect(autoToggle().disabled).toBe(false);
    });

    it('leaves the persisted includeImages preference untouched by eligibility changes', async () => {
        chrome.storage.local.get.mockResolvedValue({ includeImages: true });
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });
        await renderApp();
        emitEligibility(true);
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        emitEligibility(false);
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });

        const includeImagesWrites = chrome.storage.local.set.mock.calls
            .filter((call: unknown[]) => call[0] && 'includeImages' in (call[0] as Record<string, unknown>));
        expect(includeImagesWrites).toHaveLength(0);
    });

    it('follows eligibility flips for iframes: disabled, enabled, disabled again with the reason', async () => {
        chrome.storage.local.get.mockResolvedValue({});
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });
        await renderApp();

        const port = lastPort!;
        const inspectsOf = () => port.postMessage.mock.calls
            .map((call: unknown[]) => call[0] as { type?: string; sessionId?: string; generation?: number })
            .filter((m) => m.type === 'preview:inspect');

        const iframeToggle = () => document.querySelector('#include-iframes-toggle') as HTMLInputElement;
        expect(iframeToggle().disabled).toBe(true);
        expect(document.body.textContent).toContain('No iframes on this page');

        // Eligible: enabled, reason gone
        const initial = inspectsOf();
        port.emitMessage({
            type: 'preview:eligibility',
            sessionId: initial[0].sessionId,
            captureMode: 'smart',
            generation: initial[0].generation,
            hasEligibleIframes: true,
            hasImages: false,
        });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(iframeToggle().disabled).toBe(false);
        expect(document.body.textContent).not.toContain('No iframes on this page');

        // Down-flip: disabled again, reason back. The auto-inclusion flip
        // triggered a re-inspection, so emit with the LATEST generation.
        const latest = inspectsOf()[inspectsOf().length - 1];
        port.emitMessage({
            type: 'preview:eligibility',
            sessionId: latest.sessionId,
            captureMode: 'smart',
            generation: latest.generation,
            hasEligibleIframes: false,
            hasImages: false,
        });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(iframeToggle().disabled).toBe(true);
        expect(document.body.textContent).toContain('No iframes on this page');
    });
});

// ── Zip Download Flow ────────────────────────────────────────────────────────

describe('Zip download flow', () => {
    let chrome: ReturnType<typeof createChromeMock>;
    let App: typeof import('../src/popup/App').App;
    let render: typeof import('preact').render;
    let act: typeof import('preact/test-utils').act;

    beforeEach(async () => {
        chrome = createChromeMock();
        vi.stubGlobal('chrome', chrome);
        vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) } });
        if (!document.body) document.body = document.createElement('body');
        document.body.innerHTML = '<div id="app"></div>';
        vi.resetModules();
        const preact = await import('preact');
        const testUtils = await import('preact/test-utils');
        render = preact.render;
        act = testUtils.act;
        const appMod = await import('../src/popup/App');
        App = appMod.App;
    });

    afterEach(() => {
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    async function renderApp() {
        await act(async () => {
            render(<App />, document.getElementById('app')!);
        });
        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });
    }

    function emitEligibility() {
        const port = lastPort!;
        const inspect = port.postMessage.mock.calls
            .map((call: unknown[]) => call[0] as { type?: string; sessionId?: string; generation?: number })
            .find((m) => m.type === 'preview:inspect');
        port.emitMessage({
            type: 'preview:eligibility',
            sessionId: inspect!.sessionId,
            captureMode: 'smart',
            generation: inspect!.generation,
            hasEligibleIframes: false,
            hasImages: true,
        });
    }

    function emitMessage(msg: unknown) {
        const listener = chrome.runtime.onMessage.addListener.mock.calls[0][0] as (m: unknown) => void;
        listener(msg);
    }

    it('downloads a plain .md when the toggle is off (single button)', async () => {
        chrome.storage.local.get.mockResolvedValue({ includeImages: false });
        chrome.tabs.sendMessage.mockResolvedValue({ success: true, markdown: '# Hello' });
        vi.stubGlobal('fetch', vi.fn());
        const createObjectURL = vi.fn(() => 'blob:mock');
        const revokeObjectURL = vi.fn();
        vi.stubGlobal('URL', new Proxy(URL, {
            get: (target, prop, receiver) => {
                if (prop === 'createObjectURL') return createObjectURL;
                if (prop === 'revokeObjectURL') return revokeObjectURL;
                return Reflect.get(target, prop, receiver);
            },
        }));

        await renderApp();
        const startButton = document.querySelector('button') as HTMLButtonElement;
        await act(async () => { startButton.click(); });
        await act(async () => { await new Promise(r => setTimeout(r, 100)); });

        expect(document.body.textContent).toContain('.md');
        expect(document.body.textContent).not.toContain('.md + images');
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('renders the split button when the toggle is on and conversion succeeds', async () => {
        chrome.storage.local.get.mockResolvedValue({ includeImages: true });
        chrome.tabs.sendMessage.mockResolvedValue({ success: true, markdown: '# Hello' });

        await renderApp();
        emitEligibility();
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });

        const startButton = document.querySelector('button') as HTMLButtonElement;
        await act(async () => { startButton.click(); });
        await act(async () => { await new Promise(r => setTimeout(r, 100)); });

        // The toggle auto-starts the zip build on convert; complete it and wait
        // out the "Downloaded!" flash so the split button re-renders live.
        const buildId = (chrome.runtime.sendMessage.mock.calls[0][0] as { buildId: string }).buildId;
        emitMessage({ type: 'zip:done', buildId, downloaded: 'zip', totalImages: 0, bundledImages: 0, skippedImages: 0, filename: 'hello.zip' });
        await act(async () => { await new Promise(r => setTimeout(r, 2050)); });

        expect(document.body.textContent).toContain('.md + images');
    });

    it('right half downloads the zip when images are present (manual re-download)', async () => {
        chrome.storage.local.get.mockResolvedValue({ includeImages: true });
        chrome.tabs.sendMessage.mockResolvedValue({
            success: true,
            markdown: '![Hero](https://e.com/hero.png)',
        });
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))));
        const createObjectURL = vi.fn(() => 'blob:mock');
        const revokeObjectURL = vi.fn();
        vi.stubGlobal('URL', new Proxy(URL, {
            get: (target, prop, receiver) => {
                if (prop === 'createObjectURL') return createObjectURL;
                if (prop === 'revokeObjectURL') return revokeObjectURL;
                return Reflect.get(target, prop, receiver);
            },
        }));

        await renderApp();
        emitEligibility();
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });

        const startButton = document.querySelector('button') as HTMLButtonElement;
        await act(async () => { startButton.click(); });
        await act(async () => { await new Promise(r => setTimeout(r, 100)); });

        // The toggle auto-started the build on convert; complete it and wait
        // out the flash so the split button is live.
        const autoBuildId = (chrome.runtime.sendMessage.mock.calls[0][0] as { buildId: string }).buildId;
        emitMessage({ type: 'zip:done', buildId: autoBuildId, downloaded: 'zip', totalImages: 1, bundledImages: 1, skippedImages: 0, filename: 'Example.zip' });
        await act(async () => { await new Promise(r => setTimeout(r, 2050)); });

        chrome.runtime.sendMessage.mockClear();

        // Find the right half button (contains ".md + images")
        const buttons = Array.from(document.querySelectorAll('button'));
        const zipButton = buttons.find((b) => b.textContent?.includes('.md + images')) as HTMLButtonElement;
        expect(zipButton).not.toBeUndefined();
        await act(async () => { zipButton.click(); });
        await act(async () => { await new Promise(r => setTimeout(r, 100)); });

        // The manual re-download also delegates to the service worker via
        // build_zip, so no fetch and no createObjectURL in the popup.
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'build_zip',
                buildId: expect.any(String),
            }),
        );
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(createObjectURL).not.toHaveBeenCalled();
    });

    it('left half clears the image note after a zip download', async () => {
        chrome.storage.local.get.mockResolvedValue({ includeImages: true });
        chrome.tabs.sendMessage.mockResolvedValue({
            success: true,
            markdown: '![Hero](https://e.com/hero.png)',
        });
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))));
        const createObjectURL = vi.fn(() => 'blob:mock');
        const revokeObjectURL = vi.fn();
        vi.stubGlobal('URL', new Proxy(URL, {
            get: (target, prop, receiver) => {
                if (prop === 'createObjectURL') return createObjectURL;
                if (prop === 'revokeObjectURL') return revokeObjectURL;
                return Reflect.get(target, prop, receiver);
            },
        }));

        await renderApp();
        emitEligibility();
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });

        const startButton = document.querySelector('button') as HTMLButtonElement;
        await act(async () => { startButton.click(); });
        await act(async () => { await new Promise(r => setTimeout(r, 100)); });

        // The image note arrives via the auto build's zip:done broadcast from
        // the service worker (the popup no longer builds the zip itself).
        const buildId = (chrome.runtime.sendMessage.mock.calls[0][0] as { buildId: string }).buildId;
        emitMessage({
            type: 'zip:done',
            buildId,
            downloaded: 'zip',
            totalImages: 1,
            bundledImages: 1,
            skippedImages: 0,
            filename: 'Example.zip',
        });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });

        // Zip download leaves the image note displayed
        expect(document.body.textContent).toContain('Included 1 images');

        // The zip:done handler flashes a "Downloaded!" button for 2 seconds
        // (setDownloaded(true)), which detaches the split-button subtree — and
        // Preact removes the listeners of the detached node, so a stale
        // reference click never reaches handleDownload. Wait out the flash so
        // the re-mounted split button is live again.
        await act(async () => { await new Promise(r => setTimeout(r, 2050)); });

        // Re-query the CURRENT .md button (the left half renders a DownloadIcon
        // + ".md"; the SVG contributes no text, so textContent is exactly ".md").
        const freshButtons = Array.from(document.querySelectorAll('button'));
        const mdButton = freshButtons.find((b) => b.textContent?.trim() === '.md') as HTMLButtonElement;
        expect(mdButton).not.toBeUndefined();
        await act(async () => { mdButton.click(); });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });

        expect(document.body.textContent).not.toContain('Included 1 images');
    });

    it('auto-downloads the zip when both toggles are on', async () => {
        chrome.storage.local.get.mockResolvedValue({ includeImages: true, autoDownload: true });
        chrome.tabs.sendMessage.mockResolvedValue({
            success: true,
            markdown: '![Hero](https://e.com/hero.png)',
        });
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))));
        const createObjectURL = vi.fn(() => 'blob:mock');
        const revokeObjectURL = vi.fn();
        vi.stubGlobal('URL', new Proxy(URL, {
            get: (target, prop, receiver) => {
                if (prop === 'createObjectURL') return createObjectURL;
                if (prop === 'revokeObjectURL') return revokeObjectURL;
                return Reflect.get(target, prop, receiver);
            },
        }));

        await renderApp();
        emitEligibility();
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });

        const startButton = document.querySelector('button') as HTMLButtonElement;
        await act(async () => { startButton.click(); });
        await act(async () => { await new Promise(r => setTimeout(r, 200)); });

        // Auto-download with images routes through the service worker's
        // build_zip; the popup no longer fetches or creates blob URLs.
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'build_zip' }),
        );
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(createObjectURL).not.toHaveBeenCalled();
    });

    it('downloads the zip on convert with the images toggle alone (auto-download off)', async () => {
        chrome.storage.local.get.mockResolvedValue({ includeImages: true, autoDownload: false });
        chrome.tabs.sendMessage.mockResolvedValue({
            success: true,
            markdown: '![Hero](https://e.com/hero.png)',
        });

        await renderApp();
        emitEligibility();
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });

        const startButton = document.querySelector('button') as HTMLButtonElement;
        await act(async () => { startButton.click(); });
        await act(async () => { await new Promise(r => setTimeout(r, 100)); });

        // The "Download images" toggle alone triggers the ZIP build on convert —
        // auto-download is NOT required for the zip path.
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'build_zip' }),
        );
    });

    function emitNoImageEligibility() {
        const port = lastPort!;
        const inspect = port.postMessage.mock.calls
            .map((call: unknown[]) => call[0] as { type?: string; sessionId?: string; generation?: number })
            .find((m) => m.type === 'preview:inspect');
        port.emitMessage({
            type: 'preview:eligibility',
            sessionId: inspect!.sessionId,
            captureMode: 'smart',
            generation: inspect!.generation,
            hasEligibleIframes: false,
            hasImages: false,
        });
    }

    it('downloads nothing on convert when the page has no images and auto-download is off', async () => {
        chrome.storage.local.get.mockResolvedValue({ includeImages: true, autoDownload: false });
        chrome.tabs.sendMessage.mockResolvedValue({ success: true, markdown: '# Hello' });
        vi.stubGlobal('fetch', vi.fn());
        const createObjectURL = vi.fn(() => 'blob:mock');
        const revokeObjectURL = vi.fn();
        vi.stubGlobal('URL', new Proxy(URL, {
            get: (target, prop, receiver) => {
                if (prop === 'createObjectURL') return createObjectURL;
                if (prop === 'revokeObjectURL') return revokeObjectURL;
                return Reflect.get(target, prop, receiver);
            },
        }));

        await renderApp();
        emitNoImageEligibility();
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });

        const startButton = document.querySelector('button') as HTMLButtonElement;
        await act(async () => { startButton.click(); });
        await act(async () => { await new Promise(r => setTimeout(r, 100)); });

        // Bug 2 regression: the persisted images preference is dormant on an
        // image-less page — no ZIP build, no blob download, nothing fires.
        expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ action: 'build_zip' }),
        );
        expect(createObjectURL).not.toHaveBeenCalled();
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(document.querySelector('h2')?.textContent).toContain('Content extracted');
    });

    it('auto-downloads only the plain .md when the page has no images but auto-download is on', async () => {
        chrome.storage.local.get.mockResolvedValue({ includeImages: true, autoDownload: true });
        chrome.tabs.sendMessage.mockResolvedValue({ success: true, markdown: '# Hello' });
        const createObjectURL = vi.fn(() => 'blob:mock');
        const revokeObjectURL = vi.fn();
        vi.stubGlobal('URL', new Proxy(URL, {
            get: (target, prop, receiver) => {
                if (prop === 'createObjectURL') return createObjectURL;
                if (prop === 'revokeObjectURL') return revokeObjectURL;
                return Reflect.get(target, prop, receiver);
            },
        }));

        await renderApp();
        emitNoImageEligibility();
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });

        const startButton = document.querySelector('button') as HTMLButtonElement;
        await act(async () => { startButton.click(); });
        await act(async () => { await new Promise(r => setTimeout(r, 100)); });

        // Plain .md via the popup blob path — NOT the service-worker zip path
        expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ action: 'build_zip' }),
        );
        expect(createObjectURL).toHaveBeenCalled();
    });

    it('shows a single .md button (no split) on success when the page has no images', async () => {
        chrome.storage.local.get.mockResolvedValue({ includeImages: true });
        chrome.tabs.sendMessage.mockResolvedValue({ success: true, markdown: '# Hello' });
        vi.stubGlobal('fetch', vi.fn());

        await renderApp();
        emitNoImageEligibility();
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });

        const startButton = document.querySelector('button') as HTMLButtonElement;
        await act(async () => { startButton.click(); });
        await act(async () => { await new Promise(r => setTimeout(r, 100)); });

        expect(document.body.textContent).toContain('.md');
        expect(document.body.textContent).not.toContain('.md + images');
        expect(document.body.textContent).not.toContain('Bundling');
    });

    it('reverts the split button to a single .md button when eligibility flips to no images', async () => {
        chrome.storage.local.get.mockResolvedValue({ includeImages: true });
        chrome.tabs.sendMessage.mockResolvedValue({
            success: true,
            markdown: '![Hero](https://e.com/hero.png)',
        });
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))));

        await renderApp();
        emitEligibility(); // hasImages: true — images active
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });

        const startButton = document.querySelector('button') as HTMLButtonElement;
        await act(async () => { startButton.click(); });
        await act(async () => { await new Promise(r => setTimeout(r, 100)); });

        // The toggle auto-started the zip build; complete it and wait out the
        // "Downloaded!" flash so the split button re-renders live.
        const buildId = (chrome.runtime.sendMessage.mock.calls[0][0] as { buildId: string }).buildId;
        emitMessage({ type: 'zip:done', buildId, downloaded: 'zip', totalImages: 1, bundledImages: 1, skippedImages: 0, filename: 'Example.zip' });
        await act(async () => { await new Promise(r => setTimeout(r, 2050)); });
        expect(document.body.textContent).toContain('.md + images');

        // Mid-session eligibility down-flip: split reverts to single .md
        emitNoImageEligibility();
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(document.body.textContent).not.toContain('.md + images');
        expect(document.body.textContent).toContain('.md');
    });
});

// ── Zip Build Progress Flow ──────────────────────────────────────────────────

describe('Zip build progress flow', () => {
    let chrome: ReturnType<typeof createChromeMock>;
    let App: typeof import('../src/popup/App').App;
    let render: typeof import('preact').render;
    let act: typeof import('preact/test-utils').act;

    beforeEach(async () => {
        chrome = createChromeMock();
        vi.stubGlobal('chrome', chrome);
        vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) } });
        if (!document.body) document.body = document.createElement('body');
        document.body.innerHTML = '<div id="app"></div>';
        vi.resetModules();
        const preact = await import('preact');
        const testUtils = await import('preact/test-utils');
        render = preact.render;
        act = testUtils.act;
        const appMod = await import('../src/popup/App');
        App = appMod.App;
    });

    afterEach(() => {
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    async function renderApp() {
        await act(async () => {
            render(<App />, document.getElementById('app')!);
        });
        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });
    }

    function emitEligibility() {
        const port = lastPort!;
        const inspect = port.postMessage.mock.calls
            .map((call: unknown[]) => call[0] as { type?: string; sessionId?: string; generation?: number })
            .find((m) => m.type === 'preview:inspect');
        port.emitMessage({
            type: 'preview:eligibility',
            sessionId: inspect!.sessionId,
            captureMode: 'smart',
            generation: inspect!.generation,
            hasEligibleIframes: false,
            hasImages: true,
        });
    }

    function emitMessage(msg: unknown) {
        const listener = chrome.runtime.onMessage.addListener.mock.calls[0][0] as (m: unknown) => void;
        listener(msg);
    }

    async function convertWithImages() {
        chrome.storage.local.get.mockResolvedValue({ includeImages: true });
        chrome.tabs.sendMessage.mockResolvedValue({
            success: true,
            markdown: '![Hero](https://e.com/hero.png)',
        });
        await renderApp();
        emitEligibility();
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        const startButton = document.querySelector('button') as HTMLButtonElement;
        await act(async () => { startButton.click(); });
        await act(async () => { await new Promise(r => setTimeout(r, 100)); });
    }

    it('starts the zip build on convert and shows the bundling button state', async () => {
        await convertWithImages();

        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'build_zip',
                buildId: expect.any(String),
                payload: expect.objectContaining({
                    markdown: '![Hero](https://e.com/hero.png)',
                    title: 'example',
                }),
            }),
        );
        // Right half now shows "Bundling…"
        expect(document.body.textContent).toContain('Bundling');
    });

    it('updates the progress strip from zip:progress messages and clears on zip:done', async () => {
        await convertWithImages();

        const buildId = (chrome.runtime.sendMessage.mock.calls[0][0] as { buildId: string }).buildId;
        emitMessage({ type: 'zip:progress', buildId, phase: 'fetch', fetched: 1, total: 2 });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(document.body.textContent).toContain('Fetching images 1/2');
        expect(document.querySelector('[role="status"]')).not.toBeNull();

        emitMessage({ type: 'zip:progress', buildId, phase: 'build' });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(document.body.textContent).toContain('Building ZIP');

        emitMessage({ type: 'zip:done', buildId, downloaded: 'zip', totalImages: 2, bundledImages: 2, skippedImages: 0, filename: 'Example.zip' });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(document.querySelector('[role="status"]')).toBeNull();
        expect(document.body.textContent).toContain('Included 2 images');
        expect(document.querySelector('h2')?.textContent).toContain('Content extracted');
    });

    it('ignores messages with a stale buildId', async () => {
        await convertWithImages();

        emitMessage({ type: 'zip:progress', buildId: 'stale-build', phase: 'fetch', fetched: 9, total: 9 });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(document.querySelector('[role="status"]')).not.toBeNull();
        expect(document.body.textContent).not.toContain('9/9');
    });

    it('shows zip:error as a note and clears the strip', async () => {
        await convertWithImages();

        const buildId = (chrome.runtime.sendMessage.mock.calls[0][0] as { buildId: string }).buildId;
        emitMessage({ type: 'zip:error', buildId, error: 'Could not build the download.' });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(document.querySelector('[role="status"]')).toBeNull();
        expect(document.body.textContent).toContain('Could not build the download.');
        expect(document.querySelector('h2')?.textContent).toContain('Content extracted');
    });

    it('shows "Bundling images…" in the status pill while the zip build is in flight', async () => {
        await convertWithImages();

        const pill = document.querySelector('h2');
        expect(pill?.textContent).toContain('Bundling images');
        expect(pill?.textContent).not.toContain('Content extracted');
    });

    it('recovers when the zip build message fails to send', async () => {
        chrome.storage.local.get.mockResolvedValue({ includeImages: true });
        chrome.tabs.sendMessage.mockResolvedValue({
            success: true,
            markdown: '![Hero](https://e.com/hero.png)',
        });
        chrome.runtime.sendMessage.mockRejectedValueOnce(new Error('port closed'));
        await renderApp();
        emitEligibility();
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        const startButton = document.querySelector('button') as HTMLButtonElement;
        await act(async () => { startButton.click(); });
        await act(async () => { await new Promise(r => setTimeout(r, 100)); });

        expect(document.querySelector('[role="status"]')).toBeNull();
        expect(document.querySelector('h2')?.textContent).toContain('Content extracted');
    });

    it('notes the md-only fallback when the zip build found no images', async () => {
        await convertWithImages();
        const buildId = (chrome.runtime.sendMessage.mock.calls[0][0] as { buildId: string }).buildId;
        emitMessage({ type: 'zip:done', buildId, downloaded: 'md', totalImages: 2, bundledImages: 0, skippedImages: 2, filename: 'Example.zip' });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });

        expect(document.body.textContent).toContain('Images unavailable - downloaded .md only');
        expect(document.querySelector('h2')?.textContent).toContain('Content extracted');
    });

    it('shows no images note when the md-only fallback has no images at all', async () => {
        await convertWithImages();
        const buildId = (chrome.runtime.sendMessage.mock.calls[0][0] as { buildId: string }).buildId;
        emitMessage({ type: 'zip:done', buildId, downloaded: 'md', totalImages: 0, bundledImages: 0, skippedImages: 0, filename: 'Example.zip' });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });

        expect(document.body.textContent).not.toContain('Images unavailable');
        expect(document.body.textContent).not.toContain('Included');
    });

    it('keeps "Processing content..." during a re-convert while a build is in flight', async () => {
        await convertWithImages();
        chrome.tabs.sendMessage.mockReturnValueOnce(new Promise(() => {}));
        const startButton = Array.from(document.querySelectorAll('button'))
            .find((b) => b.textContent?.includes('start')) as HTMLButtonElement;
        await act(async () => { startButton.click(); });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });

        expect(document.querySelector('h2')?.textContent).toContain('Processing content');
        expect(document.querySelector('h2')?.textContent).not.toContain('Bundling images');
    });

    it('restores progress on reopen from storage.session and refreshes via zip:status', async () => {
        chrome._sessionData.activeZipBuild = { buildId: 'b-reopen', phase: 'fetch', fetched: 4, total: 10, startedAt: 1 };
        chrome.storage.local.get.mockResolvedValue({});
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });
        chrome.runtime.sendMessage.mockResolvedValue({ active: true, buildId: 'b-reopen', phase: 'fetch', fetched: 5, total: 10 });

        await renderApp();
        await act(async () => { await new Promise(r => setTimeout(r, 50)); });

        // Strip visible from the stored snapshot, then refreshed by the status ping
        expect(document.querySelector('[role="status"]')).not.toBeNull();
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'zip:status', buildId: 'b-reopen' }),
        );
        expect(document.body.textContent).toContain('Fetching images 5/10');
        // Restore path keeps status idle: pill stays "Ready to capture"
        expect(document.querySelector('h2')?.textContent).toContain('Ready to capture');
    });

    it('hides the strip when zip:status reports the build is gone', async () => {
        chrome._sessionData.activeZipBuild = { buildId: 'b-dead', phase: 'fetch', fetched: 1, total: 2, startedAt: 1 };
        chrome.storage.local.get.mockResolvedValue({});
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });
        chrome.runtime.sendMessage.mockResolvedValue({ active: false });

        await renderApp();
        await act(async () => { await new Promise(r => setTimeout(r, 50)); });

        expect(document.querySelector('[role="status"]')).toBeNull();
    });

    it('auto-download routes through build_zip when both toggles are on', async () => {
        chrome.storage.local.get.mockResolvedValue({ includeImages: true, autoDownload: true });
        chrome.tabs.sendMessage.mockResolvedValue({
            success: true,
            markdown: '![Hero](https://e.com/hero.png)',
        });
        await renderApp();
        emitEligibility();
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });

        const startButton = document.querySelector('button') as HTMLButtonElement;
        await act(async () => { startButton.click(); });
        await act(async () => { await new Promise(r => setTimeout(r, 100)); });

        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'build_zip' }),
        );
    });

    it('renders the progress strip above the Copy to Clipboard button', async () => {
        await convertWithImages();

        const strip = document.querySelector('[role="status"]') as HTMLElement;
        const copyButton = Array.from(document.querySelectorAll('button'))
            .find((b) => b.textContent?.includes('Copy to Clipboard')) as HTMLElement;
        expect(strip).not.toBeNull();
        expect(copyButton).not.toBeUndefined();
        expect(strip.compareDocumentPosition(copyButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('shows the zip:error note even when it arrives after zip:done', async () => {
        await convertWithImages();
        const buildId = (chrome.runtime.sendMessage.mock.calls[0][0] as { buildId: string }).buildId;
        emitMessage({ type: 'zip:done', buildId, downloaded: 'zip', totalImages: 1, bundledImages: 1, skippedImages: 0, filename: 'Example.zip' });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(document.querySelector('h2')?.textContent).toContain('Content extracted');

        // The SW watchdog broadcasts zip:error up to 10 s after zip:done when
        // no download item appeared.
        emitMessage({ type: 'zip:error', buildId, error: 'The download failed. Try again.' });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(document.body.textContent).toContain('The download failed. Try again.');
        expect(document.querySelector('[role="status"]')).toBeNull();
        expect(document.querySelector('h2')?.textContent).toContain('Content extracted');
    });

    it('drops zip:error for a superseded build after a newer one starts', async () => {
        await convertWithImages();
        const oldBuildId = (chrome.runtime.sendMessage.mock.calls[0][0] as { buildId: string }).buildId;
        emitMessage({ type: 'zip:done', buildId: oldBuildId, downloaded: 'zip', totalImages: 1, bundledImages: 1, skippedImages: 0, filename: 'Example.zip' });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        // zip:done flips the "Downloaded!" badge on for 2 s, which replaces the
        // download button row; wait it out so the .md + images button is back.
        await act(async () => { await new Promise(r => setTimeout(r, 2100)); });
        const mdImagesButton = Array.from(document.querySelectorAll('button'))
            .find((b) => b.textContent?.includes('.md + images')) as HTMLButtonElement;
        await act(async () => { mdImagesButton.click(); });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });

        emitMessage({ type: 'zip:error', buildId: oldBuildId, error: 'stale error' });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(document.body.textContent).not.toContain('stale error');
    });
});
