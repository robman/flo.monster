import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { storeApiKey, retrieveApiKey, deleteApiKey, hasStoredKey } from './api-key.js';

beforeEach(async () => {
  const dbs = await indexedDB.databases();
  for (const db of dbs) {
    if (db.name) indexedDB.deleteDatabase(db.name);
  }
});

describe('API key management', () => {
  it('store and retrieve roundtrip returns original key', async () => {
    const key = 'sk-ant-test-key-12345';
    await storeApiKey(key);
    const retrieved = await retrieveApiKey();
    expect(retrieved).toBe(key);
  });

  it('retrieve when none stored returns null', async () => {
    const result = await retrieveApiKey();
    expect(result).toBeNull();
  });

  it('delete removes the key', async () => {
    await storeApiKey('sk-ant-to-delete');
    expect(await hasStoredKey()).toBe(true);
    await deleteApiKey();
    expect(await hasStoredKey()).toBe(false);
    expect(await retrieveApiKey()).toBeNull();
  });

  it('hasStoredKey returns false when no key', async () => {
    expect(await hasStoredKey()).toBe(false);
  });

  it('hasStoredKey returns true when key exists', async () => {
    await storeApiKey('sk-ant-exists');
    expect(await hasStoredKey()).toBe(true);
  });

  it('stored data is not plaintext', async () => {
    const key = 'sk-ant-secret-key';
    await storeApiKey(key);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('awe', 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const record = await new Promise<any>((resolve, reject) => {
      const tx = db.transaction('config', 'readonly');
      const store = tx.objectStore('config');
      const req = store.get('api-key');
      req.onsuccess = () => { db.close(); resolve(req.result); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
    expect(record).toHaveProperty('iv');
    expect(record).toHaveProperty('data');
    const storedBytes = new Uint8Array(record.data);
    const keyBytes = new TextEncoder().encode(key);
    expect(storedBytes.length).not.toBe(keyBytes.length);
  });

  it('overwriting key replaces the old value', async () => {
    await storeApiKey('first-key');
    await storeApiKey('second-key');
    const retrieved = await retrieveApiKey();
    expect(retrieved).toBe('second-key');
  });
});
