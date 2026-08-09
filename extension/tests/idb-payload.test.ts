import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { savePayload, readPayload, deletePayload, closePayloadDb } from '../src/idb-payload';

describe('idb-payload', () => {
    beforeEach(async () => {
        // deleteDatabase() is BLOCKED while a connection is open, so close the
        // cached connection first (closePayloadDb nulls the module's dbPromise).
        await closePayloadDb();
        const dbs = (await indexedDB.databases?.()) ?? [];
        for (const db of dbs) await new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase(db.name!);
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
            req.onblocked = () => resolve();
        });
    });

    afterEach(async () => {
        await closePayloadDb();
    });

    it('round-trips bytes under a buildId', async () => {
        const bytes = new Uint8Array([1, 2, 3, 4]);
        await savePayload('b-1', bytes);
        const read = await readPayload('b-1');
        expect(Array.from(read)).toEqual([1, 2, 3, 4]);
    });

    it('overwrites an existing payload for the same buildId', async () => {
        await savePayload('b-2', new Uint8Array([1]));
        await savePayload('b-2', new Uint8Array([9, 9]));
        expect(Array.from(await readPayload('b-2'))).toEqual([9, 9]);
    });

    it('delete removes the payload', async () => {
        await savePayload('b-3', new Uint8Array([7]));
        await deletePayload('b-3');
        expect(Array.from(await readPayload('b-3'))).toEqual([]);
    });

    it('delete of a missing key is a no-op', async () => {
        await expect(deletePayload('b-missing')).resolves.toBeUndefined();
    });

    it('reopens the database after closePayloadDb', async () => {
        await savePayload('b-4', new Uint8Array([5]));
        await closePayloadDb();
        expect(Array.from(await readPayload('b-4'))).toEqual([5]);
    });
});
