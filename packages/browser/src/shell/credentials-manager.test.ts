import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CredentialsManager } from './credentials-manager.js';

// Mock sw-registration module
vi.mock('./sw-registration.js', () => ({
  registerServiceWorker: vi.fn().mockResolvedValue({}),
  ensureServiceWorkerReady: vi.fn().mockResolvedValue({}),
  configureHubMode: vi.fn().mockResolvedValue(undefined),
  configureApiBaseUrl: vi.fn(),
  configureProviderKeys: vi.fn().mockResolvedValue(undefined),
}));

// Mock api-key module
vi.mock('./api-key.js', () => ({
  hasStoredKey: vi.fn().mockResolvedValue(false),
  retrieveApiKey: vi.fn().mockResolvedValue(null),
  deleteApiKey: vi.fn().mockResolvedValue(undefined),
}));

// Mock encryption module
vi.mock('../utils/encryption.js', () => ({
  deriveKey: vi.fn().mockResolvedValue({}),
  encrypt: vi.fn().mockResolvedValue({ iv: new Uint8Array(12), ciphertext: new ArrayBuffer(0) }),
  decrypt: vi.fn().mockResolvedValue('decrypted-token'),
  arrayBufferToBase64: vi.fn().mockReturnValue('base64'),
  base64ToArrayBuffer: vi.fn().mockReturnValue(new ArrayBuffer(0)),
}));

import { configureProviderKeys, configureHubMode, ensureServiceWorkerReady } from './sw-registration.js';

function createMockDeps() {
  const keys = new Map<string, { provider: string; key: string }>();
  const defaults = new Map<string, string>();

  return {
    persistence: {
      getSettings: vi.fn().mockResolvedValue({}),
      saveSettings: vi.fn().mockResolvedValue(undefined),
      clearAll: vi.fn().mockResolvedValue(undefined),
    },
    hubClient: {
      connect: vi.fn().mockResolvedValue({ id: 'hub1', httpApiUrl: 'http://localhost:8765', sharedProviders: ['anthropic'] }),
      disconnect: vi.fn(),
    },
    keyStore: {
      addKey: vi.fn().mockResolvedValue(undefined),
      removeKey: vi.fn(),
      clear: vi.fn(),
      exportEntries: vi.fn().mockReturnValue([]),
      importEntries: vi.fn(),
      listProviders: vi.fn().mockReturnValue([]),
      getDefaultKeyForProvider: vi.fn().mockResolvedValue(null),
      getKeysForProvider: vi.fn().mockReturnValue([]),
    },
  };
}

