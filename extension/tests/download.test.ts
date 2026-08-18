// @vitest-environment jsdom
// Contract tests for the shared blob-download helper (Task 3).
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { downloadBlob } from '../src/shared/download';

describe('downloadBlob', () => {
    let createObjectURL: ReturnType<typeof vi.fn>;
    let revokeObjectURL: ReturnType<typeof vi.fn>;
    let appendSpy: ReturnType<typeof vi.spyOn>;
    let removeSpy: ReturnType<typeof vi.spyOn>;
    let clickSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        createObjectURL = vi.fn(() => 'blob:mock-url');
        revokeObjectURL = vi.fn();
        vi.stubGlobal('URL', new Proxy(URL, {
            get: (target, prop, receiver) => {
                if (prop === 'createObjectURL') return createObjectURL;
                if (prop === 'revokeObjectURL') return revokeObjectURL;
                return Reflect.get(target, prop, receiver);
            },
        }));
        appendSpy = vi.spyOn(document.body, 'appendChild');
        removeSpy = vi.spyOn(document.body, 'removeChild');
        clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('creates an object URL, wires the anchor, clicks, and removes it', () => {
        const blob = new Blob(['# hello'], { type: 'text/markdown' });

        downloadBlob(blob, 'hello.md');

        expect(createObjectURL).toHaveBeenCalledWith(blob);
        const anchor = appendSpy.mock.calls[0][0] as HTMLAnchorElement;
        expect(anchor).toBeInstanceOf(HTMLAnchorElement);
        expect(anchor.href).toBe('blob:mock-url');
        expect(anchor.download).toBe('hello.md');
        expect(clickSpy).toHaveBeenCalledTimes(1);
        expect(removeSpy).toHaveBeenCalledWith(anchor);
    });

    it('revokes the object URL synchronously with revokeDelayMs = 0', () => {
        downloadBlob(new Blob(['x']), 'x.md');

        expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    });

    it('defers revocation until the delay elapses when revokeDelayMs > 0', () => {
        vi.useFakeTimers();

        downloadBlob(new Blob(['x']), 'x.md', 30_000);

        expect(revokeObjectURL).not.toHaveBeenCalled();
        vi.advanceTimersByTime(29_999);
        expect(revokeObjectURL).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    });

    it('passes the filename through untouched', () => {
        downloadBlob(new Blob(['x']), 'my page report.md');

        const anchor = appendSpy.mock.calls[0][0] as HTMLAnchorElement;
        expect(anchor.download).toBe('my page report.md');
    });
});
