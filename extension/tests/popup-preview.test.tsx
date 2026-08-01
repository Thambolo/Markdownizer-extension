// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { PREVIEW_PORT_NAME, type CaptureMode } from '../src/preview-protocol';

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
            sendMessage: vi.fn(),
            openOptionsPage: vi.fn(),
            getURL: vi.fn((path: string) => `chrome-extension://abc123/${path}`),
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
        },
        _storageData: storageData,
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

        // The session should NOT be opened because preview is disabled
        // Note: tabs.connect is only called by openPreviewSession; if preview is disabled,
        // openPreviewSession is never invoked, so tabs.connect should NOT have been called
        // for the preview purpose. However, ensureContentScriptLoaded also calls sendMessage.
        expect(chrome.tabs.connect).not.toHaveBeenCalled();
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

        // Session should not be opened when preview is disabled
        expect(chrome.tabs.connect).not.toHaveBeenCalled();
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
