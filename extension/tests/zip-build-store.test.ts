import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveZipBuildState } from '../src/zip/protocol';
import { createZipBuildStore, type ZipBuildStore } from '../src/background/zip/build-store';

// Contract tests for the serialized activeZipBuild store (Task 8 / P6).
// storage.session has no CAS, so the store's queue is what closes the
// read-check-write window between a stale build's mutation and a newer
// build's claim. The chrome mock mirrors the background-zip harness:
// a Map-backed storage.session with per-test control over set resolution.

describe('ZipBuildStore', () => {
    let session: Map<string, unknown>;
    let setImpl: (items: Record<string, unknown>) => Promise<void>;
    let store: ZipBuildStore;

    beforeEach(() => {
        vi.resetModules();
        session = new Map();
        setImpl = async (items: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(items)) session.set(k, v);
        };
        (globalThis as unknown as { chrome?: unknown }).chrome = {
            storage: {
                session: {
                    get: async (keys: string | string[]) => {
                        const k = Array.isArray(keys) ? keys[0] : keys;
                        return session.has(k) ? { [k]: session.get(k) } : {};
                    },
                    set: async (items: Record<string, unknown>) => setImpl(items),
                    remove: async (keys: string | string[]) => {
                        const k = Array.isArray(keys) ? keys[0] : keys;
                        session.delete(k);
                    },
                },
            },
        } as unknown as typeof chrome;
        store = createZipBuildStore();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete (globalThis as unknown as { chrome?: unknown }).chrome;
    });

    it('queues a later mutation behind an in-flight claim (stale-build race)', async () => {
        // Defer claim A's storage write: while a claim is mid-write the Map
        // has no committed state, so an unqueued stale mutation would read
        // `undefined` and (without the ownership guard seeing A) clobber the
        // claim. The queue makes the stale mutation run AFTER A's write
        // lands, so its read sees A and the guard keeps the state.
        let releaseSet!: () => void;
        // Deferred storage write: in-flight (pending) until released, then it
        // commits ITS OWN items — exactly like a real storage.set that has
        // not yet landed. This is what makes the claim "mid-write".
        setImpl = (items: Record<string, unknown>) => new Promise<void>((resolve) => {
            releaseSet = () => {
                for (const [k, v] of Object.entries(items)) session.set(k, v);
                resolve();
            };
        });

        const claimA = store.claim({ buildId: 'A', phase: 'fetch', fetched: 0, total: 0, startedAt: 1 });
        // A stale build's mutation enqueues behind the claim; the queued read
        // happens AFTER A's write lands (queue closes the CAS-less window).
        // Mirror the zip:progress relay guard: only write when no build owns
        // the state or this build still owns it.
        const staleWrite = store.mutate(async (current) => {
            if (current && current.buildId !== 'stale') return;
            await chrome.storage.session.set({
                activeZipBuild: { buildId: 'stale', phase: 'build' } satisfies ActiveZipBuildState,
            });
        });

        // Let the claim's op reach its deferred storage write (mid-write: A's
        // storage.set is pending, so nothing is committed yet).
        await new Promise<void>((r) => setTimeout(r, 0));
        expect(releaseSet).toBeTypeOf('function');
        expect(session.get('activeZipBuild')).toBeUndefined();

        releaseSet();
        await Promise.all([claimA, staleWrite]);
        expect(session.get('activeZipBuild')).toMatchObject({ buildId: 'A' });
    });

    it('clearIfOwned returns true and clears only when buildId matches', async () => {
        session.set('activeZipBuild', { buildId: 'A', phase: 'fetch', fetched: 0, total: 0, startedAt: 1 });

        expect(await store.clearIfOwned('A')).toBe(true);
        expect(session.get('activeZipBuild')).toBeUndefined();

        // A newer build owns the state: the older build's clear must no-op.
        session.set('activeZipBuild', { buildId: 'B', phase: 'build', fetched: 0, total: 0, startedAt: 2 });
        expect(await store.clearIfOwned('A')).toBe(false);
        expect(session.get('activeZipBuild')).toMatchObject({ buildId: 'B' });
    });

    it('runs concurrent mutations serially through the queue', async () => {
        session.set('activeZipBuild', { buildId: 'A', phase: 'fetch', fetched: 0, total: 0, startedAt: 1 });

        // Both ops increment `fetched` off the CURRENT stored state. With one
        // queue the second op observes the first op's write (final 2);
        // without serialization both reads can observe 0 before either write
        // commits (final 1).
        await Promise.all([
            store.mutate(async (current) => {
                const base: ActiveZipBuildState = current ?? {};
                await chrome.storage.session.set({ activeZipBuild: { ...base, fetched: (base.fetched ?? 0) + 1 } });
            }),
            store.mutate(async (current) => {
                const base: ActiveZipBuildState = current ?? {};
                await chrome.storage.session.set({ activeZipBuild: { ...base, fetched: (base.fetched ?? 0) + 1 } });
            }),
        ]);

        expect((session.get('activeZipBuild') as ActiveZipBuildState).fetched).toBe(2);
    });

    it('claim overwrites the stored state unconditionally', async () => {
        session.set('activeZipBuild', { buildId: 'A', phase: 'build', fetched: 0, total: 0, startedAt: 0 });

        await store.claim({ buildId: 'B', phase: 'fetch', fetched: 3, total: 5, startedAt: 42 });

        expect(session.get('activeZipBuild')).toMatchObject({
            buildId: 'B', phase: 'fetch', fetched: 3, total: 5, startedAt: 42,
        });
    });
});