describe('CredentialsManager', () => {
  let cm: CredentialsManager;
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
    cm = new CredentialsManager(deps as any);
  });

  describe('handleApiKeyChange', () => {
    it('sends all provider keys to SW when anthropic key changes', async () => {
      deps.keyStore.listProviders.mockReturnValue(['anthropic']);
      deps.keyStore.getDefaultKeyForProvider.mockResolvedValue('sk-ant-test');

      await cm.handleApiKeyChange('sk-ant-test', 'anthropic');

      expect(configureProviderKeys).toHaveBeenCalledWith({ anthropic: 'sk-ant-test' });
    });

    it('sends all provider keys to SW when openai key changes', async () => {
      deps.keyStore.listProviders.mockReturnValue(['anthropic', 'openai']);
      deps.keyStore.getDefaultKeyForProvider.mockImplementation(async (provider: string) => {
        if (provider === 'anthropic') return 'sk-ant-test';
        if (provider === 'openai') return 'sk-openai-test';
        return null;
      });

      await cm.handleApiKeyChange('sk-openai-test', 'openai');

      expect(configureProviderKeys).toHaveBeenCalledWith({
        anthropic: 'sk-ant-test',
        openai: 'sk-openai-test',
      });
    });

    it('sends all provider keys including gemini', async () => {
      deps.keyStore.listProviders.mockReturnValue(['anthropic', 'openai', 'gemini']);
      deps.keyStore.getDefaultKeyForProvider.mockImplementation(async (provider: string) => {
        const keys: Record<string, string> = {
          anthropic: 'sk-ant-test',
          openai: 'sk-openai-test',
          gemini: 'AIza-test',
        };
        return keys[provider] || null;
      });

      await cm.handleApiKeyChange('AIza-test', 'gemini');

      expect(configureProviderKeys).toHaveBeenCalledWith({
        anthropic: 'sk-ant-test',
        openai: 'sk-openai-test',
        gemini: 'AIza-test',
      });
    });

    it('handles SW send failure gracefully', async () => {
      deps.keyStore.listProviders.mockReturnValue(['openai']);
      deps.keyStore.getDefaultKeyForProvider.mockResolvedValue('sk-test');
      vi.mocked(configureProviderKeys).mockRejectedValueOnce(new Error('No SW'));

      // Should not throw
      await cm.handleApiKeyChange('sk-test', 'openai');
      expect(deps.keyStore.addKey).toHaveBeenCalledWith('sk-test', 'openai');
    });

    it('clears stale hub mode when adding a local key in local mode', async () => {
      deps.persistence.getSettings.mockResolvedValue({ apiKeySource: 'local' });
      deps.keyStore.listProviders.mockReturnValue(['anthropic']);
      deps.keyStore.getDefaultKeyForProvider.mockResolvedValue('sk-ant-test');

      await cm.handleApiKeyChange('sk-ant-test', 'anthropic');

      // Should clear hub mode since user is in local key mode
      expect(configureHubMode).toHaveBeenCalledWith(false);
      expect(configureProviderKeys).toHaveBeenCalledWith({ anthropic: 'sk-ant-test' });
    });

    it('preserves hub mode when adding a local key in hub mode (Mode 3)', async () => {
      deps.persistence.getSettings.mockResolvedValue({ apiKeySource: 'hub', hubForApiKey: 'hub1' });
      deps.keyStore.listProviders.mockReturnValue(['anthropic', 'openai']);
      deps.keyStore.getDefaultKeyForProvider.mockImplementation(async (provider: string) => {
        if (provider === 'anthropic') return 'sk-ant-test';
        if (provider === 'openai') return 'sk-openai-test';
        return null;
      });

      await cm.handleApiKeyChange('sk-openai-test', 'openai');

      // Should NOT clear hub mode — user is in Mode 3
      expect(configureHubMode).not.toHaveBeenCalled();
      // Should still send keys to SW (they're available as fallback)
      expect(configureProviderKeys).toHaveBeenCalledWith({
        anthropic: 'sk-ant-test',
        openai: 'sk-openai-test',
      });
    });
  });

  describe('switchToLocalKeys', () => {
    it('clears hub mode, sends local keys, and updates settings', async () => {
      deps.keyStore.listProviders.mockReturnValue(['anthropic', 'openai']);
      deps.keyStore.getDefaultKeyForProvider.mockImplementation(async (provider: string) => {
        if (provider === 'anthropic') return 'sk-ant-test';
        if (provider === 'openai') return 'sk-openai-test';
        return null;
      });
      deps.persistence.getSettings.mockResolvedValue({
        apiKeySource: 'hub',
        hubForApiKey: 'hub1',
      });

      await cm.switchToLocalKeys();

      // Should clear hub mode in SW
      expect(configureHubMode).toHaveBeenCalledWith(false);
      // Should send all local keys to SW
      expect(configureProviderKeys).toHaveBeenCalledWith({
        anthropic: 'sk-ant-test',
        openai: 'sk-openai-test',
      });
      // Should update settings to local
      expect(deps.persistence.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKeySource: 'local',
          hubForApiKey: undefined,
        }),
      );
    });

    it('works even with no local keys', async () => {
      deps.keyStore.listProviders.mockReturnValue([]);
      deps.persistence.getSettings.mockResolvedValue({
        apiKeySource: 'hub',
        hubForApiKey: 'hub1',
      });

      await cm.switchToLocalKeys();

      expect(configureHubMode).toHaveBeenCalledWith(false);
      expect(configureProviderKeys).toHaveBeenCalledWith({});
      expect(deps.persistence.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKeySource: 'local',
          hubForApiKey: undefined,
        }),
      );
    });
  });

  describe('handleHubSetup', () => {
    it('configures hub mode when hub has shared providers', async () => {
      deps.hubClient.connect.mockResolvedValue({
        id: 'hub1',
        httpApiUrl: 'https://hub.example.com:8765',
        sharedProviders: ['anthropic'],
      });

      const result = await cm.handleHubSetup('wss://hub.example.com:8765');

      expect(result.sharedProviders).toEqual(['anthropic']);
      expect(ensureServiceWorkerReady).toHaveBeenCalled();
      expect(configureHubMode).toHaveBeenCalledWith(true, 'https://hub.example.com:8765', undefined);
      expect(deps.persistence.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKeySource: 'hub',
          hubForApiKey: 'hub1',
          hasSeenHomepage: true,
        }),
      );
    });

    it('does not throw when hub has no shared providers', async () => {
      deps.hubClient.connect.mockResolvedValue({
        id: 'hub1',
        httpApiUrl: 'https://hub.example.com:8765',
        sharedProviders: [],
      });

      const result = await cm.handleHubSetup('wss://hub.example.com:8765');

      expect(result.sharedProviders).toEqual([]);
      // Should NOT configure hub mode
      expect(configureHubMode).not.toHaveBeenCalled();
      // Should NOT disconnect
      expect(deps.hubClient.disconnect).not.toHaveBeenCalled();
      // Should save with local apiKeySource
      expect(deps.persistence.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKeySource: 'local',
          hasSeenHomepage: true,
        }),
      );
    });

    it('saves hub connection when no shared providers', async () => {
      deps.hubClient.connect.mockResolvedValue({
        id: 'hub1',
        httpApiUrl: 'https://hub.example.com:8765',
        sharedProviders: [],
      });

      await cm.handleHubSetup('wss://hub.example.com:8765');

      const savedSettings = deps.persistence.saveSettings.mock.calls[0][0];
      expect(savedSettings.hubConnections).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ url: 'wss://hub.example.com:8765', name: 'Setup Hub' }),
        ]),
      );
    });

    it('handles undefined sharedProviders as empty', async () => {
      deps.hubClient.connect.mockResolvedValue({
        id: 'hub1',
        httpApiUrl: 'https://hub.example.com:8765',
        sharedProviders: undefined,
      });

      const result = await cm.handleHubSetup('wss://hub.example.com:8765');

      expect(result.sharedProviders).toEqual([]);
      expect(configureHubMode).not.toHaveBeenCalled();
      expect(deps.hubClient.disconnect).not.toHaveBeenCalled();
    });
  });

  describe('initializeApiAccess', () => {
    it('sends all provider keys to SW in local key mode', async () => {
      deps.persistence.getSettings.mockResolvedValue({ apiKeySource: 'local' });
      deps.keyStore.listProviders.mockReturnValue(['anthropic', 'openai']);
      deps.keyStore.getDefaultKeyForProvider.mockImplementation(async (provider: string) => {
        if (provider === 'anthropic') return 'sk-ant-init';
        if (provider === 'openai') return 'sk-openai-init';
        return null;
      });

      await cm.initializeApiAccess();

      expect(ensureServiceWorkerReady).toHaveBeenCalled();
      expect(configureProviderKeys).toHaveBeenCalledWith({
        anthropic: 'sk-ant-init',
        openai: 'sk-openai-init',
      });
    });

    it('handles no keys gracefully in local mode', async () => {
      deps.persistence.getSettings.mockResolvedValue({ apiKeySource: 'local' });
      deps.keyStore.listProviders.mockReturnValue([]);

      await cm.initializeApiAccess();

      expect(ensureServiceWorkerReady).toHaveBeenCalled();
      expect(configureHubMode).toHaveBeenCalledWith(false);
      // configureProviderKeys called with empty object
      expect(configureProviderKeys).toHaveBeenCalledWith({});
    });

    it('disables hub mode in SW when in local key mode', async () => {
      deps.persistence.getSettings.mockResolvedValue({ apiKeySource: 'local' });
      deps.keyStore.listProviders.mockReturnValue(['anthropic']);
      deps.keyStore.getDefaultKeyForProvider.mockResolvedValue('sk-ant-test');

      await cm.initializeApiAccess();

      expect(configureHubMode).toHaveBeenCalledWith(false);
    });

    it('falls back to local keys when hub apiKeySource but no hubConnections', async () => {
      deps.persistence.getSettings.mockResolvedValue({
        apiKeySource: 'hub',
        hubConnections: [],
      });
      deps.keyStore.listProviders.mockReturnValue(['anthropic', 'openai']);
      deps.keyStore.getDefaultKeyForProvider.mockImplementation(async (provider: string) => {
        if (provider === 'anthropic') return 'sk-ant-test';
        if (provider === 'openai') return 'sk-openai-test';
        return null;
      });

      await cm.initializeApiAccess();

      // Hub mode should be disabled since no hub to connect to
      expect(configureHubMode).toHaveBeenCalledWith(false);
      // Local keys should be sent as fallback
      expect(configureProviderKeys).toHaveBeenCalledWith({
        anthropic: 'sk-ant-test',
        openai: 'sk-openai-test',
      });
    });

    it('falls back to local keys when hub connection fails', async () => {
      deps.persistence.getSettings.mockResolvedValue({
        apiKeySource: 'hub',
        hubConnections: [{ url: 'wss://hub.example.com:8765', name: 'My Hub' }],
      });
      deps.hubClient.connect.mockRejectedValue(new Error('Connection refused'));
      deps.keyStore.listProviders.mockReturnValue(['anthropic']);
      deps.keyStore.getDefaultKeyForProvider.mockResolvedValue('sk-ant-test');

      await cm.initializeApiAccess();

      // Hub mode should be disabled since connection failed
      expect(configureHubMode).toHaveBeenCalledWith(false);
      // Local keys should be sent as fallback
      expect(configureProviderKeys).toHaveBeenCalledWith({
        anthropic: 'sk-ant-test',
      });
    });

    it('enables hub mode when hub connection succeeds', async () => {
      deps.persistence.getSettings.mockResolvedValue({
        apiKeySource: 'hub',
        hubConnections: [{ url: 'wss://hub.example.com:8765', name: 'My Hub' }],
      });
      deps.hubClient.connect.mockResolvedValue({
        id: 'hub1',
        httpApiUrl: 'https://hub.example.com:8765',
        sharedProviders: ['anthropic'],
      });

      await cm.initializeApiAccess();

      expect(configureHubMode).toHaveBeenCalledWith(true, 'https://hub.example.com:8765', undefined);
      // Should NOT disable hub mode or send local keys
      expect(configureHubMode).not.toHaveBeenCalledWith(false);
    });
  });
});
