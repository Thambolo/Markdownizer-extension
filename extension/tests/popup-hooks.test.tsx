// @vitest-environment jsdom
// Contract tests for the popup hooks extracted in Task 3. Renders each hook
// inside a small preact harness (mirroring popup-preview.test.tsx's chrome
// mock) and locks the behaviors the task brief lists.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { PREVIEW_PORT_NAME, type CaptureMode, type PreviewEligibilityMessage } from '../src/shared/preview-protocol';
import type { PreviewSession } from '../src/popup/preview-session';
import { initialIframeOptionState, type IframeOptionState } from '../src/popup/iframe-option';

// CRXJS asset imports: mocked like popup-preview.test.tsx so the loader never
// executes the content script in the test environment.
vi.mock('../src/content/index.ts?script', () => ({ default: '/content.js' }));
vi.mock('../src/preview/content-preview.css?url', () => ({ default: '/content.css' }));

// ── Chrome API mocks (mirror popup-preview.test.tsx) ─────────────────────────

interface MockPort {
    name: string;
    postMessage: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    onMessage: { addListener: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> };
    onDisconnect: { addListener: ReturnType<typeof vi.fn> };
    _messageCallbacks: Array<(msg: unknown) => void>;
    _disconnectCallbacks: Array<() => void>;
    emitMessage(msg: unknown): void;
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

// Preact instances are captured per-describe AFTER vi.resetModules() so the
// harness components and the dynamically imported hook modules share one
// preact runtime (mirrors popup-preview.test.tsx).
let render: typeof import('preact').render;
let act: typeof import('preact/test-utils').act;
let useState: typeof import('preact/hooks').useState;
let useRef: typeof import('preact/hooks').useRef;

async function setupPreact() {
    vi.resetModules();
    const preact = await import('preact');
    const testUtils = await import('preact/test-utils');
    const hooks = await import('preact/hooks');
    render = preact.render;
    act = testUtils.act;
    useState = hooks.useState;
    useRef = hooks.useRef;
}

function freshBody() {
    if (!document.body) document.body = document.createElement('body');
    document.body.innerHTML = '<div id="root"></div>';
    return document.getElementById('root') as HTMLDivElement;
}

// ── usePersistedToggle ───────────────────────────────────────────────────────

describe('usePersistedToggle', () => {
    let chrome: ReturnType<typeof createChromeMock>;
    let usePersistedToggle: typeof import('../src/popup/hooks/use-persisted-toggle').usePersistedToggle;
    let container: HTMLDivElement;

    beforeEach(async () => {
        chrome = createChromeMock();
        vi.stubGlobal('chrome', chrome);
        container = freshBody();
        await setupPreact();
        const mod = await import('../src/popup/hooks/use-persisted-toggle');
        usePersistedToggle = mod.usePersistedToggle;
    });

    afterEach(() => {
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    function mount(defaultValue = false) {
        const holder: { value: boolean; toggle: (next: boolean) => void } = { value: defaultValue, toggle: () => {} };
        function Harness() {
            [holder.value, holder.toggle] = usePersistedToggle('testToggle', defaultValue);
            return null;
        }
        render(<Harness />, container);
        return holder;
    }

    it('renders the persisted value from storage', async () => {
        chrome.storage.local.get.mockImplementation(async (keys: string | string[]) => {
            const keyList = Array.isArray(keys) ? keys : [keys];
            if (keyList.includes('testToggle')) return { testToggle: true };
            return {};
        });

        const holder = mount(false);
        await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

        expect(holder.value).toBe(true);
    });

    it('falls back to the default when storage has no value', async () => {
        chrome.storage.local.get.mockResolvedValue({});

        const holder = mount(true);
        await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

        expect(holder.value).toBe(true);
    });

    it('toggling writes storage and updates state', async () => {
        chrome.storage.local.get.mockResolvedValue({});

        const holder = mount(false);
        await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
        await act(async () => { holder.toggle(true); });

        expect(chrome.storage.local.set).toHaveBeenCalledWith({ testToggle: true });
        expect(holder.value).toBe(true);
    });

    it('is safe to unmount while the storage read is pending', async () => {
        let resolveRead: (value: unknown) => void = () => {};
        chrome.storage.local.get.mockReturnValue(new Promise((resolve) => { resolveRead = resolve; }));

        const holder = mount(false);
        await act(async () => { render(null, container); });

        expect(() => { resolveRead({ testToggle: true }); }).not.toThrow();
        await act(async () => { await new Promise((r) => setTimeout(r, 10)); });

        // The cancelled restore must not update state after unmount
        expect(holder.value).toBe(false);
        expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });
});

// ── useCaptureMode ───────────────────────────────────────────────────────────

describe('useCaptureMode', () => {
    let useCaptureMode: typeof import('../src/popup/hooks/use-capture-mode').useCaptureMode;
    let container: HTMLDivElement;
    let api: ReturnType<typeof useCaptureMode>;

    beforeEach(async () => {
        container = freshBody();
        await setupPreact();
        const mod = await import('../src/popup/hooks/use-capture-mode');
        useCaptureMode = mod.useCaptureMode;
    });

    afterEach(() => {
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    function mount() {
        function Harness() {
            api = useCaptureMode('smart');
            return <span>{api[0]}</span>;
        }
        render(<Harness />, container);
    }

    it('defaults to the given mode', async () => {
        await act(async () => { mount(); });

        expect(api[0]).toBe('smart');
        expect(api[2].current).toBe('smart');
    });

    it('setter updates the state and the ref synchronously', async () => {
        await act(async () => { mount(); });
        expect(container.textContent).toBe('smart');

        // Deliberately outside act: the ref must flip synchronously
        api[1]('full-page');
        expect(api[2].current).toBe('full-page');

        await act(async () => {});
        expect(container.textContent).toBe('full-page');
    });
});

// ── useZipBuild ──────────────────────────────────────────────────────────────

describe('useZipBuild', () => {
    let chrome: ReturnType<typeof createChromeMock>;
    let useZipBuild: typeof import('../src/popup/hooks/use-zip-build').useZipBuild;
    let container: HTMLDivElement;
    let api: ReturnType<typeof useZipBuild>;

    beforeEach(async () => {
        chrome = createChromeMock();
        vi.stubGlobal('chrome', chrome);
        container = freshBody();
        await setupPreact();
        const mod = await import('../src/popup/hooks/use-zip-build');
        useZipBuild = mod.useZipBuild;
    });

    afterEach(() => {
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    function mount() {
        function Harness() {
            api = useZipBuild();
            return <div>{api.zipBuild ? 'strip' : 'no-strip'}</div>;
        }
        render(<Harness />, container);
    }

    function emitMessage(msg: unknown) {
        const listener = chrome.runtime.onMessage.addListener.mock.calls[0][0] as (m: unknown) => void;
        listener(msg);
    }

    async function startBuild(markdown = '# md', title = 'page', sourceUrl?: string) {
        await act(async () => { api.downloadWithImages(markdown, title, sourceUrl); });
    }

    it('relays zip:progress/done/error only for its own buildId', async () => {
        await act(async () => { mount(); });
        await startBuild();

        const buildId = (chrome.runtime.sendMessage.mock.calls[0][0] as { buildId: string }).buildId;
        expect(api.zipBuild).toEqual({ buildId, phase: 'fetch', fetched: 0, total: 0 });
        expect(api.isBundling).toBe(true);

        // Stale progress is ignored
        await act(async () => {
            emitMessage({ type: 'zip:progress', buildId: 'other', phase: 'fetch', fetched: 9, total: 9 });
        });
        expect(api.zipBuild?.fetched).toBe(0);

        // Own progress is applied
        await act(async () => {
            emitMessage({ type: 'zip:progress', buildId, phase: 'fetch', fetched: 2, total: 3 });
        });
        expect(api.zipBuild?.fetched).toBe(2);
        expect(api.zipBuild?.total).toBe(3);

        // Stale done is ignored (strip stays up)
        await act(async () => {
            emitMessage({ type: 'zip:done', buildId: 'other', downloaded: 'zip', filename: 'x.zip', totalImages: 1, bundledImages: 1, skippedImages: 0 });
        });
        expect(api.zipBuild).not.toBeNull();

        // Own done: strip clears, flash on, note computed
        await act(async () => {
            emitMessage({ type: 'zip:done', buildId, downloaded: 'zip', filename: 'x.zip', totalImages: 3, bundledImages: 2, skippedImages: 1 });
        });
        expect(api.zipBuild).toBeNull();
        expect(api.isBundling).toBe(false);
        expect(api.downloaded).toBe(true);
        expect(api.imagesNote).toBe('Included 2 of 3 images');

        // The "Downloaded!" flash clears after 2s
        await act(async () => { await new Promise((r) => setTimeout(r, 2100)); });
        expect(api.downloaded).toBe(false);
    });

    it('computes the images note for the zip:done branches', async () => {
        await act(async () => { mount(); });

        // md-only fallback with images present
        await startBuild();
        const mdBuildId = (chrome.runtime.sendMessage.mock.calls[0][0] as { buildId: string }).buildId;
        await act(async () => {
            emitMessage({ type: 'zip:done', buildId: mdBuildId, downloaded: 'md', filename: 'x.zip', totalImages: 2, bundledImages: 0, skippedImages: 2 });
        });
        expect(api.imagesNote).toBe('Images unavailable - downloaded .md only');

        // bundled with skips
        await startBuild();
        const skippedBuildId = (chrome.runtime.sendMessage.mock.calls[1][0] as { buildId: string }).buildId;
        await act(async () => {
            emitMessage({ type: 'zip:done', buildId: skippedBuildId, downloaded: 'zip', filename: 'x.zip', totalImages: 5, bundledImages: 3, skippedImages: 2 });
        });
        expect(api.imagesNote).toBe('Included 3 of 5 images');

        // bundled without skips
        await startBuild();
        const cleanBuildId = (chrome.runtime.sendMessage.mock.calls[2][0] as { buildId: string }).buildId;
        await act(async () => {
            emitMessage({ type: 'zip:done', buildId: cleanBuildId, downloaded: 'zip', filename: 'x.zip', totalImages: 3, bundledImages: 3, skippedImages: 0 });
        });
        expect(api.imagesNote).toBe('Included 3 images');
    });

    it('shows zip:error as the note and clears the strip', async () => {
        await act(async () => { mount(); });
        await startBuild();
        const buildId = (chrome.runtime.sendMessage.mock.calls[0][0] as { buildId: string }).buildId;

        await act(async () => {
            emitMessage({ type: 'zip:error', buildId, error: 'Could not build the download.' });
        });

        expect(api.zipBuild).toBeNull();
        expect(api.imagesNote).toBe('Could not build the download.');
    });

    it('sends build_zip with the payload and recovers when the send fails', async () => {
        await act(async () => { mount(); });
        await startBuild('# md', 'page', 'https://example.com');

        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
            action: 'build_zip',
            buildId: expect.any(String),
            payload: { markdown: '# md', title: 'page', sourceUrl: 'https://example.com' },
        });

        // Dead response channel: strip clears so the UI cannot wedge
        chrome.runtime.sendMessage.mockRejectedValueOnce(new Error('port closed'));
        await startBuild('# md', 'page');
        expect(api.zipBuild).toBeNull();
        expect(api.isBundling).toBe(false);
    });

    it('restores an in-flight build from storage.session and refreshes via zip:status', async () => {
        chrome._sessionData.activeZipBuild = { buildId: 'b-reopen', phase: 'fetch', fetched: 4, total: 10, startedAt: 1 };
        chrome.runtime.sendMessage.mockResolvedValue({ active: true, buildId: 'b-reopen', phase: 'fetch', fetched: 5, total: 10 });

        await act(async () => { mount(); });
        await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'zip:status', buildId: 'b-reopen' }),
        );
        expect(api.zipBuild).toEqual({ buildId: 'b-reopen', phase: 'fetch', fetched: 5, total: 10 });
    });

    it('clears the strip when zip:status reports the build is gone', async () => {
        chrome._sessionData.activeZipBuild = { buildId: 'b-dead', phase: 'fetch', fetched: 1, total: 2, startedAt: 1 };
        chrome.runtime.sendMessage.mockResolvedValue({ active: false });

        await act(async () => { mount(); });
        await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

        expect(api.zipBuild).toBeNull();
    });

    it('removes the broadcast listener and nulls the last build id on unmount', async () => {
        await act(async () => { mount(); });
        await startBuild();
        const handler = chrome.runtime.onMessage.addListener.mock.calls[0][0];

        // zip:done leaves the last build id in place (delayed zip:error still
        // matches) — verified above. Unmount removes the listener entirely.
        await act(async () => { render(null, container); });

        expect(chrome.runtime.onMessage.removeListener).toHaveBeenCalledWith(handler);
    });
});

// ── usePreviewSession ────────────────────────────────────────────────────────

describe('usePreviewSession', () => {
    let chrome: ReturnType<typeof createChromeMock>;
    let usePreviewSession: typeof import('../src/popup/hooks/use-preview-session').usePreviewSession;
    let container: HTMLDivElement;
    let api: ReturnType<typeof usePreviewSession>;
    let modeRef: { current: CaptureMode };
    let previewEnabled: boolean;
    const onIframeOptionChange = vi.fn();
    const onImagesEligibleChange = vi.fn();

    beforeEach(async () => {
        chrome = createChromeMock();
        vi.stubGlobal('chrome', chrome);
        onIframeOptionChange.mockClear();
        onImagesEligibleChange.mockClear();
        container = freshBody();
        await setupPreact();
        const mod = await import('../src/popup/hooks/use-preview-session');
        usePreviewSession = mod.usePreviewSession;
    });

    afterEach(() => {
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    function mount() {
        function Harness() {
            const mode = useRef<CaptureMode>('smart');
            const [enabled, setEnabled] = useState(true);
            modeRef = mode;
            previewEnabled = enabled;
            api = usePreviewSession({
                captureModeRef: mode,
                previewEnabled: enabled,
                setPreviewEnabled: setEnabled,
                onIframeOptionChange,
                onImagesEligibleChange,
            });
            return (
                <div>
                    <input type="checkbox" id="pv" onChange={api.togglePreview} />
                    <input type="checkbox" id="fp" onChange={api.toggleCaptureFullPage} />
                    <input type="checkbox" id="ifr" onChange={api.toggleIncludeIframes} />
                </div>
            );
        }
        render(<Harness />, container);
    }

    async function flush() {
        await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    }

    function setChecked(id: string, checked: boolean) {
        const input = document.getElementById(id) as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')!.set!;
        setter.call(input, checked);
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const inspectsOf = () => (lastPort?.postMessage.mock.calls ?? [])
        .map((call: unknown[]) => call[0] as { type?: string; sessionId?: string; generation?: number; includeIframes?: boolean })
        .filter((m) => m.type === 'preview:inspect');

    function emitEligibility(message: Partial<PreviewEligibilityMessage> & { sessionId: string; generation: number }) {
        lastPort!.emitMessage({
            type: 'preview:eligibility',
            captureMode: 'smart',
            hasEligibleIframes: false,
            hasImages: false,
            ...message,
        });
    }

    it('mounts, opens a session, shows when enabled, and inspects', async () => {
        chrome.storage.local.get.mockResolvedValue({});
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        await act(async () => { mount(); });
        await flush();

        expect(chrome.tabs.connect).toHaveBeenCalledWith(1, { name: PREVIEW_PORT_NAME });
        expect(api.sessionRef.current).not.toBeNull();
        const port = lastPort!;
        const messages = port.postMessage.mock.calls.map((call: unknown[]) => call[0] as { type?: string; includeIframes?: boolean });
        const showIdx = messages.findIndex((m) => m.type === 'preview:show');
        const inspectIdx = messages.findIndex((m) => m.type === 'preview:inspect');
        expect(showIdx).toBeGreaterThanOrEqual(0);
        expect(showIdx).toBeLessThan(inspectIdx);
        expect(messages.find((m) => m.type === 'preview:inspect')).toHaveProperty('includeIframes', false);
    });

    it('keeps the session for eligibility but does not show when preview is disabled', async () => {
        chrome.storage.local.get.mockImplementation(async (keys: string | string[]) => {
            const keyList = Array.isArray(keys) ? keys : [keys];
            if (keyList.includes('capturePreviewEnabled')) return { capturePreviewEnabled: false };
            return {};
        });
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        await act(async () => { mount(); });
        await flush();

        expect(previewEnabled).toBe(false);
        expect(chrome.tabs.connect).toHaveBeenCalled();
        const types = lastPort!.postMessage.mock.calls.map((call: unknown[]) => (call[0] as { type?: string }).type);
        expect(types).not.toContain('preview:show');
        expect(types).toContain('preview:inspect');
    });

    it('applies the iframe preference and terminates re-inspection after one flip', async () => {
        chrome.storage.local.get.mockResolvedValue({});
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        await act(async () => { mount(); });
        await flush();
        const port = lastPort!;
        const initial = inspectsOf()[0];

        // First eligibility flips include-iframes off -> on (auto-inclusion)
        await act(async () => {
            emitEligibility({
                sessionId: initial.sessionId,
                generation: initial.generation,
                hasEligibleIframes: true,
                hasImages: true,
            });
        });

        expect(onIframeOptionChange).toHaveBeenCalledWith({ eligible: true, preference: 'auto' });
        expect(api.iframeOption).toEqual({ eligible: true, preference: 'auto' });
        expect(api.imagesEligible).toBe(true);
        expect(onImagesEligibleChange).toHaveBeenCalledWith(true);

        // The session learned the new include-iframes state...
        expect(port.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'preview:set-iframes', enabled: true }),
        );
        // ...and exactly one re-inspection was issued carrying includeIframes
        const inspects = inspectsOf();
        expect(inspects.length).toBe(2);
        expect(inspects[1]).toHaveProperty('includeIframes', true);

        // Second eligibility (same outcome): prev === now → no re-inspection
        await act(async () => {
            emitEligibility({
                sessionId: inspects[1].sessionId,
                generation: inspects[1].generation,
                hasEligibleIframes: true,
                hasImages: true,
            });
        });
        expect(inspectsOf().length).toBe(2);
    });

    it('togglePreview persists and shows/hides the session', async () => {
        chrome.storage.local.get.mockResolvedValue({});
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        await act(async () => { mount(); });
        await flush();
        const port = lastPort!;
        port.postMessage.mockClear();

        // Off: hide + persist
        await act(async () => { setChecked('pv', false); });
        expect(chrome.storage.local.set).toHaveBeenCalledWith(
            expect.objectContaining({ capturePreviewEnabled: false }),
        );
        expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'preview:hide' }));
        expect(previewEnabled).toBe(false);

        // On: show + inspect with the current capture mode
        await act(async () => { setChecked('pv', true); });
        expect(chrome.storage.local.set).toHaveBeenCalledWith(
            expect.objectContaining({ capturePreviewEnabled: true }),
        );
        expect(port.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'preview:show', captureMode: 'smart' }),
        );
        expect(previewEnabled).toBe(true);
    });

    it('toggleCaptureFullPage updates the ref and the session', async () => {
        chrome.storage.local.get.mockResolvedValue({});
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        await act(async () => { mount(); });
        await flush();
        const port = lastPort!;
        port.postMessage.mockClear();

        await act(async () => { setChecked('fp', true); });

        expect(modeRef.current).toBe('full-page');
        expect(port.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'preview:show', captureMode: 'full-page' }),
        );
        expect(inspectsOf().length).toBe(1);
    });

    it('toggleIncludeIframes updates the session and reports the preference', async () => {
        chrome.storage.local.get.mockResolvedValue({});
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        await act(async () => { mount(); });
        await flush();
        const port = lastPort!;

        // Make iframes eligible first so inclusion actually applies
        const initial = inspectsOf()[0];
        await act(async () => {
            emitEligibility({
                sessionId: initial.sessionId,
                generation: initial.generation,
                hasEligibleIframes: true,
                hasImages: false,
            });
        });
        port.postMessage.mockClear();
        onIframeOptionChange.mockClear();

        await act(async () => { setChecked('ifr', true); });

        expect(port.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'preview:set-iframes', enabled: true }),
        );
        expect(onIframeOptionChange).toHaveBeenCalledWith({ eligible: true, preference: 'include' });
    });

    it('disconnects the session on unmount', async () => {
        chrome.storage.local.get.mockResolvedValue({});
        chrome.tabs.sendMessage.mockResolvedValue({ success: true });

        await act(async () => { mount(); });
        await flush();
        const port = lastPort!;

        await act(async () => { render(null, container); });

        expect(port.disconnect).toHaveBeenCalled();
    });
});

