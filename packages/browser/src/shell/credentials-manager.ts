import { hasStoredKey, retrieveApiKey, deleteApiKey } from './api-key.js';
import { registerServiceWorker, configureHubMode, ensureServiceWorkerReady, configureApiBaseUrl, configureProviderKeys } from './sw-registration.js';
import type { PersistenceLayer } from './persistence.js';
import type { HubClient } from './hub-client.js';
import type { KeyStore } from './key-store.js';
import {
  deriveKey,
  encrypt,
  decrypt,
  arrayBufferToBase64,
  base64ToArrayBuffer,
} from '../utils/encryption.js';
import type { SavedHubConnection } from './persistence.js';

export interface CredentialsManagerDeps {
  persistence: PersistenceLayer;
  hubClient: HubClient;
  keyStore: KeyStore;
}

/**
 * Manages API key setup, hub connection credentials, first-use flow,
 * and legacy key migration.
 */
export class CredentialsManager {
  constructor(private deps: CredentialsManagerDeps) {}

  private static readonly HUB_TOKEN_SALT = new Uint8Array([104, 117, 98, 45, 116, 111, 107, 101, 110, 45, 115, 97, 108, 116, 45, 118]);
  private static readonly HUB_TOKEN_PASSPHRASE = 'awe-hub-token-encryption';
  private hubTokenKey: CryptoKey | null = null;

  private async getHubTokenKey(): Promise<CryptoKey> {
    if (this.hubTokenKey) return this.hubTokenKey;
    this.hubTokenKey = await deriveKey(
      CredentialsManager.HUB_TOKEN_PASSPHRASE,
      CredentialsManager.HUB_TOKEN_SALT,
    );
    return this.hubTokenKey;
  }

  /**
   * Send all provider keys from the KeyStore to the Service Worker.
   */
  private async sendAllKeysToServiceWorker(): Promise<void> {
    const providers = this.deps.keyStore.listProviders();
    const keys: Record<string, string> = {};
    for (const provider of providers) {
      const key = await this.deps.keyStore.getDefaultKeyForProvider(provider);
      if (key) {
        keys[provider] = key;
      }
    }
    await configureProviderKeys(keys);
  }

  async encryptHubToken(token: string): Promise<{ encryptedToken: string; tokenIv: string }> {
    const key = await this.getHubTokenKey();
    const { iv, ciphertext } = await encrypt(token, key);
    return {
      encryptedToken: arrayBufferToBase64(ciphertext),
      tokenIv: arrayBufferToBase64(iv),
    };
  }

  async decryptHubToken(encryptedToken: string, tokenIv: string): Promise<string> {
    const key = await this.getHubTokenKey();
    const iv = new Uint8Array(base64ToArrayBuffer(tokenIv));
    const ciphertext = base64ToArrayBuffer(encryptedToken);
    return decrypt(iv, ciphertext, key);
  }

  /**
   * Resolve a hub connection's token, handling migration from plaintext to encrypted.
   */
  private async resolveHubToken(conn: SavedHubConnection): Promise<string | undefined> {
    // Prefer encrypted token
    if (conn.encryptedToken && conn.tokenIv) {
      try {
        return await this.decryptHubToken(conn.encryptedToken, conn.tokenIv);
      } catch (err) {
        console.warn('[flo] Failed to decrypt hub token:', err);
        return undefined;
      }
    }
    // Migrate from plaintext token
    if (conn.token) {
      const plainToken = conn.token;
      try {
        const encrypted = await this.encryptHubToken(plainToken);
        conn.encryptedToken = encrypted.encryptedToken;
        conn.tokenIv = encrypted.tokenIv;
        delete conn.token;
        // Re-save settings with encrypted token
        const settings = await this.deps.persistence.getSettings();
        await this.deps.persistence.saveSettings(settings);
      } catch (err) {
        console.warn('[flo] Failed to migrate hub token:', err);
      }
      return plainToken;
    }
    return undefined;
  }

  /**
   * Migrate legacy API key (stored directly) to the KeyStore.
   * Returns true if a migration occurred.
   */
  async migrateLegacyKey(): Promise<boolean> {
    const hasLegacyKey = await hasStoredKey();
    const hasKeyStoreKey = this.deps.keyStore.listProviders().length > 0;

    if (hasLegacyKey && !hasKeyStoreKey) {
      try {
        const legacyKey = await retrieveApiKey();
        if (legacyKey) {
          await this.deps.keyStore.addKey(legacyKey, 'anthropic', 'Migrated Key');
          // Save key store to persistence
          const settings = await this.deps.persistence.getSettings();
          settings.keyStoreData = this.deps.keyStore.exportEntries();
          await this.deps.persistence.saveSettings(settings);
          // Delete legacy key after successful migration
          await deleteApiKey();
          return true;
        }
      } catch (err) {
        console.warn('[flo] Failed to migrate legacy API key:', err);
      }
    }
    return false;
  }

