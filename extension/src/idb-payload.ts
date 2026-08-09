// idb-payload.ts - IndexedDB payload store for zip builds. Pure web API,
// available in both the service worker and the offscreen document; no
// chrome.* references. Payload bytes never travel in runtime messages
// (64 MiB limit), so the offscreen document writes them here and the
// service worker reads them back under the same buildId.

const DB_NAME = 'markdownizer';
const STORE = 'zip-payloads';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, 1);
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains(STORE)) {
                    request.result.createObjectStore(STORE);
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
        });
    }
    return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
}

export async function savePayload(buildId: string, bytes: Uint8Array): Promise<void> {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(bytes, buildId);
    await txDone(tx);
}

export async function readPayload(buildId: string): Promise<Uint8Array> {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(buildId);
    const value = await new Promise<Uint8Array | undefined>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result as Uint8Array | undefined);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'));
    });
    await txDone(tx);
    return value ?? new Uint8Array();
}

export async function deletePayload(buildId: string): Promise<void> {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(buildId);
    await txDone(tx);
}

/**
 * Close the cached connection and reset it. Tests must call this before
 * deleteDatabase() (an open connection blocks deletion). Production code
 * never needs it.
 */
export async function closePayloadDb(): Promise<void> {
    if (!dbPromise) return;
    try {
        const db = await dbPromise;
        db.close();
    } catch {
        // open failed; nothing to close
    }
    dbPromise = null;
}
