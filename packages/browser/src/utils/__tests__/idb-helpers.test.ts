/**
 * Tests for IDB helper functions
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { openDB, idbGet, idbPut, idbDelete, idbKeys } from '../idb-helpers.js';

describe('idb-helpers', () => {
  const TEST_DB_NAME = 'test-idb-helpers';
  const TEST_STORE = 'store';
  let db: IDBDatabase;

  beforeEach(async () => {
    // Reset IndexedDB for complete isolation between tests
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    db = await openDB(TEST_DB_NAME, TEST_STORE);
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
  });

  describe('openDB', () => {
    it('should open a database and create the object store', async () => {
      expect(db).toBeDefined();
      expect(db.objectStoreNames.contains(TEST_STORE)).toBe(true);
    });

    it('should use "store" as the default store name', async () => {
      db.close();
      const defaultDb = await openDB('test-default-store');
      expect(defaultDb.objectStoreNames.contains('store')).toBe(true);
      defaultDb.close();
    });

    it('should create a database with a custom store name', async () => {
      db.close();
      const customDb = await openDB('test-custom-store', 'custom');
      expect(customDb.objectStoreNames.contains('custom')).toBe(true);
      customDb.close();
    });

    it('should open the same database twice without error', async () => {
      db.close();
      const db2 = await openDB(TEST_DB_NAME, TEST_STORE);
      expect(db2).toBeDefined();
      expect(db2.objectStoreNames.contains(TEST_STORE)).toBe(true);
      db = db2; // so afterEach closes the right one
    });
  });

  describe('idbPut', () => {
    it('should put a string value', async () => {
      await idbPut(db, TEST_STORE, 'key1', 'hello');
      const result = await idbGet(db, TEST_STORE, 'key1');
      expect(result).toBe('hello');
    });

    it('should put a number value', async () => {
      await idbPut(db, TEST_STORE, 'num', 42);
      const result = await idbGet(db, TEST_STORE, 'num');
      expect(result).toBe(42);
    });

    it('should put an object value', async () => {
      const obj = { name: 'test', items: [1, 2, 3] };
      await idbPut(db, TEST_STORE, 'obj', obj);
      const result = await idbGet(db, TEST_STORE, 'obj');
      expect(result).toEqual(obj);
    });

    it('should overwrite an existing value', async () => {
      await idbPut(db, TEST_STORE, 'key', 'old');
      await idbPut(db, TEST_STORE, 'key', 'new');
      const result = await idbGet(db, TEST_STORE, 'key');
      expect(result).toBe('new');
    });

    it('should put a null value', async () => {
      await idbPut(db, TEST_STORE, 'nullable', null);
      const result = await idbGet(db, TEST_STORE, 'nullable');
      expect(result).toBe(null);
    });

    it('should put a boolean value', async () => {
      await idbPut(db, TEST_STORE, 'flag', true);
      const result = await idbGet(db, TEST_STORE, 'flag');
      expect(result).toBe(true);
    });
  });

  describe('idbGet', () => {
    it('should return null for a non-existent key', async () => {
      const result = await idbGet(db, TEST_STORE, 'nonexistent');
      expect(result).toBe(null);
    });

    it('should return the stored value', async () => {
      await idbPut(db, TEST_STORE, 'existing', 'value');
      const result = await idbGet(db, TEST_STORE, 'existing');
      expect(result).toBe('value');
    });

    it('should return an array value', async () => {
      const arr = [1, 'two', { three: 3 }];
      await idbPut(db, TEST_STORE, 'arr', arr);
      const result = await idbGet(db, TEST_STORE, 'arr');
      expect(result).toEqual(arr);
    });
  });

  describe('idbDelete', () => {
    it('should delete an existing key', async () => {
      await idbPut(db, TEST_STORE, 'toDelete', 'value');
      await idbDelete(db, TEST_STORE, 'toDelete');
      const result = await idbGet(db, TEST_STORE, 'toDelete');
      expect(result).toBe(null);
    });

    it('should not throw when deleting a non-existent key', async () => {
      await expect(idbDelete(db, TEST_STORE, 'nonexistent')).resolves.toBeUndefined();
    });

    it('should only delete the specified key', async () => {
      await idbPut(db, TEST_STORE, 'keep', 'kept');
      await idbPut(db, TEST_STORE, 'remove', 'removed');
      await idbDelete(db, TEST_STORE, 'remove');
      expect(await idbGet(db, TEST_STORE, 'keep')).toBe('kept');
      expect(await idbGet(db, TEST_STORE, 'remove')).toBe(null);
    });
  });

  describe('idbKeys', () => {
    it('should return an empty array for an empty store', async () => {
      const keys = await idbKeys(db, TEST_STORE);
      expect(keys).toEqual([]);
    });

    it('should return all keys in the store', async () => {
      await idbPut(db, TEST_STORE, 'a', 1);
      await idbPut(db, TEST_STORE, 'b', 2);
      await idbPut(db, TEST_STORE, 'c', 3);
      const keys = await idbKeys(db, TEST_STORE);
      expect(keys.sort()).toEqual(['a', 'b', 'c']);
    });

    it('should not include deleted keys', async () => {
      await idbPut(db, TEST_STORE, 'x', 1);
      await idbPut(db, TEST_STORE, 'y', 2);
      await idbDelete(db, TEST_STORE, 'x');
      const keys = await idbKeys(db, TEST_STORE);
      expect(keys).toEqual(['y']);
    });
  });

  describe('integration', () => {
    it('should support full CRUD workflow', async () => {
      // Create
      await idbPut(db, TEST_STORE, 'item', { count: 0 });

      // Read
      let item = await idbGet(db, TEST_STORE, 'item') as { count: number };
      expect(item).toEqual({ count: 0 });

      // Update
      await idbPut(db, TEST_STORE, 'item', { count: item.count + 1 });
      item = await idbGet(db, TEST_STORE, 'item') as { count: number };
      expect(item).toEqual({ count: 1 });

      // Delete
      await idbDelete(db, TEST_STORE, 'item');
      const deleted = await idbGet(db, TEST_STORE, 'item');
      expect(deleted).toBe(null);

      // Verify keys
      const keys = await idbKeys(db, TEST_STORE);
      expect(keys).toEqual([]);
    });

    it('should work with a different store name', async () => {
      db.close();
      const customDb = await openDB('test-custom-crud', 'config');
      await idbPut(customDb, 'config', 'setting', 'value');
      const result = await idbGet(customDb, 'config', 'setting');
      expect(result).toBe('value');
      customDb.close();
    });
  });
});