  /**
   * Check if the user has any credentials (local keys or hub API source).
   */
  async hasCredentials(): Promise<boolean> {
    const hasAnyKey = this.deps.keyStore.listProviders().length > 0;
    const settings = await this.deps.persistence.getSettings();
    const hasHubApiSource = settings.apiKeySource === 'hub' && !!settings.hubForApiKey;
    return hasAnyKey || hasHubApiSource;
  }

  /**
   * Handle API key form submission.
   * Stores the key and marks the user as having seen the homepage.
   */
  async handleApiKeySubmit(key: string, provider: string = 'anthropic'): Promise<void> {
    await this.deps.keyStore.addKey(key, provider, 'Default Key');
    const settings = await this.deps.persistence.getSettings();
    settings.keyStoreData = this.deps.keyStore.exportEntries();
    settings.apiKeySource = 'local';
    settings.hasSeenHomepage = true;
    await this.deps.persistence.saveSettings(settings);
  }

  /**
   * Handle hub setup form submission.
   * Connects to the hub, configures the SW for hub mode, and saves settings.
   * Throws on failure.
   */
  async handleHubSetup(hubUrl: string, hubToken?: string): Promise<{ sharedProviders: string[] }> {
    // Try to connect to hub
    const conn = await this.deps.hubClient.connect(hubUrl, 'Setup Hub', hubToken);

    const hasSharedKeys = conn.sharedProviders && conn.sharedProviders.length > 0;

    if (hasSharedKeys) {
      // Hub shares API keys — configure SW for hub-routed API calls
      await ensureServiceWorkerReady();
      await configureHubMode(true, conn.httpApiUrl, hubToken);
      console.log('[flo] Hub mode configured:', conn.httpApiUrl);
    }

    // Save settings
    const settings = await this.deps.persistence.getSettings();
    settings.apiKeySource = hasSharedKeys ? 'hub' : 'local';
    if (hasSharedKeys) settings.hubForApiKey = conn.id;
    settings.hubConnections = settings.hubConnections || [];
    if (!settings.hubConnections.find(c => c.url === hubUrl)) {
      const savedConn: SavedHubConnection = { url: hubUrl, name: 'Setup Hub' };
      if (hubToken) {
        const encrypted = await this.encryptHubToken(hubToken);
        savedConn.encryptedToken = encrypted.encryptedToken;
        savedConn.tokenIv = encrypted.tokenIv;
      }
      settings.hubConnections.push(savedConn);
    }
    settings.hasSeenHomepage = true;
    await this.deps.persistence.saveSettings(settings);

    return { sharedProviders: conn.sharedProviders || [] };
  }

  /**
   * Initialize the app's API access based on saved settings.
   * Either registers SW with a local key or configures hub mode.
   */
  async initializeApiAccess(): Promise<void> {
    const settings = await this.deps.persistence.getSettings();

    let hubConfigured = false;

    if (settings.apiKeySource === 'hub') {
      // Hub mode: register SW without local API key, then configure for hub
      try {
        await ensureServiceWorkerReady();

        // Reconnect to hub and configure SW for hub routing
        const hubConn = settings.hubConnections?.find(c => c.url);
        if (hubConn) {
          const token = await this.resolveHubToken(hubConn);
          const conn = await this.deps.hubClient.connect(hubConn.url, hubConn.name, token);
          await configureHubMode(true, conn.httpApiUrl, token);
          hubConfigured = true;
          console.log('[flo] Hub mode configured:', conn.httpApiUrl);
        }
      } catch (err) {
        console.error('[flo] Failed to initialize hub mode:', err);
      }
    }

    if (!hubConfigured) {
      // Local key mode (or hub mode that failed to connect):
      // disable hub mode in SW, send all provider keys as fallback
      try {
        await ensureServiceWorkerReady();
        await configureHubMode(false);
        await this.sendAllKeysToServiceWorker();
        console.log('[flo] Service worker configured (local key mode)');
      } catch (err) {
        console.warn('[flo] Service worker configuration failed:', err);
      }
    }

    // Configure API base URL if set in settings
    if (settings.apiBaseUrl) {
      configureApiBaseUrl(settings.apiBaseUrl);
    }

    // Auto-connect to saved hub connections (for tools, not API)
    if (!hubConfigured && settings.hubConnections && settings.hubConnections.length > 0) {
      for (const conn of settings.hubConnections) {
        try {
          const token = await this.resolveHubToken(conn);
          await this.deps.hubClient.connect(conn.url, conn.name, token);
          console.log('[flo] Auto-connected to hub:', conn.name);
        } catch (err) {
          console.warn('[flo] Failed to auto-connect to hub:', conn.name, err);
        }
      }
    }
  }

  /**
   * Switch from hub mode to local keys.
   * Clears hub routing in SW, sends all local keys, and updates settings.
   * Called when user disconnects a hub that was the API key source,
   * or toggles key source to 'local' in settings.
   */
  async switchToLocalKeys(): Promise<void> {
    await configureHubMode(false);
    await this.sendAllKeysToServiceWorker();
    const settings = await this.deps.persistence.getSettings();
    settings.apiKeySource = 'local';
    settings.hubForApiKey = undefined;
    await this.deps.persistence.saveSettings(settings);
    console.log('[flo] Switched to local keys');
  }

