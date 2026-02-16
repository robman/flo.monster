/**
 * Shared encryption utilities using PBKDF2 + AES-GCM.
 *
 * Extracted from duplicated patterns in api-key, key-store,
 * and extension-config-store.
 */

/**
 * Derive an AES-GCM-256 CryptoKey from a passphrase and salt
 * using PBKDF2 with 100,000 iterations of SHA-256.
 */
export async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypt a plaintext string with an AES-GCM CryptoKey.
 * Returns the IV and ciphertext as Uint8Arrays.
 */
export async function encrypt(
  data: string,
  key: CryptoKey,
): Promise<{ iv: Uint8Array; ciphertext: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(data),
  );
  return { iv, ciphertext };
}

/**
 * Decrypt ciphertext with an AES-GCM CryptoKey and IV.
 * Returns the plaintext string.
 */
export async function decrypt(
  iv: Uint8Array,
  ciphertext: ArrayBuffer,
  key: CryptoKey,
): Promise<string> {
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(decrypted);
}

/**
 * Convert an ArrayBuffer or Uint8Array to a base64 string.
 */
export function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Convert a base64 string to an ArrayBuffer.
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
