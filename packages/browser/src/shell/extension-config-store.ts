/**
 * Extension Config Store
 *
 * Stores extension configuration values with encryption for sensitive fields.
 * Uses AES-GCM encryption similar to KeyStore for secret fields.
 */

import {
  deriveKey as sharedDeriveKey,
  encrypt as sharedEncrypt,
  decrypt as sharedDecrypt,
} from '../utils/encryption.js';

export interface ExtensionConfigData {
  extensionId: string;
  values: Record<string, unknown>;
  /** Encrypted secrets stored separately */
  encryptedSecrets?: Record<string, string>;
}

const STORAGE_KEY = 'flo-extension-configs';

export class ExtensionConfigStore {
  private configs = new Map<string, ExtensionConfigData>();
  private encryptionKey: CryptoKey | null = null;

  /**
   * Initialize the store, optionally with a password for secret encryption
   */
  async init(password?: string): Promise<void> {
    if (password) {
      this.encryptionKey = await this.deriveKey(password);
    }
    this.loadFromStorage();
  }

  /**
   * Get config values for an extension
   */
  getConfig(extensionId: string): Record<string, unknown> {
    const data = this.configs.get(extensionId);
    return data?.values || {};
  }

  /**
   * Check if config exists for an extension
   */
  hasConfig(extensionId: string): boolean {
    return this.configs.has(extensionId);
  }

  /**
   * Set config values for an extension
   * Secret fields are encrypted if encryption key is available
   */
  async setConfig(
    extensionId: string,
    values: Record<string, unknown>,
    secretFields: string[] = [],
  ): Promise<void> {
    const plainValues: Record<string, unknown> = {};
    const encryptedSecrets: Record<string, string> = {};

    for (const [key, value] of Object.entries(values)) {
      if (secretFields.includes(key) && typeof value === 'string' && this.encryptionKey) {
        encryptedSecrets[key] = await this.encrypt(value);
      } else {
        plainValues[key] = value;
      }
    }

    this.configs.set(extensionId, {
      extensionId,
      values: plainValues,
      encryptedSecrets: Object.keys(encryptedSecrets).length > 0 ? encryptedSecrets : undefined,
    });

    this.saveToStorage();
  }

  /**
   * Get a specific secret value (decrypted)
   */
  async getSecret(extensionId: string, key: string): Promise<string | null> {
    const data = this.configs.get(extensionId);
    if (!data?.encryptedSecrets?.[key]) return null;
    if (!this.encryptionKey) return null;

    try {
      return await this.decrypt(data.encryptedSecrets[key]);
    } catch {
      return null;
    }
  }

  /**
   * Get all config values including decrypted secrets
   */
  async getFullConfig(extensionId: string): Promise<Record<string, unknown>> {
    const data = this.configs.get(extensionId);
    if (!data) return {};

    const result = { ...data.values };

    if (data.encryptedSecrets && this.encryptionKey) {
      for (const [key, encrypted] of Object.entries(data.encryptedSecrets)) {
        try {
          result[key] = await this.decrypt(encrypted);
        } catch {
          // Skip secrets that can't be decrypted
        }
      }
    }

    return result;
  }

  /**
   * Delete config for an extension
   */
  deleteConfig(extensionId: string): void {
    this.configs.delete(extensionId);
    this.saveToStorage();
  }

  /**
   * Clear all extension configs
   */
  clear(): void {
    this.configs.clear();
    this.saveToStorage();
  }

  /**
   * Export all configs (for backup/migration)
   */
  exportData(): ExtensionConfigData[] {
    return Array.from(this.configs.values());
  }

  /**
   * Import configs (for restore)
   */
  importData(data: ExtensionConfigData[]): void {
    this.configs.clear();
    for (const item of data) {
      this.configs.set(item.extensionId, item);
    }
    this.saveToStorage();
  }

  private async deriveKey(password: string): Promise<CryptoKey> {
    const salt = new TextEncoder().encode('flo-extension-config-salt');
    return sharedDeriveKey(password, salt);
  }

  private async encrypt(plaintext: string): Promise<string> {
    if (!this.encryptionKey) throw new Error('No encryption key');

    const { iv, ciphertext } = await sharedEncrypt(plaintext, this.encryptionKey);

    // Combine IV and ciphertext, encode as base64
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(ciphertext), iv.length);

    return btoa(String.fromCharCode(...combined));
  }

  private async decrypt(encoded: string): Promise<string> {
    if (!this.encryptionKey) throw new Error('No encryption key');

    const combined = new Uint8Array(
      atob(encoded).split('').map(c => c.charCodeAt(0)),
    );

    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);

    return sharedDecrypt(iv, ciphertext.buffer, this.encryptionKey);
  }

  private loadFromStorage(): void {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const data = JSON.parse(stored) as ExtensionConfigData[];
        this.configs.clear();
        for (const item of data) {
          this.configs.set(item.extensionId, item);
        }
      }
    } catch {
      // Ignore storage errors
    }
  }

  private saveToStorage(): void {
    try {
      const data = Array.from(this.configs.values());
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // Ignore storage errors
    }
  }
}
