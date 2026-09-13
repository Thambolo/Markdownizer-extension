// identity.ts - Handles User Identity logic

/**
 * Interface for the Chrome Storage API to allow mocking in tests
 */
export interface StorageProvider {
    getSync(key: string): Promise<{ [key: string]: unknown }>;
    setSync(items: { [key: string]: unknown }): Promise<void>;
    getLocal(key: string): Promise<{ [key: string]: unknown }>;
    setLocal(items: { [key: string]: unknown }): Promise<void>;
}

/**
 * Real Chrome Storage Implementation
 */
export const ChromeStorage: StorageProvider = {
    getSync: (key) => chrome.storage.sync.get(key),
    setSync: (items) => chrome.storage.sync.set(items),
    getLocal: (key) => chrome.storage.local.get(key),
    setLocal: (items) => chrome.storage.local.set(items),
};

/**
 * Ensures a persistent User ID exists.
 * Priority: Sync > Local > New
 */
export async function getOrCreateUserID(storage: StorageProvider = ChromeStorage): Promise<string> {
    // Check Sync storage first (preferred persistence)
    const syncData = await storage.getSync("user_id");
    if (syncData && typeof syncData.user_id === 'string') {
        // Ensure local mirror is up to date
        await storage.setLocal({ "user_id": syncData.user_id });
        return syncData.user_id;
    }

    // Fallback to Local storage (if sync disabled or not yet migrated)
    const localData = await storage.getLocal("user_id");
    if (localData && typeof localData.user_id === 'string') {
        // Migrate to Sync for better durability
        await storage.setSync({ "user_id": localData.user_id });
        return localData.user_id;
    }

    // Generate New ID
    const newID = crypto.randomUUID();
    
    await storage.setSync({ "user_id": newID });
    await storage.setLocal({ "user_id": newID });
    
    return newID;
}
