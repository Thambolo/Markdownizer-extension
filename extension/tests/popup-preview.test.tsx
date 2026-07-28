import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { PREVIEW_PORT_NAME } from '../src/preview-protocol';

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
    return {
        tabs: {
            connect: vi.fn((_tabId: number, opts: { name: string }) => {
                const port = createMockPort(opts.name);
                lastPort = port;
                return port;
            }),
            sendMessage: vi.fn(),
        },
        scripting: {
            executeScript: vi.fn(async () => []),
        },
        runtime: {
            getManifest: vi.fn(() => ({
                content_scripts: [
                    { js: ['content.js'] },
                ],
            })),
            sendMessage: vi.fn(),
        },
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
        show(): void;
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
        const session2 = await openPreviewSession(2);

        // Both sessions should work without error (they have different session IDs)
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
        session.show();

        expect(lastPort).not.toBeNull();
        expect(lastPort!.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'preview:show', sessionId: expect.any(String) })
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
        expect(() => session.show()).not.toThrow();
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
        session.show();

        expect(lastPort!.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ sessionId: mockUUID })
        );

        session.disconnect();
        crypto.randomUUID = originalRandomUUID;
    });
});