  /**
   * Handle API key change from settings panel.
   */
  async handleApiKeyChange(key: string, provider: string = 'anthropic'): Promise<void> {
    await this.deps.keyStore.addKey(key, provider);
    const settings = await this.deps.persistence.getSettings();
    settings.keyStoreData = this.deps.keyStore.exportEntries();
    await this.deps.persistence.saveSettings(settings);
    try {
      // Only clear stale hub mode if user is NOT actively using hub keys.
      // A Mode 3 user may add a local key without wanting to switch routing.
      if (settings.apiKeySource !== 'hub') {
        await configureHubMode(false);
      }
      await this.sendAllKeysToServiceWorker();
    } catch (err) {
      console.warn('[flo] Failed to configure SW:', err);
    }
  }

  /**
   * Handle API key deletion from settings panel.
   */
  async handleApiKeyDelete(provider?: string, hash?: string): Promise<void> {
    if (hash) {
      // Delete specific key
      this.deps.keyStore.removeKey(hash);
      const settings = await this.deps.persistence.getSettings();
      settings.keyStoreData = this.deps.keyStore.exportEntries();
      await this.deps.persistence.saveSettings(settings);
      // If no keys left, reload
      if (this.deps.keyStore.listProviders().length === 0) {
        await this.deps.persistence.clearAll();
        window.location.reload();
      }
    } else {
      // Delete all keys
      this.deps.keyStore.clear();
      await this.deps.persistence.clearAll();
      window.location.reload();
    }
  }

  /**
   * Set up the API key form and hub setup form event handlers.
   */
  setupCredentialForms(
    overlay: HTMLElement,
    form: HTMLFormElement,
    input: HTMLInputElement,
    onCredentialsReady: () => Promise<void>,
  ): void {
    // Close button: dismiss overlay without saving
    const closeBtn = document.getElementById('api-key-overlay-close');
    closeBtn?.addEventListener('click', () => {
      overlay.hidden = true;
    });

    // Provider select: update placeholder on change
    const providerSelect = document.getElementById('api-key-provider') as HTMLSelectElement | null;
    const placeholders: Record<string, string> = {
      anthropic: 'sk-ant-...',
      openai: 'sk-...',
      gemini: 'AI...',
    };
    providerSelect?.addEventListener('change', () => {
      input.placeholder = placeholders[providerSelect.value] || 'API key';
    });

    // Handle API key form
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const key = input.value.trim();
      if (!key) return;
      const provider = providerSelect?.value || 'anthropic';
      await this.handleApiKeySubmit(key, provider);
      overlay.hidden = true;
      await onCredentialsReady();
    });

    // Setup tabs switching
    const tabOwnKey = document.getElementById('tab-own-key');
    const tabHub = document.getElementById('tab-hub');
    const hubSetupForm = document.getElementById('hub-setup-form') as HTMLFormElement;

    tabOwnKey?.addEventListener('click', () => {
      tabOwnKey.classList.add('setup-tab--active');
      tabHub?.classList.remove('setup-tab--active');
      form.hidden = false;
      hubSetupForm.hidden = true;
    });

    tabHub?.addEventListener('click', () => {
      tabHub.classList.add('setup-tab--active');
      tabOwnKey?.classList.remove('setup-tab--active');
      form.hidden = true;
      hubSetupForm.hidden = false;
    });

    // Handle hub setup form
    hubSetupForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const urlInput = document.getElementById('hub-url-input') as HTMLInputElement;
      const tokenInput = document.getElementById('hub-token-input') as HTMLInputElement;
      const statusDiv = document.getElementById('hub-status')!;

      const hubUrl = urlInput.value.trim();
      const hubToken = tokenInput.value.trim() || undefined;

      if (!hubUrl) return;

      statusDiv.textContent = 'Connecting...';
      statusDiv.className = 'setup-form__status';

      try {
        const result = await this.handleHubSetup(hubUrl, hubToken);

        if (result.sharedProviders.length === 0) {
          // Hub connected but no shared keys — guide user to enter their own
          statusDiv.textContent = 'Hub connected! Enter an API key below to start using agents.';
          statusDiv.className = 'setup-form__status setup-form__status--success';
          // Switch to Own Key tab
          tabOwnKey?.click();
        } else {
          // Hub shares API keys — all done
          statusDiv.textContent = `Connected! Shared providers: ${result.sharedProviders.join(', ')}`;
          statusDiv.className = 'setup-form__status setup-form__status--success';
          overlay.hidden = true;
          await onCredentialsReady();
        }
      } catch (err) {
        statusDiv.textContent = `Failed to connect: ${(err as Error).message}`;
        statusDiv.className = 'setup-form__status setup-form__status--error';
      }
    });
  }
}
