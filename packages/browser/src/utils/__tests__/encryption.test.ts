/**
 * Tests for encryption utility functions
 */

import { describe, it, expect } from 'vitest';
import {
  deriveKey,
  encrypt,
  decrypt,
  arrayBufferToBase64,
  base64ToArrayBuffer,
} from '../encryption.js';

describe('encryption', () => {
  const TEST_SALT = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  const TEST_PASSPHRASE = 'test-passphrase';

  describe('deriveKey', () => {
    it('should derive a CryptoKey from a passphrase and salt', async () => {
      const key = await deriveKey(TEST_PASSPHRASE, TEST_SALT);
      expect(key).toBeDefined();
      expect(key.type).toBe('secret');
      expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    });

    it('should derive the same key for the same passphrase and salt', async () => {
      const key1 = await deriveKey(TEST_PASSPHRASE, TEST_SALT);
      const key2 = await deriveKey(TEST_PASSPHRASE, TEST_SALT);

      // Both keys should encrypt/decrypt the same data successfully
      const { iv, ciphertext } = await encrypt('test', key1);
      const result = await decrypt(iv, ciphertext, key2);
      expect(result).toBe('test');
    });

    it('should derive different keys for different passphrases', async () => {
      const key1 = await deriveKey('passphrase-1', TEST_SALT);
      const key2 = await deriveKey('passphrase-2', TEST_SALT);

      // Encrypt with key1, try to decrypt with key2 - should fail
      const { iv, ciphertext } = await encrypt('test', key1);
      await expect(decrypt(iv, ciphertext, key2)).rejects.toThrow();
    });

    it('should derive different keys for different salts', async () => {
      const salt1 = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const salt2 = new Uint8Array([16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
      const key1 = await deriveKey(TEST_PASSPHRASE, salt1);
      const key2 = await deriveKey(TEST_PASSPHRASE, salt2);

      const { iv, ciphertext } = await encrypt('test', key1);
      await expect(decrypt(iv, ciphertext, key2)).rejects.toThrow();
    });
  });

  describe('encrypt and decrypt', () => {
    let key: CryptoKey;

    it('should encrypt and decrypt a simple string', async () => {
      key = await deriveKey(TEST_PASSPHRASE, TEST_SALT);
      const { iv, ciphertext } = await encrypt('hello world', key);
      const result = await decrypt(iv, ciphertext, key);
      expect(result).toBe('hello world');
    });

    it('should encrypt and decrypt an empty string', async () => {
      key = await deriveKey(TEST_PASSPHRASE, TEST_SALT);
      const { iv, ciphertext } = await encrypt('', key);
      const result = await decrypt(iv, ciphertext, key);
      expect(result).toBe('');
    });

    it('should encrypt and decrypt a long string', async () => {
      key = await deriveKey(TEST_PASSPHRASE, TEST_SALT);
      const longString = 'x'.repeat(10000);
      const { iv, ciphertext } = await encrypt(longString, key);
      const result = await decrypt(iv, ciphertext, key);
      expect(result).toBe(longString);
    });

    it('should encrypt and decrypt unicode text', async () => {
      key = await deriveKey(TEST_PASSPHRASE, TEST_SALT);
      const unicode = 'Hello World \u00e9\u00e8\u00ea \u4f60\u597d';
      const { iv, ciphertext } = await encrypt(unicode, key);
      const result = await decrypt(iv, ciphertext, key);
      expect(result).toBe(unicode);
    });

    it('should produce a 12-byte IV', async () => {
      key = await deriveKey(TEST_PASSPHRASE, TEST_SALT);
      const { iv } = await encrypt('test', key);
      expect(iv).toBeInstanceOf(Uint8Array);
      expect(iv.length).toBe(12);
    });

    it('should produce different ciphertext for the same plaintext (random IV)', async () => {
      key = await deriveKey(TEST_PASSPHRASE, TEST_SALT);
      const { iv: iv1, ciphertext: ct1 } = await encrypt('same text', key);
      const { iv: iv2, ciphertext: ct2 } = await encrypt('same text', key);

      // IVs should be different (random)
      const iv1Str = Array.from(iv1).join(',');
      const iv2Str = Array.from(iv2).join(',');
      expect(iv1Str).not.toBe(iv2Str);

      // Both should decrypt to the same value
      expect(await decrypt(iv1, ct1, key)).toBe('same text');
      expect(await decrypt(iv2, ct2, key)).toBe('same text');
    });

    it('should fail to decrypt with wrong key', async () => {
      const key1 = await deriveKey('correct', TEST_SALT);
      const key2 = await deriveKey('wrong', TEST_SALT);
      const { iv, ciphertext } = await encrypt('secret', key1);
      await expect(decrypt(iv, ciphertext, key2)).rejects.toThrow();
    });

    it('should fail to decrypt with wrong IV', async () => {
      key = await deriveKey(TEST_PASSPHRASE, TEST_SALT);
      const { ciphertext } = await encrypt('secret', key);
      const wrongIv = new Uint8Array(12); // all zeros
      await expect(decrypt(wrongIv, ciphertext, key)).rejects.toThrow();
    });

    it('should fail to decrypt corrupted ciphertext', async () => {
      key = await deriveKey(TEST_PASSPHRASE, TEST_SALT);
      const { iv, ciphertext } = await encrypt('secret', key);
      // Corrupt the ciphertext
      const corrupted = new Uint8Array(ciphertext);
      corrupted[0] = corrupted[0] ^ 0xff;
      await expect(decrypt(iv, corrupted.buffer, key)).rejects.toThrow();
    });
  });

  describe('arrayBufferToBase64', () => {
    it('should convert an empty buffer to empty string', () => {
      const result = arrayBufferToBase64(new Uint8Array([]));
      expect(result).toBe('');
    });

    it('should convert a Uint8Array to base64', () => {
      const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      const result = arrayBufferToBase64(bytes);
      expect(result).toBe(btoa('Hello'));
    });

    it('should convert an ArrayBuffer to base64', () => {
      const bytes = new Uint8Array([72, 101, 108, 108, 111]);
      const result = arrayBufferToBase64(bytes.buffer);
      expect(result).toBe(btoa('Hello'));
    });

    it('should handle binary data', () => {
      const bytes = new Uint8Array([0, 128, 255]);
      const b64 = arrayBufferToBase64(bytes);
      // Convert back and verify
      const decoded = base64ToArrayBuffer(b64);
      expect(new Uint8Array(decoded)).toEqual(bytes);
    });
  });

  describe('base64ToArrayBuffer', () => {
    it('should convert empty string to empty buffer', () => {
      const result = base64ToArrayBuffer('');
      expect(new Uint8Array(result).length).toBe(0);
    });

    it('should convert a base64 string to ArrayBuffer', () => {
      const b64 = btoa('Hello');
      const result = base64ToArrayBuffer(b64);
      const bytes = new Uint8Array(result);
      expect(Array.from(bytes)).toEqual([72, 101, 108, 108, 111]);
    });

    it('should round-trip with arrayBufferToBase64', () => {
      const original = new Uint8Array([0, 1, 2, 128, 254, 255]);
      const b64 = arrayBufferToBase64(original);
      const result = new Uint8Array(base64ToArrayBuffer(b64));
      expect(result).toEqual(original);
    });
  });

  describe('integration: encrypt/decrypt with base64 encoding', () => {
    it('should support the key-store pattern (separate IV and ciphertext as base64)', async () => {
      const key = await deriveKey(TEST_PASSPHRASE, TEST_SALT);
      const plaintext = 'my-api-key-12345';

      // Encrypt
      const { iv, ciphertext } = await encrypt(plaintext, key);

      // Store as base64 (like KeyStore does)
      const ivB64 = arrayBufferToBase64(iv);
      const ctB64 = arrayBufferToBase64(ciphertext);

      // Restore from base64 and decrypt
      const restoredIv = new Uint8Array(base64ToArrayBuffer(ivB64));
      const restoredCt = base64ToArrayBuffer(ctB64);
      const result = await decrypt(restoredIv, restoredCt, key);
      expect(result).toBe(plaintext);
    });

    it('should support the api-key pattern (IV and data as number arrays)', async () => {
      const key = await deriveKey(TEST_PASSPHRASE, TEST_SALT);
      const plaintext = 'sk-ant-api03-xxx';

      // Encrypt
      const { iv, ciphertext } = await encrypt(plaintext, key);

      // Store as number arrays (like api-key.ts does)
      const ivArray = Array.from(iv);
      const dataArray = Array.from(new Uint8Array(ciphertext));

      // Restore from number arrays and decrypt
      const restoredIv = new Uint8Array(ivArray);
      const restoredCt = new Uint8Array(dataArray).buffer;
      const result = await decrypt(restoredIv, restoredCt, key);
      expect(result).toBe(plaintext);
    });

    it('should support the extension-config pattern (combined IV+ciphertext as base64)', async () => {
      const key = await deriveKey(TEST_PASSPHRASE, TEST_SALT);
      const plaintext = 'extension-secret';

      // Encrypt
      const { iv, ciphertext } = await encrypt(plaintext, key);

      // Combine IV and ciphertext as base64 (like ExtensionConfigStore does)
      const combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(ciphertext), iv.length);
      const encoded = btoa(String.fromCharCode(...combined));

      // Decode the combined string
      const decoded = new Uint8Array(
        atob(encoded).split('').map(c => c.charCodeAt(0)),
      );
      const restoredIv = decoded.slice(0, 12);
      const restoredCt = decoded.slice(12);

      const result = await decrypt(restoredIv, restoredCt.buffer, key);
      expect(result).toBe(plaintext);
    });
  });
});
