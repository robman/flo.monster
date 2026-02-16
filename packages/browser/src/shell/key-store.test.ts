import { describe, it, expect, beforeEach } from 'vitest';
import { KeyStore } from './key-store.js';

describe('KeyStore', () => {
  let store: KeyStore;

  beforeEach(() => {
    store = new KeyStore();
  });

  describe('addKey', () => {
    it('returns hash of the key', async () => {
      const hash = await store.addKey('sk-ant-test-key-12345', 'anthropic');

      expect(hash).toBeTruthy();
      expect(hash.length).toBe(64); // SHA-256 produces 64 hex chars
    });

    it('stores key with label', async () => {
      const hash = await store.addKey('sk-ant-test-key', 'anthropic', 'My API Key');

      const entry = store.getKeyEntry(hash);
      expect(entry?.label).toBe('My API Key');
      expect(entry?.provider).toBe('anthropic');
    });

    it('sets first key as default for provider', async () => {
      const hash = await store.addKey('sk-ant-first', 'anthropic');

      expect(store.getDefault('anthropic')).toBe(hash);
    });

    it('does not override default when adding second key', async () => {
      const hash1 = await store.addKey('sk-ant-first', 'anthropic');
      await store.addKey('sk-ant-second', 'anthropic');

      expect(store.getDefault('anthropic')).toBe(hash1);
    });
  });

  describe('getKey', () => {
    it('returns decrypted key', async () => {
      const originalKey = 'sk-ant-secret-key-xyz';
      const hash = await store.addKey(originalKey, 'anthropic');

      const retrieved = await store.getKey(hash);
      expect(retrieved).toBe(originalKey);
    });

    it('returns null for unknown hash', async () => {
      const result = await store.getKey('nonexistent-hash');
      expect(result).toBeNull();
    });
  });

  describe('removeKey', () => {
    it('deletes key entry', async () => {
      const hash = await store.addKey('sk-ant-to-delete', 'anthropic');

      store.removeKey(hash);

      expect(store.getKeyEntry(hash)).toBeUndefined();
      expect(await store.getKey(hash)).toBeNull();
    });

    it('clears default if removed key was default', async () => {
      const hash = await store.addKey('sk-ant-only-key', 'anthropic');

      store.removeKey(hash);

      expect(store.getDefault('anthropic')).toBeUndefined();
    });

    it('sets new default when removing current default', async () => {
      const hash1 = await store.addKey('sk-ant-first', 'anthropic');
      const hash2 = await store.addKey('sk-ant-second', 'anthropic');

      expect(store.getDefault('anthropic')).toBe(hash1);

      store.removeKey(hash1);

      expect(store.getDefault('anthropic')).toBe(hash2);
    });
  });

  describe('listKeys', () => {
    it('returns empty array initially', () => {
      expect(store.listKeys()).toEqual([]);
    });

    it('returns all stored key entries', async () => {
      await store.addKey('sk-ant-key1', 'anthropic', 'Key 1');
      await store.addKey('sk-openai-key1', 'openai', 'Key 2');

      const keys = store.listKeys();
      expect(keys.length).toBe(2);
      expect(keys.map(k => k.provider).sort()).toEqual(['anthropic', 'openai']);
    });
  });

  describe('setDefault/getDefault', () => {
    it('sets and gets default for provider', async () => {
      const hash1 = await store.addKey('sk-ant-first', 'anthropic');
      const hash2 = await store.addKey('sk-ant-second', 'anthropic');

      store.setDefault('anthropic', hash2);

      expect(store.getDefault('anthropic')).toBe(hash2);
    });

    it('does not set default if hash not found', async () => {
      await store.addKey('sk-ant-valid', 'anthropic');

      store.setDefault('anthropic', 'invalid-hash');

      // Should keep original default
      expect(store.getDefault('anthropic')).not.toBe('invalid-hash');
    });

    it('does not set default if provider mismatch', async () => {
      const hash = await store.addKey('sk-openai-key', 'openai');
      await store.addKey('sk-ant-key', 'anthropic');

      const originalDefault = store.getDefault('anthropic');
      store.setDefault('anthropic', hash); // Try to set openai key as anthropic default

      expect(store.getDefault('anthropic')).toBe(originalDefault);
    });
  });

  describe('hashKey', () => {
    it('produces consistent hash for same input', async () => {
      const key = 'sk-ant-test-key';

      const hash1 = await store.hashKey(key);
      const hash2 = await store.hashKey(key);

      expect(hash1).toBe(hash2);
    });

    it('produces different hash for different input', async () => {
      const hash1 = await store.hashKey('key-one');
      const hash2 = await store.hashKey('key-two');

      expect(hash1).not.toBe(hash2);
    });

    it('produces 64-character hex string', async () => {
      const hash = await store.hashKey('any-key');

      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('getKeysForProvider', () => {
    it('returns only keys for specified provider', async () => {
      await store.addKey('sk-ant-1', 'anthropic');
      await store.addKey('sk-ant-2', 'anthropic');
      await store.addKey('sk-openai-1', 'openai');

      const anthropicKeys = store.getKeysForProvider('anthropic');
      expect(anthropicKeys.length).toBe(2);
      expect(anthropicKeys.every(k => k.provider === 'anthropic')).toBe(true);

      const openaiKeys = store.getKeysForProvider('openai');
      expect(openaiKeys.length).toBe(1);
    });

    it('returns empty array for unknown provider', () => {
      expect(store.getKeysForProvider('unknown')).toEqual([]);
    });
  });

  describe('clear', () => {
    it('removes all keys and defaults', async () => {
      await store.addKey('sk-ant-1', 'anthropic');
      await store.addKey('sk-openai-1', 'openai');

      store.clear();

      expect(store.listKeys()).toEqual([]);
      expect(store.getDefault('anthropic')).toBeUndefined();
      expect(store.getDefault('openai')).toBeUndefined();
    });
  });

  describe('export/import', () => {
    it('exports and imports entries correctly', async () => {
      await store.addKey('sk-ant-1', 'anthropic', 'Key 1');
      await store.addKey('sk-openai-1', 'openai', 'Key 2');

      const exported = store.exportEntries();

      // Create new store and import
      const newStore = new KeyStore();
      newStore.importEntries(exported);

      expect(newStore.listKeys().length).toBe(2);
      expect(newStore.getDefault('anthropic')).toBe(store.getDefault('anthropic'));
    });

    it('preserves encrypted keys correctly', async () => {
      const originalKey = 'sk-ant-secret-test';
      const hash = await store.addKey(originalKey, 'anthropic');

      const exported = store.exportEntries();

      const newStore = new KeyStore();
      newStore.importEntries(exported);

      // Should be able to decrypt in new store (same passphrase)
      const retrieved = await newStore.getKey(hash);
      expect(retrieved).toBe(originalKey);
    });
  });

  describe('encryption security', () => {
    it('stores encrypted data, not plaintext', async () => {
      const key = 'sk-ant-visible-secret-key';
      const hash = await store.addKey(key, 'anthropic');

      const entry = store.getKeyEntry(hash);
      expect(entry?.encryptedKey).toBeTruthy();
      expect(entry?.encryptedKey).not.toContain('visible-secret');
    });

    it('uses unique IV for each key', async () => {
      await store.addKey('sk-ant-key-1', 'anthropic');
      await store.addKey('sk-ant-key-2', 'anthropic');

      const entries = store.listKeys();
      expect(entries[0].iv).not.toBe(entries[1].iv);
    });
  });

  describe('getDefaultKeyForProvider', () => {
    it('returns decrypted default key for provider', async () => {
      const originalKey = 'sk-ant-test-key-123';
      await store.addKey(originalKey, 'anthropic');

      const result = await store.getDefaultKeyForProvider('anthropic');
      expect(result).toBe(originalKey);
    });

    it('returns null if no key exists for provider', async () => {
      const result = await store.getDefaultKeyForProvider('anthropic');
      expect(result).toBeNull();
    });

    it('returns null if provider exists but no default set', async () => {
      // Add key then remove default manually
      const hash = await store.addKey('sk-ant-test', 'anthropic');
      store.removeKey(hash);

      const result = await store.getDefaultKeyForProvider('anthropic');
      expect(result).toBeNull();
    });

    it('returns correct key when multiple keys exist', async () => {
      const key1 = 'sk-ant-first-key';
      const key2 = 'sk-ant-second-key';
      const hash1 = await store.addKey(key1, 'anthropic');
      const hash2 = await store.addKey(key2, 'anthropic');

      // First key should be default
      const result = await store.getDefaultKeyForProvider('anthropic');
      expect(result).toBe(key1);

      // Change default to second key
      store.setDefault('anthropic', hash2);
      const result2 = await store.getDefaultKeyForProvider('anthropic');
      expect(result2).toBe(key2);
    });
  });

  describe('listProviders', () => {
    it('returns empty array when no keys', () => {
      expect(store.listProviders()).toEqual([]);
    });

    it('returns correct provider list', async () => {
      await store.addKey('sk-ant-key', 'anthropic');
      await store.addKey('sk-openai-key', 'openai');

      const providers = store.listProviders();
      expect(providers.sort()).toEqual(['anthropic', 'openai']);
    });

    it('does not duplicate providers with multiple keys', async () => {
      await store.addKey('sk-ant-key-1', 'anthropic');
      await store.addKey('sk-ant-key-2', 'anthropic');
      await store.addKey('sk-openai-key', 'openai');

      const providers = store.listProviders();
      expect(providers.length).toBe(2);
      expect(providers.sort()).toEqual(['anthropic', 'openai']);
    });

    it('updates when keys are removed', async () => {
      const hash = await store.addKey('sk-ant-key', 'anthropic');
      await store.addKey('sk-openai-key', 'openai');

      expect(store.listProviders().length).toBe(2);

      store.removeKey(hash);
      expect(store.listProviders()).toEqual(['openai']);
    });
  });
});
