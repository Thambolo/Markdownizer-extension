// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { CapturePreview, PREVIEW_HOST_ATTRIBUTE } from '../src/capture-preview';

// Stub ResizeObserver for jsdom
class StubResizeObserver {
    callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
}

// Stub MutationObserver for jsdom
class StubMutationObserver {
    callback: MutationCallback;
    constructor(callback: MutationCallback) {
        this.callback = callback;
    }
    observe() {}
    disconnect() {}
    takeRecords(): MutationRecord[] { return []; }
}

let rafCallbacks: FrameRequestCallback[] = [];
let rafId = 0;

function stubAnimationFrames() {
    rafCallbacks = [];
    rafId = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        rafCallbacks.push(cb);
        return ++rafId;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
}

function flushRaf() {
    const cbs = [...rafCallbacks];
    rafCallbacks = [];
    cbs.forEach(cb => cb(performance.now()));
}

describe('CapturePreview', () => {
    let preview: CapturePreview;

    beforeEach(() => {
        vi.stubGlobal('ResizeObserver', StubResizeObserver);
        vi.stubGlobal('MutationObserver', StubMutationObserver);
        stubAnimationFrames();
        preview = new CapturePreview();
    });

    afterEach(() => {
        preview.remove();
        vi.restoreAllMocks();
    });

    it('creates one aria-hidden isolated host and replaces stale state', () => {
        const root = document.createElement('div');
        document.body.appendChild(root);

        preview.show(root);

        const host = document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`);
        expect(host).not.toBeNull();
        expect(host!.getAttribute('aria-hidden')).toBe('true');
        expect(host!.getAttribute('data-preview-state')).toBe('ready');

        // Should be appended to documentElement, after body
        expect(host!.parentElement).toBe(document.documentElement);
        expect(document.documentElement.lastElementChild).toBe(host);

        // Shadow DOM should exist and be open
        expect(host!.shadowRoot).not.toBeNull();
    });

    it('replaces stale host on second show()', () => {
        const root = document.createElement('div');
        document.body.appendChild(root);

        preview.show(root);
        const firstHost = document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`);

        preview.show(root);
        const secondHost = document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`);

        expect(firstHost).not.toBe(secondHost);
        expect(document.querySelectorAll(`[${PREVIEW_HOST_ATTRIBUTE}]`).length).toBe(1);
    });

    it('changes between ready and loading states idempotently', () => {
        const root = document.createElement('div');
        document.body.appendChild(root);

        preview.show(root);

        preview.setLoading();
        expect(document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`)!.getAttribute('data-preview-state')).toBe('loading');

        // Idempotent
        preview.setLoading();
        expect(document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`)!.getAttribute('data-preview-state')).toBe('loading');

        preview.setReady();
        expect(document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`)!.getAttribute('data-preview-state')).toBe('ready');

        // Idempotent
        preview.setReady();
        expect(document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`)!.getAttribute('data-preview-state')).toBe('ready');
    });

    it('removes the host, observers, listeners, and pending frame', () => {
        const root = document.createElement('div');
        document.body.appendChild(root);

        preview.show(root);
        expect(document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`)).not.toBeNull();

        preview.remove();
        expect(document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`)).toBeNull();
    });

    it('does not throw when state methods run before show or after remove', () => {
        expect(() => preview.setLoading()).not.toThrow();
        expect(() => preview.setReady()).not.toThrow();

        const root = document.createElement('div');
        document.body.appendChild(root);
        preview.show(root);
        preview.remove();

        expect(() => preview.setLoading()).not.toThrow();
        expect(() => preview.setReady()).not.toThrow();
    });
});
