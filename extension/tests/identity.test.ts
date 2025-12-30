import { describe, it, expect } from 'vitest';
import { getOrCreateUserID, StorageProvider } from '../src/identity';

/**
 * Mock Storage Implementation
 */
class MockStorage implements StorageProvider {
    store: Record<string, unknown> = {};
    syncStore: Record<string, unknown> = {};

    async getLocal(key: string) { return { [key]: this.store[key] }; }
    async setLocal(items: Record<string, unknown>) { Object.assign(this.store, items); }
    async getSync(key: string) { return { [key]: this.syncStore[key] }; }
    async setSync(items: Record<string, unknown>) { Object.assign(this.syncStore, items); }
}

describe('User Identity Logic', () => {
    it('should generate a NEW ID if storage is empty', async () => {
        const mock = new MockStorage();
        const id = await getOrCreateUserID(mock);

        expect(id).toBeDefined();
        expect(id.length).toBeGreaterThan(10); // UUID length check
        expect(mock.store['user_id']).toBe(id); // Saved to local
        expect(mock.syncStore['user_id']).toBe(id); // Saved to sync
    });

    it('should return EXISTING SYNC ID if present', async () => {
        const mock = new MockStorage();
        mock.syncStore['user_id'] = 'sync-uuid-123';
        
        const id = await getOrCreateUserID(mock);
        
        expect(id).toBe('sync-uuid-123');
        expect(mock.store['user_id']).toBe('sync-uuid-123'); // Should mirror to local
    });

    it('should return EXISTING LOCAL ID if sync is missing (migration)', async () => {
        const mock = new MockStorage();
        mock.store['user_id'] = 'local-uuid-456';
        
        const id = await getOrCreateUserID(mock);
        
        expect(id).toBe('local-uuid-456');
        expect(mock.syncStore['user_id']).toBe('local-uuid-456'); // Should migrate to sync
    });

    it('should prefer SYNC ID over LOCAL ID (conflict resolution)', async () => {
        const mock = new MockStorage();
        mock.syncStore['user_id'] = 'correct-sync-id';
        mock.store['user_id'] = 'stale-local-id';
        
        const id = await getOrCreateUserID(mock);
        
        expect(id).toBe('correct-sync-id');
        expect(mock.store['user_id']).toBe('correct-sync-id'); // Local updated to match sync
    });
});
