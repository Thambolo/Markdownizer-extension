// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getHighlightRegistry, HighlightService } from '../src/preview/highlight-service';

const READY = 'ready-highlight';
const LOADING = 'loading-highlight';

/** A stub Highlight constructor that records the ranges it receives. */
class StubHighlight {
    ranges: Range[];
    constructor(...ranges: Range[]) {
        this.ranges = ranges.flat();
    }
}

/** A registry stub recording set/delete/has calls. */
function createRegistry() {
    return {
        set: vi.fn(),
        delete: vi.fn(),
        has: vi.fn(() => true),
    };
}

describe('HighlightService', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('setState("ready") deletes both names then sets the ready name with the ranges', () => {
        const registry = createRegistry();
        const service = new HighlightService(registry as any, StubHighlight as any, READY, LOADING);
        const range = document.createRange();
        range.selectNodeContents(document.body);

        service.setState('ready', [range]);

        // Deletes first, then sets — delete called for both names
        const deleteCalls = registry.delete.mock.calls.map((c) => c[0]);
        expect(deleteCalls).toEqual([READY, LOADING]);
        expect(registry.set).toHaveBeenCalledTimes(1);
        expect(registry.set.mock.calls[0][0]).toBe(READY);
        const highlight = registry.set.mock.calls[0][1];
        expect(highlight).toBeInstanceOf(StubHighlight);
        expect((highlight as StubHighlight).ranges).toEqual([range]);
        expect(registry.set).toHaveBeenCalledAfter(registry.delete as any);
    });

    it('setState("loading") deletes both names and sets the loading name', () => {
        const registry = createRegistry();
        const service = new HighlightService(registry as any, StubHighlight as any, READY, LOADING);
        const range = document.createRange();

        service.setState('loading', [range]);

        expect(registry.delete.mock.calls.map((c) => c[0])).toEqual([READY, LOADING]);
        expect(registry.set).toHaveBeenCalledTimes(1);
        expect(registry.set.mock.calls[0][0]).toBe(LOADING);
        expect((registry.set.mock.calls[0][1] as StubHighlight).ranges).toEqual([range]);
    });

    it('clear() deletes both names and never sets', () => {
        const registry = createRegistry();
        const service = new HighlightService(registry as any, StubHighlight as any, READY, LOADING);

        service.clear();

        expect(registry.delete.mock.calls.map((c) => c[0])).toEqual([READY, LOADING]);
        expect(registry.set).not.toHaveBeenCalled();
    });

    it('does not throw when the registry is null (no Highlight API)', () => {
        const service = new HighlightService(null, StubHighlight as any, READY, LOADING);
        const range = document.createRange();

        expect(() => service.setState('ready', [range])).not.toThrow();
        expect(() => service.clear()).not.toThrow();
    });

    it('still deletes both names when the registry exists but the constructor is null (no set)', () => {
        const registry = createRegistry();
        const service = new HighlightService(registry as any, null, READY, LOADING);
        const range = document.createRange();

        service.setState('ready', [range]);

        // deletes happen whenever the registry exists, even with a null ctor
        expect(registry.delete.mock.calls.map((c) => c[0])).toEqual([READY, LOADING]);
        expect(registry.set).not.toHaveBeenCalled();
    });

    it('does not throw when registry exists and ctor is null on clear', () => {
        const registry = createRegistry();
        const service = new HighlightService(registry as any, null, READY, LOADING);

        expect(() => service.clear()).not.toThrow();
        expect(registry.delete).toHaveBeenCalledTimes(2);
    });
});

describe('getHighlightRegistry', () => {
    let origCSS: any;
    let origHighlight: any;

    afterEach(() => {
        if (origCSS !== undefined) {
            (globalThis as any).CSS = origCSS;
        } else {
            delete (globalThis as any).CSS;
        }
        if (origHighlight !== undefined) {
            (globalThis as any).Highlight = origHighlight;
        } else {
            delete (globalThis as any).Highlight;
        }
    });

    it('returns null when CSS.highlights or Highlight is unavailable', () => {
        origCSS = (globalThis as any).CSS;
        origHighlight = (globalThis as any).Highlight;
        delete (globalThis as any).CSS;
        delete (globalThis as any).Highlight;
        expect(getHighlightRegistry()).toBeNull();
    });

    it('returns CSS.highlights when the full API is available', () => {
        origCSS = (globalThis as any).CSS;
        origHighlight = (globalThis as any).Highlight;
        const registry = { set: vi.fn(), delete: vi.fn(), has: vi.fn() };
        (globalThis as any).CSS = { highlights: registry };
        (globalThis as any).Highlight = StubHighlight;
        expect(getHighlightRegistry()).toBe(registry);
    });
});
