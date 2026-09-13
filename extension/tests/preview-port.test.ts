// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
// Static import is safe here: EligibilityWatcher keeps all its state in the
// instance (options bag), so module-level state cannot leak between tests.
import { EligibilityWatcher } from '../src/content/eligibility-watcher';
import type { ContentPreview } from '../src/preview/content-preview';

// ── Mock Port (same shape the protocol suites use) ────────────────────────────

interface MockPort {
    name: string;
    postMessage: ReturnType<typeof vi.fn>;
    onMessage: { addListener: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> };
    onDisconnect: { addListener: ReturnType<typeof vi.fn> };
    // Test helpers
    _messageCallbacks: Array<(msg: unknown) => void>;
    _disconnectCallbacks: Array<() => void>;
    emitMessage(msg: unknown): void;
    emitDisconnect(): void;
}

function createMockPort(name = 'markdownizer-capture-preview'): MockPort {
    const port: MockPort = {
        name,
        postMessage: vi.fn(),
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        _messageCallbacks: [],
        _disconnectCallbacks: [],
        emitMessage(msg: unknown) {
            for (const cb of port._messageCallbacks) cb(msg);
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

function createPreviewStub(): ContentPreview {
    return {
        show: vi.fn(),
        remove: vi.fn(),
        setIncludeIframes: vi.fn(),
        setLoading: vi.fn(),
        setReady: vi.fn(),
    } as unknown as ContentPreview;
}

function createWatcherStub() {
    return {
        start: vi.fn(),
        stop: vi.fn(),
        reconcileFrameDocumentObservers: vi.fn(),
    } as unknown as EligibilityWatcher;
}

function setupDOM(html: string) {
    document.documentElement.innerHTML = html;
}

// ── Recording MutationObserver (records targets + disconnect calls) ────────────

class RecordingMutationObserver {
    static instances: RecordingMutationObserver[] = [];
    static constructorCalls = 0;

    observedTarget: Node | null = null;
    disconnectCalls = 0;

    private callback: MutationCallback;

    constructor(callback: MutationCallback) {
        RecordingMutationObserver.constructorCalls += 1;
        RecordingMutationObserver.instances.push(this);
        this.callback = callback;
    }

    observe(target: Node): void {
        this.observedTarget = target;
    }

    disconnect(): void {
        this.disconnectCalls += 1;
    }

    takeRecords(): MutationRecord[] {
        return [];
    }

    trigger(records: MutationRecord[]): void {
        this.callback(records, {} as MutationObserver);
    }
}

// Reads like the real `readSameOriginFrame`: only same-origin frames inside the
// root are tracked, so tests must define a readable contentDocument.
function defineFrameDocument(frame: HTMLIFrameElement, doc: Document): void {
    Object.defineProperty(frame, 'contentDocument', { configurable: true, get: () => doc });
}

describe('preview-port contract', () => {
    beforeEach(() => {
        setupDOM('<body><main><h1>Smart only</h1></main></body>');
        RecordingMutationObserver.instances = [];
        RecordingMutationObserver.constructorCalls = 0;
        vi.stubGlobal('MutationObserver', RecordingMutationObserver);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    // ── PreviewPortController ────────────────────────────────────────────────
    // The controller keeps module-level shared state (currentOwner), so each
    // test re-imports the module fresh, mirroring the protocol suites.
    describe('PreviewPortController', () => {
        beforeEach(() => {
            vi.resetModules();
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async function importController(): Promise<any> {
            return import('../src/content/preview-port');
        }

        it('routes preview:show to ContentPreview.show and replies success', async () => {
            const { PreviewPortController } = await importController();
            const port = createMockPort();
            const preview = createPreviewStub();
            const watcher = createWatcherStub();
            new PreviewPortController(port, 0, watcher, preview);

            port.emitMessage({ type: 'preview:show', sessionId: 's1', captureMode: 'smart' });

            expect(preview.show).toHaveBeenCalledWith(document.querySelector('main'));
            expect(port.postMessage).toHaveBeenCalledWith({ success: true });
        });

        it('routes preview:inspect to an eligibility post and watcher start', async () => {
            const { PreviewPortController } = await importController();
            const port = createMockPort();
            const preview = createPreviewStub();
            const watcher = createWatcherStub();
            new PreviewPortController(port, 0, watcher, preview);

            port.emitMessage({
                type: 'preview:inspect',
                sessionId: 'i1',
                captureMode: 'smart',
                generation: 3,
            });

            expect(port.postMessage).toHaveBeenCalledWith({
                type: 'preview:eligibility',
                sessionId: 'i1',
                captureMode: 'smart',
                generation: 3,
                hasEligibleIframes: false,
                hasImages: false,
            });
            // First inspection moves the cached root from null — the stop is a
            // no-op teardown on a fresh watcher, exactly like the legacy closure.
            expect(watcher.start).toHaveBeenCalledTimes(1);
            expect(watcher.stop).toHaveBeenCalledTimes(1);
        });

        it('routes preview:set-iframes to ContentPreview.setIncludeIframes', async () => {
            const { PreviewPortController } = await importController();
            const port = createMockPort();
            const preview = createPreviewStub();
            const watcher = createWatcherStub();
            new PreviewPortController(port, 0, watcher, preview);

            port.emitMessage({ type: 'preview:show', sessionId: 's1', captureMode: 'smart' });
            port.emitMessage({ type: 'preview:set-iframes', sessionId: 's1', enabled: true });

            expect(preview.setIncludeIframes).toHaveBeenCalledWith(true);
        });

        it('routes preview:loading, preview:ready and preview:hide', async () => {
            const { PreviewPortController } = await importController();
            const port = createMockPort();
            const preview = createPreviewStub();
            const watcher = createWatcherStub();
            new PreviewPortController(port, 0, watcher, preview);

            port.emitMessage({ type: 'preview:show', sessionId: 's1', captureMode: 'smart' });
            port.emitMessage({ type: 'preview:loading', sessionId: 's1' });
            expect(preview.setLoading).toHaveBeenCalledTimes(1);

            port.emitMessage({ type: 'preview:ready', sessionId: 's1' });
            expect(preview.setReady).toHaveBeenCalledTimes(1);

            port.emitMessage({ type: 'preview:hide', sessionId: 's1' });
            expect(preview.remove).toHaveBeenCalledTimes(1);
        });

        it('guards set-iframes and state commands to the current generation owner', async () => {
            const { PreviewPortController } = await importController();
            const olderPort = createMockPort();
            const olderPreview = createPreviewStub();
            const olderWatcher = createWatcherStub();
            new PreviewPortController(olderPort, 0, olderWatcher, olderPreview);
            olderPort.emitMessage({ type: 'preview:show', sessionId: 'older' });

            const newerPort = createMockPort();
            const newerPreview = createPreviewStub();
            const newerWatcher = createWatcherStub();
            new PreviewPortController(newerPort, 1, newerWatcher, newerPreview);
            newerPort.emitMessage({ type: 'preview:show', sessionId: 'newer' });

            // Stale (older generation) state commands are ignored
            olderPort.emitMessage({ type: 'preview:set-iframes', sessionId: 'older', enabled: true });
            olderPort.emitMessage({ type: 'preview:loading', sessionId: 'older' });
            olderPort.emitMessage({ type: 'preview:ready', sessionId: 'older' });
            olderPort.emitMessage({ type: 'preview:hide', sessionId: 'older' });
            expect(olderPreview.setIncludeIframes).not.toHaveBeenCalled();
            expect(olderPreview.setLoading).not.toHaveBeenCalled();
            expect(olderPreview.setReady).not.toHaveBeenCalled();
            expect(olderPreview.remove).not.toHaveBeenCalled();

            // Current generation still works
            newerPort.emitMessage({ type: 'preview:ready', sessionId: 'newer' });
            expect(newerPreview.setReady).toHaveBeenCalledTimes(1);
        });

        it('rejects stale generation inspections', async () => {
            const { PreviewPortController } = await importController();
            const port = createMockPort();
            const preview = createPreviewStub();
            const watcher = createWatcherStub();
            new PreviewPortController(port, 0, watcher, preview);

            port.emitMessage({ type: 'preview:inspect', sessionId: 'gen-10', captureMode: 'smart', generation: 10 });
            expect(watcher.start).toHaveBeenCalledTimes(1);
            expect(watcher.stop).toHaveBeenCalledTimes(1);
            port.postMessage.mockClear();

            // A stale inspection is ignored entirely: no eligibility post, no
            // watcher restart.
            port.emitMessage({ type: 'preview:inspect', sessionId: 'gen-5', captureMode: 'smart', generation: 5 });
            expect(port.postMessage).not.toHaveBeenCalled();
            expect(watcher.start).toHaveBeenCalledTimes(1);
            expect(watcher.stop).toHaveBeenCalledTimes(1);
        });

        it('restarts the watcher when the capture root changes between inspections', async () => {
            const { PreviewPortController } = await importController();
            const port = createMockPort();
            const preview = createPreviewStub();
            const watcher = createWatcherStub();
            new PreviewPortController(port, 0, watcher, preview);

            port.emitMessage({ type: 'preview:inspect', sessionId: 'r1', captureMode: 'smart', generation: 1 });
            expect(watcher.start).toHaveBeenCalledTimes(1);
            // First inspection moved the cached root from null (no-op teardown)
            expect(watcher.stop).toHaveBeenCalledTimes(1);

            // Same root again → no teardown
            port.emitMessage({ type: 'preview:inspect', sessionId: 'r2', captureMode: 'smart', generation: 2 });
            expect(watcher.start).toHaveBeenCalledTimes(2);
            expect(watcher.stop).toHaveBeenCalledTimes(1);

            // An article now wins the smart root → stop + restart
            const article = document.createElement('article');
            article.innerHTML = '<p>New preferred root</p>';
            document.body.prepend(article);
            port.emitMessage({ type: 'preview:inspect', sessionId: 'r3', captureMode: 'smart', generation: 3 });
            expect(watcher.stop).toHaveBeenCalledTimes(2);
            expect(watcher.start).toHaveBeenCalledTimes(3);
        });

        it('tears down the watcher and preview on disconnect when owning the preview', async () => {
            const { PreviewPortController } = await importController();
            const port = createMockPort();
            const preview = createPreviewStub();
            const watcher = createWatcherStub();
            new PreviewPortController(port, 0, watcher, preview);

            port.emitMessage({ type: 'preview:show', sessionId: 's1', captureMode: 'smart' });
            port.emitMessage({ type: 'preview:inspect', sessionId: 's1', captureMode: 'smart', generation: 1 });

            port.emitDisconnect();
            // One stop from the inspect root change, one from the disconnect
            expect(watcher.stop).toHaveBeenCalledTimes(2);
            expect(preview.remove).toHaveBeenCalledTimes(1);

            // Post-disconnect messages never reach the controller: the message
            // listener is removed by handleDisconnect.
            port.emitMessage({ type: 'preview:loading', sessionId: 's1' });
            port.emitMessage({ type: 'preview:show', sessionId: 's2' });
            expect(preview.setLoading).not.toHaveBeenCalled();
            expect(preview.show).toHaveBeenCalledTimes(1);
        });

        it('does not remove the preview when a stale generation disconnects', async () => {
            const { PreviewPortController } = await importController();
            const olderPort = createMockPort();
            const olderPreview = createPreviewStub();
            const olderWatcher = createWatcherStub();
            new PreviewPortController(olderPort, 0, olderWatcher, olderPreview);
            olderPort.emitMessage({ type: 'preview:show', sessionId: 'older' });

            const newerPort = createMockPort();
            const newerPreview = createPreviewStub();
            const newerWatcher = createWatcherStub();
            new PreviewPortController(newerPort, 1, newerWatcher, newerPreview);
            newerPort.emitMessage({ type: 'preview:show', sessionId: 'newer' });

            // Stale disconnect still tears down its own watcher, but must not
            // remove the preview owned by the newer generation.
            olderPort.emitDisconnect();
            expect(olderWatcher.stop).toHaveBeenCalledTimes(1);
            expect(olderPreview.remove).not.toHaveBeenCalled();

            newerPort.emitMessage({ type: 'preview:hide', sessionId: 'newer' });
            expect(newerPreview.remove).toHaveBeenCalledTimes(1);
        });
    });

    // ── EligibilityWatcher ───────────────────────────────────────────────────

    describe('EligibilityWatcher', () => {
        function createWatcher(root: HTMLElement) {
            const postEligibility = vi.fn();
            const watcher = new EligibilityWatcher({
                getRoot: () => root,
                postEligibility,
                isCaptureRelevantMutation: () => true,
                isPreviewHostMutation: () => false,
            });
            return { watcher, postEligibility };
        }

        it('start() is idempotent: one root observer and one load listener', () => {
            const root = document.querySelector('main')!;
            const addSpy = vi.spyOn(document, 'addEventListener');
            const { watcher } = createWatcher(root);

            watcher.start();
            watcher.start();

            expect(RecordingMutationObserver.constructorCalls).toBe(1);
            const loadAdds = addSpy.mock.calls.filter(([type]) => type === 'load');
            expect(loadAdds).toHaveLength(1);
        });

        it('stop() is idempotent and prevents further eligibility refreshes', async () => {
            const root = document.querySelector('main')!;
            const { watcher, postEligibility } = createWatcher(root);
            watcher.start();

            const rootObserver = RecordingMutationObserver.instances.find(
                (instance) => instance.observedTarget === root,
            );
            expect(rootObserver).toBeDefined();

            // A relevant mutation refreshes eligibility (rAF/setTimeout path)
            rootObserver!.trigger([{ type: 'childList', target: root } as MutationRecord]);
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(postEligibility).toHaveBeenCalledTimes(1);

            watcher.stop();
            watcher.stop(); // must not throw
            postEligibility.mockClear();

            rootObserver!.trigger([{ type: 'childList', target: root } as MutationRecord]);
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(postEligibility).not.toHaveBeenCalled();
            expect(rootObserver!.disconnectCalls).toBe(1);

            // restart works after stop
            watcher.start();
            expect(RecordingMutationObserver.constructorCalls).toBe(2);
        });

        it('reconcileFrameDocumentObservers attaches and detaches by diff', () => {
            const root = document.querySelector('main')!;
            const { watcher } = createWatcher(root);

            const frameA = document.createElement('iframe');
            const docA = new JSDOM('<p>A</p>').window.document;
            defineFrameDocument(frameA, docA);
            root.appendChild(frameA);

            // start() reconciles once: docA gets a live observer
            watcher.start();
            const docAObserver = RecordingMutationObserver.instances.find(
                (instance) => instance.observedTarget === docA,
            );
            expect(docAObserver).toBeDefined();
            watcher.start(); // still idempotent: no duplicate frame observer
            expect(
                RecordingMutationObserver.instances.filter((instance) => instance.observedTarget === docA),
            ).toHaveLength(1);

            // A frame added after start gets an observer on the next reconcile
            const frameB = document.createElement('iframe');
            const docB = new JSDOM('<p>B</p>').window.document;
            defineFrameDocument(frameB, docB);
            root.appendChild(frameB);
            expect(
                RecordingMutationObserver.instances.some((instance) => instance.observedTarget === docB),
            ).toBe(false);

            watcher.reconcileFrameDocumentObservers();
            expect(
                RecordingMutationObserver.instances.some((instance) => instance.observedTarget === docB),
            ).toBe(true);

            // Navigating a frame replaces its document → old observer detached,
            // the new document observed
            const docA2 = new JSDOM('<p>A2</p>').window.document;
            defineFrameDocument(frameA, docA2);
            watcher.reconcileFrameDocumentObservers();
            expect(docAObserver!.disconnectCalls).toBe(1);
            expect(
                RecordingMutationObserver.instances.some((instance) => instance.observedTarget === docA2),
            ).toBe(true);

            // A frame leaving the root detaches its observer on the next reconcile
            const docA2Observer = RecordingMutationObserver.instances.find(
                (instance) => instance.observedTarget === docA2,
            )!;
            root.removeChild(frameA);
            watcher.reconcileFrameDocumentObservers();
            expect(docA2Observer.disconnectCalls).toBe(1);
        });
    });
});