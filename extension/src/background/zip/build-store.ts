import type { ActiveZipBuildState } from '../../zip/protocol';

// build-store.ts — serialized activeZipBuild state (P6).
// storage.session has no CAS, so every read-check-write/remove through this
// store runs on ONE per-instance queue: a stale build's mutation can never
// land between a newer build's read and write. Consumers that only need the
// current state (e.g. the zip:completed early recovery guard) may call get()
// without queueing — every MUTATION goes through the queue.

export interface ZipBuildStore {
    /** Read the current stored build state (plain read, not queue-serialized). */
    get(): Promise<ActiveZipBuildState | undefined>;
    /** Queue-serialized unconditional write: "newest build claims state". */
    claim(state: ActiveZipBuildState): Promise<void>;
    /** Queue-serialized compare-and-clear: removes the active state only when
     * it still belongs to buildId. Resolves true when it cleared. */
    clearIfOwned(buildId: string): Promise<boolean>;
    /**
     * Serialize op through the store's queue: each op runs with the CURRENT
     * stored state passed in (the queue closes the read-check-write window
     * storage.session cannot CAS). The queue is per store instance (a
     * restarted worker instance's recovery path reads fresh storage and
     * cannot interleave).
     */
    mutate(op: (current: ActiveZipBuildState | undefined) => void | Promise<void>): Promise<void>;
}

export function createZipBuildStore(): ZipBuildStore {
    let zipStateQueue: Promise<void> = Promise.resolve();

    function mutate(op: (current: ActiveZipBuildState | undefined) => void | Promise<void>): Promise<void> {
        const next = zipStateQueue.then(async () => {
            const stored = await chrome.storage.session.get('activeZipBuild').catch(() => ({}));
            const current = (stored as { activeZipBuild?: ActiveZipBuildState }).activeZipBuild;
            await op(current);
        });
        zipStateQueue = next.catch(() => {});
        return next;
    }

    return {
        async get(): Promise<ActiveZipBuildState | undefined> {
            const stored = await chrome.storage.session.get('activeZipBuild').catch(() => ({}));
            return (stored as { activeZipBuild?: ActiveZipBuildState }).activeZipBuild;
        },
        claim(state: ActiveZipBuildState): Promise<void> {
            return mutate(() => chrome.storage.session.set({ activeZipBuild: state }).catch(() => {}));
        },
        clearIfOwned(buildId: string): Promise<boolean> {
            let cleared = false;
            return mutate(async (current) => {
                if (current?.buildId === buildId) {
                    await chrome.storage.session.remove('activeZipBuild').catch(() => {});
                    cleared = true;
                }
            }).then(() => cleared);
        },
        mutate,
    };
}

/**
 * The application singleton: every background module (index.ts's zip:progress
 * relay, the coordinator's claims/CAS clears) shares ONE store, so all
 * activeZipBuild mutations serialize against each other — exactly like the
 * single module-scope queue in the pre-refactor background/index.ts. Tests
 * create fresh stores with createZipBuildStore().
 */
export const zipBuildStore = createZipBuildStore();