// ── useConversion ────────────────────────────────────────────────────────────

describe('useConversion', () => {
    let chrome: ReturnType<typeof createChromeMock>;
    let useConversion: typeof import('../src/popup/hooks/use-conversion').useConversion;
    let container: HTMLDivElement;
    let api: ReturnType<typeof useConversion>;

    // Options rebuilt per test
    let previewEnabledRef: { current: boolean };
    let sessionRef: { current: PreviewSession | null };
    let captureModeRef: { current: CaptureMode };
    let iframeOptionRef: { current: IframeOptionState };
    let includeImagesRef: { current: boolean };
    let imagesEligibleRef: { current: boolean };
    let autoDownload: boolean;
    let tabUrlRef: { current: string | null };
    const downloadWithImages = vi.fn();
    const setDownloaded = vi.fn();
    const setImagesNote = vi.fn();
    const sessionSpy = { setReady: vi.fn(), setLoading: vi.fn() };
    const session = sessionSpy as unknown as PreviewSession;

    beforeEach(async () => {
        chrome = createChromeMock();
        vi.stubGlobal('chrome', chrome);
        vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) } });
        downloadWithImages.mockClear();
        setDownloaded.mockClear();
        setImagesNote.mockClear();
        sessionSpy.setReady.mockClear();
        sessionSpy.setLoading.mockClear();
        previewEnabledRef = { current: true };
        sessionRef = { current: session };
        captureModeRef = { current: 'smart' };
        iframeOptionRef = { current: initialIframeOptionState() };
        includeImagesRef = { current: false };
        imagesEligibleRef = { current: false };
        autoDownload = false;
        tabUrlRef = { current: null };
        container = freshBody();
        await setupPreact();
        const mod = await import('../src/popup/hooks/use-conversion');
        useConversion = mod.useConversion;
    });

    afterEach(() => {
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    function mount() {
        function Harness() {
            api = useConversion({
                previewEnabledRef,
                sessionRef,
                captureModeRef,
                iframeOptionRef,
                includeImagesRef,
                imagesEligibleRef,
                autoDownload,
                downloadWithImages,
                setDownloaded,
                setImagesNote,
                tabUrlRef,
            });
            return <span>{api.status}</span>;
        }
        render(<Harness />, container);
    }

    async function convert() {
        await act(async () => { await api.handleConvert(); });
        await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    }

    it('success with images active triggers the zip download and sets state', async () => {
        chrome.storage.local.get.mockResolvedValue({});
        chrome.tabs.sendMessage.mockResolvedValue({ success: true, markdown: '# Hello' });
        includeImagesRef.current = true;
        imagesEligibleRef.current = true;

        await act(async () => { mount(); });
        await convert();

        expect(api.status).toBe('success');
        expect(api.markdown).toBe('# Hello');
        expect(api.filename).toBe('example');
        expect(downloadWithImages).toHaveBeenCalledWith('# Hello', 'example', 'https://example.com');
        expect(setDownloaded).not.toHaveBeenCalled();
        expect(tabUrlRef.current).toBe('https://example.com');
        expect(sessionSpy.setReady).toHaveBeenCalled();
        expect(sessionSpy.setLoading).toHaveBeenCalled();
    });

    it('success with the images preference dormant falls back to the auto-download md path', async () => {
        chrome.storage.local.get.mockResolvedValue({});
        chrome.tabs.sendMessage.mockResolvedValue({ success: true, markdown: '# Hello' });
        includeImagesRef.current = true; // persisted preference, but page has no images
        imagesEligibleRef.current = false;
        autoDownload = true;
        const createObjectURL = vi.fn(() => 'blob:mock');
        const revokeObjectURL = vi.fn();
        vi.stubGlobal('URL', new Proxy(URL, {
            get: (target, prop, receiver) => {
                if (prop === 'createObjectURL') return createObjectURL;
                if (prop === 'revokeObjectURL') return revokeObjectURL;
                return Reflect.get(target, prop, receiver);
            },
        }));
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

        await act(async () => { mount(); });
        await convert();

        expect(api.status).toBe('success');
        expect(downloadWithImages).not.toHaveBeenCalled();
        expect(createObjectURL).toHaveBeenCalled();
        expect(setDownloaded).toHaveBeenCalledWith(true);
    });

    it('downloads nothing when neither images nor auto-download apply', async () => {
        chrome.storage.local.get.mockResolvedValue({});
        chrome.tabs.sendMessage.mockResolvedValue({ success: true, markdown: '# Hello' });

        await act(async () => { mount(); });
        await convert();

        expect(downloadWithImages).not.toHaveBeenCalled();
        expect(setDownloaded).not.toHaveBeenCalled();
    });

    it('restores the ready preview and reports the error on conversion failure', async () => {
        chrome.storage.local.get.mockResolvedValue({});
        chrome.tabs.sendMessage.mockRejectedValue(new Error('Conversion failed'));

        await act(async () => { mount(); });
        await act(async () => { await api.handleConvert(); });
        await act(async () => { await new Promise((r) => setTimeout(r, 1300)); });

        expect(api.status).toBe('error');
        expect(api.error).toBe('Conversion failed');
        expect(sessionSpy.setReady).toHaveBeenCalled();
        expect(downloadWithImages).not.toHaveBeenCalled();
    });

    it('recovers after content-script injection via sendWithInjectionRetry', async () => {
        chrome.storage.local.get.mockResolvedValue({});
        chrome.tabs.sendMessage
            .mockRejectedValueOnce(new Error('Receiving end does not exist'))
            .mockResolvedValue({ success: true, markdown: '# Recovered' });

        await act(async () => { mount(); });
        await act(async () => { await api.handleConvert(); });
        await act(async () => { await new Promise((r) => setTimeout(r, 300)); });

        expect(api.status).toBe('success');
        expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
        expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
    });

    it('rejects unsupported page URLs with a helpful error', async () => {
        chrome.storage.local.get.mockResolvedValue({});
        chrome.tabs.query.mockResolvedValue([{ id: 1, url: 'chrome://settings', title: 'Settings' }]);

        await act(async () => { mount(); });
        await convert();

        expect(api.status).toBe('error');
        expect(api.error).toContain('Open a normal webpage first');
        expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    });

    it('handleCopy writes the markdown to the clipboard and flashes copied', async () => {
        chrome.storage.local.get.mockResolvedValue({});
        chrome.tabs.sendMessage.mockResolvedValue({ success: true, markdown: '# Hello' });

        await act(async () => { mount(); });
        await convert();

        await act(async () => { api.handleCopy(); });
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith('# Hello');
        expect(api.copied).toBe(true);

        await act(async () => { await new Promise((r) => setTimeout(r, 2100)); });
        expect(api.copied).toBe(false);
    });
});
