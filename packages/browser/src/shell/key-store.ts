import {
  deriveKey as sharedDeriveKey,
  encrypt as sharedEncrypt,
  decrypt as sharedDecrypt,
  arrayBufferToBase64,
  base64ToArrayBuffer,
} from '../utils/encryption.js';

const SALT = new Uint8Array([119, 101, 98, 104, 97, 114, 110, 101, 115, 115, 45, 107, 101, 121, 115, 116]);
const PASSPHRASE = 'awe-keystore-encryption';

export interface KeyEntry {
  hash: string;           // SHA-256 of key
  provider: string;       // 'anthropic', 'openai', etc.
  encryptedKey: string;   // AES-GCM encrypted (base64)
  iv: string;             // Initialization vector (base64)
  label?: string;         // User-friendly name
  createdAt: number;
}

export class KeyStore {
  private keys = new Map<string, KeyEntry>();
  private defaults = new Map<string, string>();  // provider -> hash
  private cryptoKey: CryptoKey | null = null;

  /**
   * Add a new API key to the store
   * @returns The hash of the key
   */
  async addKey(key: string, provider: string, label?: string): Promise<string> {
    const hash = await this.hashKey(key);

    // Encrypt the key
    const cryptoKey = await this.getCryptoKey();
    const { iv, ciphertext } = await sharedEncrypt(key, cryptoKey);

    const entry: KeyEntry = {
      hash,
      provider,
      encryptedKey: arrayBufferToBase64(ciphertext),
      iv: arrayBufferToBase64(iv),
      label,
      createdAt: Date.now(),
    };

    this.keys.set(hash, entry);

    // Set as default if first key for this provider
    if (!this.defaults.has(provider)) {
      this.defaults.set(provider, hash);
    }

    return hash;
  }

  /**
   * Get the decrypted key by hash
   */
  async getKey(hash: string): Promise<string | null> {
    const entry = this.keys.get(hash);
    if (!entry) return null;

    const cryptoKey = await this.getCryptoKey();
    const iv = base64ToArrayBuffer(entry.iv);
    const encrypted = base64ToArrayBuffer(entry.encryptedKey);

    try {
      return await sharedDecrypt(new Uint8Array(iv), encrypted, cryptoKey);
    } catch {
      return null;
    }
  }

  /**
   * Remove a key from the store
   */
  removeKey(hash: string): void {
    const entry = this.keys.get(hash);
    if (entry) {
      this.keys.delete(hash);

      // Clear default if this was it
      if (this.defaults.get(entry.provider) === hash) {
        this.defaults.delete(entry.provider);

        // Find another key for this provider to be default
        for (const [h, e] of this.keys) {
          if (e.provider === entry.provider) {
            this.defaults.set(entry.provider, h);
            break;
          }
        }
      }
    }
  }

  /**
   * Get key entry metadata (without decrypting)
   */
  getKeyEntry(hash: string): KeyEntry | undefined {
    return this.keys.get(hash);
  }

  /**
   * List all key entries (without decrypted keys)
   */
  listKeys(): KeyEntry[] {
    return Array.from(this.keys.values());
  }

  /**
   * Set the default key for a provider
   */
  setDefault(provider: string, hash: string): void {
    const entry = this.keys.get(hash);
    if (entry && entry.provider === provider) {
      this.defaults.set(provider, hash);
    }
  }

  /**
   * Get the default key hash for a provider
   */
  getDefault(provider: string): string | undefined {
    return this.defaults.get(provider);
  }

  /**
   * Hash a key using SHA-256
   */
  async hashKey(key: string): Promise<string> {
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(key));
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Get keys for a specific provider
   */
  getKeysForProvider(provider: string): KeyEntry[] {
    return Array.from(this.keys.values()).filter(e => e.provider === provider);
  }

  /**
   * Get the decrypted default key for a provider
   */
  async getDefaultKeyForProvider(provider: string): Promise<string | null> {
    const hash = this.defaults.get(provider);
    if (!hash) return null;
    return this.getKey(hash);
  }

  /**
   * List all providers that have keys stored
   */
  listProviders(): string[] {
    const providers = new Set<string>();
    for (const entry of this.keys.values()) {
      providers.add(entry.provider);
    }
    return Array.from(providers);
  }

  /**
   * Clear all keys
   */
  clear(): void {
    this.keys.clear();
    this.defaults.clear();
  }

  /**
   * Export entries for persistence (encrypted keys remain encrypted)
   */
  exportEntries(): { entries: KeyEntry[]; defaults: Record<string, string> } {
    return {
      entries: Array.from(this.keys.values()),
      defaults: Object.fromEntries(this.defaults),
    };
  }

  /**
   * Import entries from persistence
   */
  importEntries(data: { entries: KeyEntry[]; defaults: Record<string, string> }): void {
    this.keys.clear();
    this.defaults.clear();

    for (const entry of data.entries) {
      this.keys.set(entry.hash, entry);
    }

    for (const [provider, hash] of Object.entries(data.defaults)) {
      if (this.keys.has(hash)) {
        this.defaults.set(provider, hash);
      }
    }
  }

  private async getCryptoKey(): Promise<CryptoKey> {
    if (this.cryptoKey) return this.cryptoKey;

    this.cryptoKey = await sharedDeriveKey(PASSPHRASE, SALT);

    return this.cryptoKey;
  }
}
