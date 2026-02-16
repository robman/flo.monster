/**
 * Tests for ExtensionConfigStore
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ExtensionConfigStore } from '../extension-config-store.js';
import type { ExtensionConfigData } from '../extension-config-store.js';

const STORAGE_KEY = 'flo-extension-configs';

describe('ExtensionConfigStore', () => {
  let store: ExtensionConfigStore;

  beforeEach(() => {
    store = new ExtensionConfigStore();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe('init', () => {
    it('should initialize without a password', async () => {
      await store.init();
      expect(store.hasConfig('any-extension')).toBe(false);
    });

    it('should initialize with a password for encryption', async () => {
      await store.init('test-password');
      expect(store.hasConfig('any-extension')).toBe(false);
    });

    it('should load existing configs from localStorage on init', async () => {
      const existingData: ExtensionConfigData[] = [
        {
          extensionId: 'ext-1',
          values: { key1: 'value1' },
        },
      ];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(existingData));

      await store.init();

      expect(store.hasConfig('ext-1')).toBe(true);
      expect(store.getConfig('ext-1')).toEqual({ key1: 'value1' });
    });

    it('should handle corrupted localStorage data gracefully', async () => {
      localStorage.setItem(STORAGE_KEY, 'not-valid-json');

      await store.init();

      // Should not throw, just ignore invalid data
      expect(store.hasConfig('any-extension')).toBe(false);
    });
  });

  describe('getConfig', () => {
    beforeEach(async () => {
      await store.init();
    });

    it('should return empty object for non-existent extension', () => {
      const config = store.getConfig('non-existent');
      expect(config).toEqual({});
    });

    it('should return config values for existing extension', async () => {
      await store.setConfig('ext-1', { setting1: 'value1', setting2: 42 });

      const config = store.getConfig('ext-1');
      expect(config).toEqual({ setting1: 'value1', setting2: 42 });
    });

    it('should not return encrypted secrets in getConfig', async () => {
      await store.init('password');
      await store.setConfig('ext-1', { apiKey: 'secret-key', name: 'test' }, ['apiKey']);

      const config = store.getConfig('ext-1');
      expect(config).toEqual({ name: 'test' });
      expect(config.apiKey).toBeUndefined();
    });
  });

  describe('hasConfig', () => {
    beforeEach(async () => {
      await store.init();
    });

    it('should return false for non-existent extension', () => {
      expect(store.hasConfig('non-existent')).toBe(false);
    });

    it('should return true for existing extension', async () => {
      await store.setConfig('ext-1', { key: 'value' });
      expect(store.hasConfig('ext-1')).toBe(true);
    });
  });

  describe('setConfig', () => {
    beforeEach(async () => {
      await store.init();
    });

    it('should store config values', async () => {
      await store.setConfig('ext-1', { key1: 'value1', key2: 123 });

      expect(store.getConfig('ext-1')).toEqual({ key1: 'value1', key2: 123 });
    });

    it('should overwrite existing config values', async () => {
      await store.setConfig('ext-1', { key1: 'old-value' });
      await store.setConfig('ext-1', { key1: 'new-value', key2: 'added' });

      expect(store.getConfig('ext-1')).toEqual({ key1: 'new-value', key2: 'added' });
    });

    it('should persist config to localStorage', async () => {
      await store.setConfig('ext-1', { key: 'value' });

      const stored = localStorage.getItem(STORAGE_KEY);
      expect(stored).not.toBeNull();
      const parsed = JSON.parse(stored!);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].extensionId).toBe('ext-1');
      expect(parsed[0].values.key).toBe('value');
    });

    it('should store non-secret fields in plain values without encryption key', async () => {
      await store.setConfig('ext-1', { apiKey: 'secret', name: 'test' }, ['apiKey']);

      // Without encryption key, secret fields are stored as plain values
      const config = store.getConfig('ext-1');
      expect(config).toEqual({ apiKey: 'secret', name: 'test' });
    });

    it('should encrypt secret fields when encryption key is available', async () => {
      await store.init('password');
      await store.setConfig('ext-1', { apiKey: 'secret-key', name: 'test' }, ['apiKey']);

      // Plain config should not contain apiKey
      const config = store.getConfig('ext-1');
      expect(config).toEqual({ name: 'test' });

      // Should be able to retrieve secret
      const secret = await store.getSecret('ext-1', 'apiKey');
      expect(secret).toBe('secret-key');
    });

    it('should handle empty config', async () => {
      await store.setConfig('ext-1', {});

      expect(store.hasConfig('ext-1')).toBe(true);
      expect(store.getConfig('ext-1')).toEqual({});
    });

    it('should handle various value types', async () => {
      const values = {
        string: 'text',
        number: 42,
        boolean: true,
        array: [1, 2, 3],
        object: { nested: 'value' },
        nullValue: null,
      };

      await store.setConfig('ext-1', values);
      expect(store.getConfig('ext-1')).toEqual(values);
    });
  });

  describe('getSecret', () => {
    it('should return null for non-existent extension', async () => {
      await store.init('password');
      const secret = await store.getSecret('non-existent', 'apiKey');
      expect(secret).toBeNull();
    });

    it('should return null for non-existent secret key', async () => {
      await store.init('password');
      await store.setConfig('ext-1', { apiKey: 'secret' }, ['apiKey']);

      const secret = await store.getSecret('ext-1', 'nonExistentKey');
      expect(secret).toBeNull();
    });

    it('should return null when no encryption key is set', async () => {
      await store.init(); // No password
      await store.setConfig('ext-1', { apiKey: 'secret' }, ['apiKey']);

      const secret = await store.getSecret('ext-1', 'apiKey');
      expect(secret).toBeNull();
    });

    it('should decrypt and return secret value', async () => {
      await store.init('password');
      await store.setConfig('ext-1', { apiKey: 'my-secret-key' }, ['apiKey']);

      const secret = await store.getSecret('ext-1', 'apiKey');
      expect(secret).toBe('my-secret-key');
    });

    it('should return null for corrupted encrypted data', async () => {
      await store.init('password');
      await store.setConfig('ext-1', { apiKey: 'secret' }, ['apiKey']);

      // Corrupt the encrypted data in localStorage
      const stored = localStorage.getItem(STORAGE_KEY);
      const parsed = JSON.parse(stored!);
      parsed[0].encryptedSecrets.apiKey = 'corrupted-base64-data!!!';
      localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));

      // Create new store and load corrupted data
      const newStore = new ExtensionConfigStore();
      await newStore.init('password');

      const secret = await newStore.getSecret('ext-1', 'apiKey');
      expect(secret).toBeNull();
    });
  });

  describe('getFullConfig', () => {
    it('should return empty object for non-existent extension', async () => {
      await store.init('password');
      const config = await store.getFullConfig('non-existent');
      expect(config).toEqual({});
    });

    it('should return plain values when no encryption key', async () => {
      await store.init();
      await store.setConfig('ext-1', { key1: 'value1', key2: 'value2' });

      const config = await store.getFullConfig('ext-1');
      expect(config).toEqual({ key1: 'value1', key2: 'value2' });
    });

    it('should return both plain values and decrypted secrets', async () => {
      await store.init('password');
      await store.setConfig(
        'ext-1',
        { apiKey: 'secret-key', name: 'test-ext', enabled: true },
        ['apiKey'],
      );

      const config = await store.getFullConfig('ext-1');
      expect(config).toEqual({
        apiKey: 'secret-key',
        name: 'test-ext',
        enabled: true,
      });
    });

    it('should skip secrets that cannot be decrypted', async () => {
      await store.init('password');
      await store.setConfig('ext-1', { apiKey: 'secret', name: 'test' }, ['apiKey']);

      // Corrupt the encrypted data
      const stored = localStorage.getItem(STORAGE_KEY);
      const parsed = JSON.parse(stored!);
      parsed[0].encryptedSecrets.apiKey = 'corrupted-data';
      localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));

      // Create new store with same password
      const newStore = new ExtensionConfigStore();
      await newStore.init('password');

      const config = await newStore.getFullConfig('ext-1');
      // Should have name but not apiKey (decryption failed)
      expect(config).toEqual({ name: 'test' });
    });
  });

  describe('deleteConfig', () => {
    beforeEach(async () => {
      await store.init();
    });

    it('should delete config for an extension', async () => {
      await store.setConfig('ext-1', { key: 'value' });
      expect(store.hasConfig('ext-1')).toBe(true);

      store.deleteConfig('ext-1');

      expect(store.hasConfig('ext-1')).toBe(false);
      expect(store.getConfig('ext-1')).toEqual({});
    });

    it('should not throw when deleting non-existent config', () => {
      expect(() => store.deleteConfig('non-existent')).not.toThrow();
    });

    it('should persist deletion to localStorage', async () => {
      await store.setConfig('ext-1', { key: 'value' });
      await store.setConfig('ext-2', { key: 'value2' });

      store.deleteConfig('ext-1');

      const stored = localStorage.getItem(STORAGE_KEY);
      const parsed = JSON.parse(stored!);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].extensionId).toBe('ext-2');
    });

    it('should only delete specified extension, not others', async () => {
      await store.setConfig('ext-1', { key: 'value1' });
      await store.setConfig('ext-2', { key: 'value2' });

      store.deleteConfig('ext-1');

      expect(store.hasConfig('ext-1')).toBe(false);
      expect(store.hasConfig('ext-2')).toBe(true);
      expect(store.getConfig('ext-2')).toEqual({ key: 'value2' });
    });
  });

  describe('clear', () => {
    beforeEach(async () => {
      await store.init();
    });

    it('should clear all extension configs', async () => {
      await store.setConfig('ext-1', { key: 'value1' });
      await store.setConfig('ext-2', { key: 'value2' });

      store.clear();

      expect(store.hasConfig('ext-1')).toBe(false);
      expect(store.hasConfig('ext-2')).toBe(false);
    });

    it('should persist cleared state to localStorage', async () => {
      await store.setConfig('ext-1', { key: 'value1' });

      store.clear();

      const stored = localStorage.getItem(STORAGE_KEY);
      const parsed = JSON.parse(stored!);
      expect(parsed).toEqual([]);
    });

    it('should not throw when clearing already empty store', () => {
      expect(() => store.clear()).not.toThrow();
    });
  });

  describe('exportData', () => {
    beforeEach(async () => {
      await store.init();
    });

    it('should export empty array when no configs', () => {
      const exported = store.exportData();
      expect(exported).toEqual([]);
    });

    it('should export all configs', async () => {
      await store.setConfig('ext-1', { key: 'value1' });
      await store.setConfig('ext-2', { key: 'value2', nested: { a: 1 } });

      const exported = store.exportData();

      expect(exported).toHaveLength(2);
      expect(exported.find((e) => e.extensionId === 'ext-1')).toEqual({
        extensionId: 'ext-1',
        values: { key: 'value1' },
        encryptedSecrets: undefined,
      });
      expect(exported.find((e) => e.extensionId === 'ext-2')).toEqual({
        extensionId: 'ext-2',
        values: { key: 'value2', nested: { a: 1 } },
        encryptedSecrets: undefined,
      });
    });

    it('should include encrypted secrets in export', async () => {
      await store.init('password');
      await store.setConfig('ext-1', { apiKey: 'secret', name: 'test' }, ['apiKey']);

      const exported = store.exportData();

      expect(exported).toHaveLength(1);
      expect(exported[0].extensionId).toBe('ext-1');
      expect(exported[0].values).toEqual({ name: 'test' });
      expect(exported[0].encryptedSecrets).toBeDefined();
      expect(exported[0].encryptedSecrets!.apiKey).toBeDefined();
      // Encrypted value should be different from plain value
      expect(exported[0].encryptedSecrets!.apiKey).not.toBe('secret');
    });
  });

  describe('importData', () => {
    beforeEach(async () => {
      await store.init();
    });

    it('should import configs from exported data', async () => {
      const data: ExtensionConfigData[] = [
        { extensionId: 'ext-1', values: { key: 'value1' } },
        { extensionId: 'ext-2', values: { key: 'value2' } },
      ];

      store.importData(data);

      expect(store.hasConfig('ext-1')).toBe(true);
      expect(store.hasConfig('ext-2')).toBe(true);
      expect(store.getConfig('ext-1')).toEqual({ key: 'value1' });
      expect(store.getConfig('ext-2')).toEqual({ key: 'value2' });
    });

    it('should clear existing configs before import', async () => {
      await store.setConfig('existing', { key: 'old' });

      const data: ExtensionConfigData[] = [
        { extensionId: 'new', values: { key: 'new' } },
      ];

      store.importData(data);

      expect(store.hasConfig('existing')).toBe(false);
      expect(store.hasConfig('new')).toBe(true);
    });

    it('should persist imported data to localStorage', () => {
      const data: ExtensionConfigData[] = [
        { extensionId: 'ext-1', values: { key: 'value' } },
      ];

      store.importData(data);

      const stored = localStorage.getItem(STORAGE_KEY);
      const parsed = JSON.parse(stored!);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].extensionId).toBe('ext-1');
    });

    it('should handle import of empty array', () => {
      store.importData([]);

      expect(store.exportData()).toEqual([]);
    });

    it('should import encrypted secrets if present', async () => {
      // First, create encrypted data from one store
      await store.init('password');
      await store.setConfig('ext-1', { apiKey: 'secret-key', name: 'test' }, ['apiKey']);
      const exported = store.exportData();

      // Create new store with same password and import
      const newStore = new ExtensionConfigStore();
      await newStore.init('password');
      newStore.importData(exported);

      // Should be able to decrypt the secret
      const secret = await newStore.getSecret('ext-1', 'apiKey');
      expect(secret).toBe('secret-key');
    });
  });

  describe('encryption', () => {
    it('should use different ciphertext for same plaintext (due to random IV)', async () => {
      const store1 = new ExtensionConfigStore();
      await store1.init('password');
      await store1.setConfig('ext-1', { apiKey: 'same-secret' }, ['apiKey']);
      const exported1 = store1.exportData();

      const store2 = new ExtensionConfigStore();
      await store2.init('password');
      await store2.setConfig('ext-1', { apiKey: 'same-secret' }, ['apiKey']);
      const exported2 = store2.exportData();

      // Same password, same plaintext, but different ciphertext due to random IV
      expect(exported1[0].encryptedSecrets!.apiKey).not.toBe(
        exported2[0].encryptedSecrets!.apiKey,
      );
    });

    it('should not decrypt with wrong password', async () => {
      await store.init('correct-password');
      await store.setConfig('ext-1', { apiKey: 'secret' }, ['apiKey']);
      const exported = store.exportData();

      // Create new store with different password
      const newStore = new ExtensionConfigStore();
      await newStore.init('wrong-password');
      newStore.importData(exported);

      // Should fail to decrypt
      const secret = await newStore.getSecret('ext-1', 'apiKey');
      expect(secret).toBeNull();
    });

    it('should handle multiple secret fields', async () => {
      await store.init('password');
      await store.setConfig(
        'ext-1',
        {
          apiKey: 'key-123',
          secretToken: 'token-456',
          publicName: 'my-extension',
        },
        ['apiKey', 'secretToken'],
      );

      const config = store.getConfig('ext-1');
      expect(config).toEqual({ publicName: 'my-extension' });

      const apiKey = await store.getSecret('ext-1', 'apiKey');
      const secretToken = await store.getSecret('ext-1', 'secretToken');

      expect(apiKey).toBe('key-123');
      expect(secretToken).toBe('token-456');
    });

    it('should handle non-string values in secret fields gracefully', async () => {
      await store.init('password');
      // If secretFields includes a non-string value, it should be stored as plain value
      await store.setConfig(
        'ext-1',
        {
          apiKey: 'string-secret',
          numericField: 12345,
          name: 'test',
        },
        ['apiKey', 'numericField'], // numericField is number, not string
      );

      const config = store.getConfig('ext-1');
      // numericField should be in plain values since it's not a string
      expect(config).toEqual({ numericField: 12345, name: 'test' });

      const apiKey = await store.getSecret('ext-1', 'apiKey');
      expect(apiKey).toBe('string-secret');
    });
  });

  describe('localStorage error handling', () => {
    it('should handle localStorage.setItem failure gracefully', async () => {
      await store.init();

      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });

      // Should not throw, just silently fail
      await expect(store.setConfig('ext-1', { key: 'value' })).resolves.toBeUndefined();

      setItemSpy.mockRestore();
    });

    it('should handle localStorage.getItem failure gracefully', async () => {
      const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('SecurityError');
      });

      // Should not throw during init
      await expect(store.init()).resolves.toBeUndefined();
      expect(store.hasConfig('any')).toBe(false);

      getItemSpy.mockRestore();
    });
  });

  describe('edge cases', () => {
    beforeEach(async () => {
      await store.init();
    });

    it('should handle extension IDs with special characters', async () => {
      const specialId = 'ext-with/special:chars@test.com';
      await store.setConfig(specialId, { key: 'value' });

      expect(store.hasConfig(specialId)).toBe(true);
      expect(store.getConfig(specialId)).toEqual({ key: 'value' });
    });

    it('should handle empty string extension ID', async () => {
      await store.setConfig('', { key: 'value' });

      expect(store.hasConfig('')).toBe(true);
      expect(store.getConfig('')).toEqual({ key: 'value' });
    });

    it('should handle very long config values', async () => {
      const longValue = 'x'.repeat(10000);
      await store.setConfig('ext-1', { longKey: longValue });

      expect(store.getConfig('ext-1').longKey).toBe(longValue);
    });

    it('should handle unicode in config values', async () => {
      const unicodeValues = {
        emoji: 'Hello World',
        japanese: 'This is a test.',
        arabic: 'Arabic text here.',
      };

      await store.setConfig('ext-1', unicodeValues);
      expect(store.getConfig('ext-1')).toEqual(unicodeValues);
    });

    it('should handle unicode in encrypted secrets', async () => {
      await store.init('password');
      const unicodeSecret = 'Secret with unicode';

      await store.setConfig('ext-1', { apiKey: unicodeSecret }, ['apiKey']);

      const decrypted = await store.getSecret('ext-1', 'apiKey');
      expect(decrypted).toBe(unicodeSecret);
    });

    it('should handle multiple stores operating independently', async () => {
      const store2 = new ExtensionConfigStore();
      await store2.init();

      await store.setConfig('ext-1', { key: 'from-store1' });

      // store2 doesn't see store1's changes until it reloads from localStorage
      expect(store2.hasConfig('ext-1')).toBe(false);

      // After init, store2 loads from localStorage
      await store2.init();
      expect(store2.hasConfig('ext-1')).toBe(true);
    });
  });
});
