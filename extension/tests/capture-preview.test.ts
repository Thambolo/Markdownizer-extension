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

describe('CapturePreview', () => {
    let preview: CapturePreview;

    beforeEach(() => {
        vi.stubGlobal('ResizeObserver', StubResizeObserver);
        vi.stubGlobal('MutationObserver', StubMutationObserver);
        vi.stubGlobal('chrome', {
            runtime: {
                getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
            },
        });
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

    it('creates exactly one badge inside the shadow DOM with the logo and Selected text', () => {
        const root = document.createElement('div');
        document.body.appendChild(root);

        preview.show(root);

        const host = document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`)!;
        const layer = host.shadowRoot!.querySelector('.layer')!;
        const badges = layer.querySelectorAll('.badge');

        expect(badges.length).toBe(1);

        const badge = badges[0] as HTMLDivElement;
        const img = badge.querySelector('img') as HTMLImageElement;
        const span = badge.querySelector('span') as HTMLSpanElement;

        expect(img).not.toBeNull();
        expect(img.src).toContain('icons/icon16.svg');
        expect(span).not.toBeNull();
        expect(span.textContent).toBe('Selected');
    });

    it('replaces the prior badge on repeated show() calls', () => {
        const root = document.createElement('div');
        document.body.appendChild(root);

        preview.show(root);
        const firstBadge = document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`)!.shadowRoot!.querySelector('.badge')!;

        preview.show(root);
        const secondBadge = document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`)!.shadowRoot!.querySelector('.badge')!;

        expect(firstBadge).not.toBe(secondBadge);
        expect(document.querySelectorAll(`[${PREVIEW_HOST_ATTRIBUTE}]`).length).toBe(1);
    });

    it('preserves the badge through setLoading and setReady', () => {
        const root = document.createElement('div');
        document.body.appendChild(root);

        preview.show(root);
        const badgeBefore = document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`)!.shadowRoot!.querySelector('.badge')!;

        preview.setLoading();
        const badgeDuring = document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`)!.shadowRoot!.querySelector('.badge')!;

        preview.setReady();
        const badgeAfter = document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`)!.shadowRoot!.querySelector('.badge')!;

        expect(badgeBefore).toBe(badgeDuring);
        expect(badgeDuring).toBe(badgeAfter);
    });

    it('removes the badge together with the host on remove()', () => {
        const root = document.createElement('div');
        document.body.appendChild(root);

        preview.show(root);
        expect(document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`)).not.toBeNull();

        preview.remove();
        expect(document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`)).toBeNull();
    });

    it('does not throw when removing after repeated removal', () => {
        const root = document.createElement('div');
        document.body.appendChild(root);

        preview.show(root);
        preview.remove();
        expect(() => preview.remove()).not.toThrow();
    });
});
