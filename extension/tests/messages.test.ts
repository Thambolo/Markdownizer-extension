import { beforeEach, describe, expect, it, vi } from 'vitest';

type Sender = { tab?: { id?: number } };

describe('message router', () => {
    let mod: typeof import('../src/shared/messages');

    beforeEach(async () => {
        vi.resetModules();
        mod = await import('../src/shared/messages');
    });

    it('ignores messages with no type/action', () => {
        const handler = vi.fn();
        mod.registerMessageHandler('convert_page', handler);
        const result = mod.dispatchMessage({ nope: true }, {} as Sender, vi.fn());
        expect(result).toBeUndefined();
        expect(handler).not.toHaveBeenCalled();
    });

    it('ignores unknown registered keys', () => {
        const result = mod.dispatchMessage({ action: 'does_not_exist' }, {} as Sender, vi.fn());
        expect(result).toBeUndefined();
    });

    it('routes action messages to the registered handler with the exact envelope', () => {
        const handler = vi.fn(() => false);
        mod.registerMessageHandler('convert_page', handler);
        const envelope = { action: 'convert_page', captureMode: 'smart', includeIframes: false };
        const sender = { tab: { id: 7 } };
        const respond = vi.fn();
        mod.dispatchMessage(envelope, sender as Sender, respond);
        expect(handler).toHaveBeenCalledExactlyOnceWith(envelope, sender, respond);
    });

    it('routes type messages (broadcasts) to the registered handler', () => {
        const handler = vi.fn(() => false);
        mod.registerMessageHandler('zip:progress', handler);
        const envelope = { type: 'zip:progress', buildId: 'A', phase: 'build' };
        mod.dispatchMessage(envelope, {} as Sender, vi.fn());
        expect(handler).toHaveBeenCalledExactlyOnceWith(envelope, {}, expect.any(Function));
    });

    it('async handlers keep the channel open and may respond late', async () => {
        const respond = vi.fn();
        mod.registerMessageHandler('convert_skeleton', (_r, _s, sr) => { sr({ ok: true }); return true; });
        const result = mod.dispatchMessage({ action: 'convert_skeleton', payload: {} }, {} as Sender, respond);
        expect(result).toBe(true);
        await Promise.resolve();
        expect(respond).toHaveBeenCalledWith({ ok: true });
    });

    it('last registration wins for a key', () => {
        const first = vi.fn(() => false);
        const second = vi.fn(() => false);
        mod.registerMessageHandler('zip:status', first);
        mod.registerMessageHandler('zip:status', second);
        mod.dispatchMessage({ action: 'zip:status', buildId: 'A' }, {} as Sender, vi.fn());
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
    });
});
