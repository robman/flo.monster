import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SettingsPanel } from './settings-panel.js';
import type { PersistenceLayer, AppSettings } from '../shell/persistence.js';
import type { ExtensionLoader } from '../shell/extension-loader.js';
import type { Extension } from '@flo-monster/core';
import { KeyStore } from '../shell/key-store.js';
import type { HubClient, HubConnection } from '../shell/hub-client.js';

function createMockPersistence(): PersistenceLayer {
  const settings: AppSettings = {
    defaultModel: 'claude-sonnet-4-20250514',
    enabledExtensions: [],
  };
  return {
    getSettings: vi.fn(async () => ({ ...settings })),
    saveSettings: vi.fn(async (s: AppSettings) => { Object.assign(settings, s); }),
    exportData: vi.fn(async () => '{}'),
    importData: vi.fn(async () => {}),
    clearAll: vi.fn(async () => {}),
  } as any;
}

function createMockExtensionLoader(extensions: Extension[] = []): ExtensionLoader {
  return {
    getLoaded: vi.fn(() => extensions),
    loadFromUrl: vi.fn(async () => ({})),
    unload: vi.fn(),
  } as any;
}

function createMockHubClient(connections: HubConnection[] = []): HubClient {
  return {
    getConnections: vi.fn(() => connections),
    getConnection: vi.fn((id: string) => connections.find(c => c.id === id)),
    connect: vi.fn(),
    disconnect: vi.fn(),
    executeTool: vi.fn(),
    fetch: vi.fn(),
    onConnect: vi.fn(() => vi.fn()),
    onDisconnect: vi.fn(() => vi.fn()),
    onToolsAnnounced: vi.fn(() => vi.fn()),
    getAllTools: vi.fn(() => []),
    findToolHub: vi.fn(),
  } as unknown as HubClient;
}

describe('SettingsPanel', () => {
  let container: HTMLElement;
  let persistence: PersistenceLayer;
  let extensionLoader: ExtensionLoader;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    persistence = createMockPersistence();
    extensionLoader = createMockExtensionLoader();
  });

  afterEach(() => {
    container.remove();
  });

  it('show/hide toggles visibility', async () => {
    const panel = new SettingsPanel(container, {
      persistence,
      extensionLoader,
      onApiKeyChange: vi.fn(),
      onApiKeyDelete: vi.fn(),
    });

    expect(panel.isVisible()).toBe(false);
    await panel.show();
    expect(panel.isVisible()).toBe(true);
    panel.hide();
    expect(panel.isVisible()).toBe(false);
  });

  it('toggle switches visibility', async () => {
    const panel = new SettingsPanel(container, {
      persistence,
      extensionLoader,
      onApiKeyChange: vi.fn(),
      onApiKeyDelete: vi.fn(),
    });

    await panel.toggle();
    expect(panel.isVisible()).toBe(true);
    panel.toggle();
    expect(panel.isVisible()).toBe(false);
  });

  it('renders all sections when shown', async () => {
    const panel = new SettingsPanel(container, {
      persistence,
      extensionLoader,
      onApiKeyChange: vi.fn(),
      onApiKeyDelete: vi.fn(),
    });

    await panel.show();

    const sections = container.querySelectorAll('.settings-section');
    expect(sections.length).toBe(9); // API Key, Default Model, API Proxy, Budget, Default Network Policy, Web Tool Routing, Extensions, Data, Version & Updates
  });

  it('uses details/summary elements for collapsible sections', async () => {
    const panel = new SettingsPanel(container, {
      persistence,
      extensionLoader,
      onApiKeyChange: vi.fn(),
      onApiKeyDelete: vi.fn(),
    });

    await panel.show();

    const sections = container.querySelectorAll('details.settings-section');
    expect(sections.length).toBe(9);
    // Each section should have a summary child
    sections.forEach(section => {
      expect(section.querySelector('summary.settings-section__title')).toBeTruthy();
    });
  });

  it('API Key and Default Model sections are open by default', async () => {
    const panel = new SettingsPanel(container, {
      persistence,
      extensionLoader,
      onApiKeyChange: vi.fn(),
      onApiKeyDelete: vi.fn(),
    });

    await panel.show();

    const sections = container.querySelectorAll('details.settings-section') as NodeListOf<HTMLDetailsElement>;
    // First section: API Key (open)
    expect(sections[0].open).toBe(true);
    expect(sections[0].querySelector('summary')!.textContent).toBe('API Key');
    // Second section: Default Model (open)
    expect(sections[1].open).toBe(true);
    expect(sections[1].querySelector('summary')!.textContent).toBe('Default Model');
    // Third section: API Proxy (collapsed)
    expect(sections[2].open).toBe(false);
    expect(sections[2].querySelector('summary')!.textContent).toBe('API Proxy');
  });

  it('renders model select with correct options', async () => {
    const panel = new SettingsPanel(container, {
      persistence,
      extensionLoader,
      onApiKeyChange: vi.fn(),
      onApiKeyDelete: vi.fn(),
    });

    await panel.show();

    const select = container.querySelector('.settings-model-select') as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.options.length).toBe(8); // 8 Anthropic models in MODEL_INFO
  });

  it('renders budget inputs', async () => {
    const panel = new SettingsPanel(container, {
      persistence,
      extensionLoader,
      onApiKeyChange: vi.fn(),
      onApiKeyDelete: vi.fn(),
    });

    await panel.show();

    expect(container.querySelector('.settings-budget__tokens')).toBeTruthy();
    expect(container.querySelector('.settings-budget__cost')).toBeTruthy();
  });

  it('renders extensions list', async () => {
    const extensions: Extension[] = [
      { id: 'ext-1', name: 'Test Extension', version: '1.0.0', description: 'A test' },
    ];
    extensionLoader = createMockExtensionLoader(extensions);

    const panel = new SettingsPanel(container, {
      persistence,
      extensionLoader,
      onApiKeyChange: vi.fn(),
      onApiKeyDelete: vi.fn(),
    });

    await panel.show();

    const items = container.querySelectorAll('.settings-extensions__item');
    expect(items.length).toBe(1);
  });

  it('shows empty message when no extensions loaded', async () => {
    const panel = new SettingsPanel(container, {
      persistence,
      extensionLoader,
      onApiKeyChange: vi.fn(),
      onApiKeyDelete: vi.fn(),
    });

    await panel.show();

    const empty = container.querySelector('.settings-extensions__empty');
    expect(empty).toBeTruthy();
    expect(empty!.textContent).toBe('No extensions loaded');
  });

  it('isVisible tracks state correctly', async () => {
    const panel = new SettingsPanel(container, {
      persistence,
      extensionLoader,
      onApiKeyChange: vi.fn(),
      onApiKeyDelete: vi.fn(),
    });

    expect(panel.isVisible()).toBe(false);
    await panel.show();
    expect(panel.isVisible()).toBe(true);
    panel.hide();
    expect(panel.isVisible()).toBe(false);
  });

  it('renders data section with export/import/clear buttons', async () => {
    const panel = new SettingsPanel(container, {
      persistence,
      extensionLoader,
      onApiKeyChange: vi.fn(),
      onApiKeyDelete: vi.fn(),
    });

    await panel.show();

    const dataSection = container.querySelector('.settings-data');
    expect(dataSection).toBeTruthy();
    const buttons = dataSection!.querySelectorAll('button');
    expect(buttons.length).toBe(3); // Export, Import, Clear
  });

  it('creates backdrop and panel elements', async () => {
    const panel = new SettingsPanel(container, {
      persistence,
      extensionLoader,
      onApiKeyChange: vi.fn(),
      onApiKeyDelete: vi.fn(),
    });

    await panel.show();

    expect(container.querySelector('.settings-backdrop')).toBeTruthy();
    expect(container.querySelector('.settings-panel')).toBeTruthy();
  });

  it('renders panel header with title and close button', async () => {
    const panel = new SettingsPanel(container, {
      persistence,
      extensionLoader,
      onApiKeyChange: vi.fn(),
      onApiKeyDelete: vi.fn(),
    });

    await panel.show();

    const title = container.querySelector('.settings-panel__title');
    expect(title).toBeTruthy();
    expect(title!.textContent).toBe('Settings');

    const closeBtn = container.querySelector('.settings-panel__close');
    expect(closeBtn).toBeTruthy();
  });

  it('renders api key section with key list and add form', async () => {
    const panel = new SettingsPanel(container, {
      persistence,
      extensionLoader,
      onApiKeyChange: vi.fn(),
      onApiKeyDelete: vi.fn(),
    });

    await panel.show();

    const apiKeySection = container.querySelector('.settings-api-key');
    expect(apiKeySection).toBeTruthy();

    // Key list (empty initially without keyStore)
    const keyList = container.querySelector('.settings-api-key__list');
    expect(keyList).toBeTruthy();

    // Provider select for adding keys
    const providerSelect = container.querySelector('.settings-api-key__provider-select');
    expect(providerSelect).toBeTruthy();

    // Add key button
    const addBtn = container.querySelector('.settings-api-key__add');
    expect(addBtn).toBeTruthy();

    // Delete all button
    const deleteAllBtn = container.querySelector('.settings-api-key__delete-all');
    expect(deleteAllBtn).toBeTruthy();
  });

  it('does not show twice if already visible', async () => {
    const panel = new SettingsPanel(container, {
      persistence,
      extensionLoader,
      onApiKeyChange: vi.fn(),
      onApiKeyDelete: vi.fn(),
    });

    await panel.show();
    await panel.show(); // second call should be no-op

    const panels = container.querySelectorAll('.settings-panel');
    expect(panels.length).toBe(1);
  });

  it('hide is no-op when not visible', () => {
    const panel = new SettingsPanel(container, {
      persistence,
      extensionLoader,
      onApiKeyChange: vi.fn(),
      onApiKeyDelete: vi.fn(),
    });

    // Should not throw
    panel.hide();
    expect(panel.isVisible()).toBe(false);
  });

  it('renders extension with description', async () => {
    const extensions: Extension[] = [
      { id: 'ext-1', name: 'My Ext', version: '2.0.0', description: 'Does cool things' },
    ];
    extensionLoader = createMockExtensionLoader(extensions);

    const panel = new SettingsPanel(container, {
      persistence,
      extensionLoader,
      onApiKeyChange: vi.fn(),
      onApiKeyDelete: vi.fn(),
    });

    await panel.show();

    const desc = container.querySelector('.settings-extensions__desc');
    expect(desc).toBeTruthy();
    expect(desc!.textContent).toBe('Does cool things');

    const version = container.querySelector('.settings-extensions__version');
    expect(version).toBeTruthy();
    expect(version!.textContent).toBe('v2.0.0');
  });

  it('renders add extension URL button', async () => {
    const panel = new SettingsPanel(container, {
      persistence,
      extensionLoader,
      onApiKeyChange: vi.fn(),
      onApiKeyDelete: vi.fn(),
    });

    await panel.show();

    const addBtn = container.querySelector('.settings-extensions__add');
    expect(addBtn).toBeTruthy();
    expect(addBtn!.textContent).toBe('Add Extension URL');
  });

  it('extension with HTML in name does not render as HTML', async () => {
    const extensions: Extension[] = [
      { id: 'ext-xss', name: '<img src=x onerror=alert(1)>', version: '1.0.0' },
    ];
    extensionLoader = createMockExtensionLoader(extensions);

    const panel = new SettingsPanel(container, {
      persistence,
      extensionLoader,
      onApiKeyChange: vi.fn(),
      onApiKeyDelete: vi.fn(),
    });

    await panel.show();

    // The HTML should be escaped/rendered as text, not as an element
    const items = container.querySelectorAll('.settings-extensions__item');
    expect(items.length).toBe(1);
    const info = items[0].querySelector('.settings-extensions__info');
    expect(info).toBeTruthy();
    // Should not contain an img element
    expect(info!.querySelector('img')).toBeNull();
    // The strong element should contain the literal text
    const strong = info!.querySelector('strong');
    expect(strong).toBeTruthy();
    expect(strong!.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('extension with HTML in version does not render as HTML', async () => {
    const extensions: Extension[] = [
      { id: 'ext-xss2', name: 'Safe Name', version: '<script>alert(1)</script>' },
    ];
    extensionLoader = createMockExtensionLoader(extensions);

    const panel = new SettingsPanel(container, {
      persistence,
      extensionLoader,
      onApiKeyChange: vi.fn(),
      onApiKeyDelete: vi.fn(),
    });

    await panel.show();

    const versionEl = container.querySelector('.settings-extensions__version');
    expect(versionEl).toBeTruthy();
    // Should not contain a script element
    expect(versionEl!.querySelector('script')).toBeNull();
    expect(versionEl!.textContent).toContain('<script>');
  });

  it('renders proxy section with toggle and URL input', async () => {
    const panel = new SettingsPanel(container, {
      persistence,
      extensionLoader,
      onApiKeyChange: vi.fn(),
      onApiKeyDelete: vi.fn(),
    });

    await panel.show();

    const proxySection = container.querySelector('.settings-proxy');
    expect(proxySection).toBeTruthy();

    // Toggle for built-in proxy
    const checkbox = container.querySelector('.settings-proxy__builtin-checkbox') as HTMLInputElement;
    expect(checkbox).toBeTruthy();
    expect(checkbox.checked).toBe(true); // Default is built-in proxy

    // URL input (should be hidden when built-in proxy is enabled)
    const urlField = container.querySelector('.settings-proxy__url-field') as HTMLElement;
    expect(urlField).toBeTruthy();
    expect(urlField.style.display).toBe('none'); // Hidden when built-in proxy checked

    // URL input element
    const urlInput = container.querySelector('.settings-proxy__url') as HTMLInputElement;
    expect(urlInput).toBeTruthy();
    expect(urlInput.value).toBe('');
  });

  it('renders network policy section with mode selector and domains textarea', async () => {
    const panel = new SettingsPanel(container, {
      persistence,
      extensionLoader,
      onApiKeyChange: vi.fn(),
      onApiKeyDelete: vi.fn(),
    });

    await panel.show();

    const networkSection = container.querySelector('.settings-network-policy');
    expect(networkSection).toBeTruthy();

    // Mode select dropdown
    const modeSelect = container.querySelector('.settings-network-policy__mode') as HTMLSelectElement;
    expect(modeSelect).toBeTruthy();
    expect(modeSelect.options.length).toBe(3); // allow-all, allowlist, blocklist
    expect(modeSelect.value).toBe('allow-all'); // Default

    // Domains textarea
    const domainsTextarea = container.querySelector('.settings-network-policy__domains') as HTMLTextAreaElement;
    expect(domainsTextarea).toBeTruthy();
  });

  describe('multi-provider key management', () => {
    it('shows provider dropdown with all supported providers', async () => {
      const keyStore = new KeyStore();
      const panel = new SettingsPanel(container, {
        persistence,
        extensionLoader,
        keyStore,
        onApiKeyChange: vi.fn(),
        onApiKeyDelete: vi.fn(),
      });

      await panel.show();

      const providerSelect = container.querySelector('.settings-api-key__provider-select') as HTMLSelectElement;
      expect(providerSelect).toBeTruthy();
      expect(providerSelect.options.length).toBe(3); // anthropic, openai, gemini
    });

    it('shows all keys grouped by provider', async () => {
      const keyStore = new KeyStore();
      await keyStore.addKey('sk-ant-key', 'anthropic', 'Anthropic Key');
      await keyStore.addKey('sk-openai-key', 'openai', 'OpenAI Key');

      const panel = new SettingsPanel(container, {
        persistence,
        extensionLoader,
        keyStore,
        onApiKeyChange: vi.fn(),
        onApiKeyDelete: vi.fn(),
      });

      await panel.show();

      const providerGroups = container.querySelectorAll('.settings-api-key__provider-group');
      expect(providerGroups.length).toBe(2);

      const keyItems = container.querySelectorAll('.settings-api-key__item');
      expect(keyItems.length).toBe(2);
    });

    it('marks default key with badge', async () => {
      const keyStore = new KeyStore();
      await keyStore.addKey('sk-ant-key', 'anthropic', 'My Key');

      const panel = new SettingsPanel(container, {
        persistence,
        extensionLoader,
        keyStore,
        onApiKeyChange: vi.fn(),
        onApiKeyDelete: vi.fn(),
      });

      await panel.show();

      const defaultBadge = container.querySelector('.settings-api-key__default-badge');
      expect(defaultBadge).toBeTruthy();
      expect(defaultBadge!.textContent).toBe('default');
    });

    it('shows set default button for non-default keys', async () => {
      const keyStore = new KeyStore();
      await keyStore.addKey('sk-ant-key-1', 'anthropic', 'Key 1');
      await keyStore.addKey('sk-ant-key-2', 'anthropic', 'Key 2');

      const panel = new SettingsPanel(container, {
        persistence,
        extensionLoader,
        keyStore,
        onApiKeyChange: vi.fn(),
        onApiKeyDelete: vi.fn(),
      });

      await panel.show();

      // First key is default, should not have set default button
      // Second key is not default, should have set default button
      const setDefaultBtns = container.querySelectorAll('button');
      const setDefaultBtn = Array.from(setDefaultBtns).find(b => b.textContent === 'Set Default');
      expect(setDefaultBtn).toBeTruthy();
    });

    it('shows remove button for each key', async () => {
      const keyStore = new KeyStore();
      await keyStore.addKey('sk-ant-key', 'anthropic', 'My Key');

      const panel = new SettingsPanel(container, {
        persistence,
        extensionLoader,
        keyStore,
        onApiKeyChange: vi.fn(),
        onApiKeyDelete: vi.fn(),
      });

      await panel.show();

      const removeBtn = container.querySelector('.settings-api-key__delete');
      expect(removeBtn).toBeTruthy();
      expect(removeBtn!.textContent).toBe('Remove');
    });

    it('shows empty message when no keys configured', async () => {
      const keyStore = new KeyStore();

      const panel = new SettingsPanel(container, {
        persistence,
        extensionLoader,
        keyStore,
        onApiKeyChange: vi.fn(),
        onApiKeyDelete: vi.fn(),
      });

      await panel.show();

      const empty = container.querySelector('.settings-api-key__empty');
      expect(empty).toBeTruthy();
      expect(empty!.textContent).toBe('No API keys configured');
    });
  });

  describe('web proxy section', () => {
    it('shows web proxy section when hub is connected', async () => {
      const connections: HubConnection[] = [
        { id: 'hub-1', name: 'Test Hub', url: 'ws://localhost:3002', connected: true, tools: [] },
      ];
      const hubClient = createMockHubClient(connections);

      const panel = new SettingsPanel(container, {
        persistence,
        extensionLoader,
        hubClient,
        onApiKeyChange: vi.fn(),
        onApiKeyDelete: vi.fn(),
      });

      await panel.show();

      const webProxySection = container.querySelector('.settings-web-proxy');
      expect(webProxySection).toBeTruthy();
    });

    it('does not show web proxy section when no hub connections', async () => {
      const hubClient = createMockHubClient([]);

      const panel = new SettingsPanel(container, {
        persistence,
        extensionLoader,
        hubClient,
        onApiKeyChange: vi.fn(),
        onApiKeyDelete: vi.fn(),
      });

      await panel.show();

      const webProxySection = container.querySelector('.settings-web-proxy');
      expect(webProxySection).toBeNull();
    });

    it('web proxy toggle changes persistence', async () => {
      const connections: HubConnection[] = [
        { id: 'hub-1', name: 'Test Hub', url: 'ws://localhost:3002', connected: true, tools: [] },
      ];
      const hubClient = createMockHubClient(connections);

      const panel = new SettingsPanel(container, {
        persistence,
        extensionLoader,
        hubClient,
        onApiKeyChange: vi.fn(),
        onApiKeyDelete: vi.fn(),
      });

      await panel.show();

      const checkbox = container.querySelector('.settings-web-proxy__enabled-checkbox') as HTMLInputElement;
      expect(checkbox).toBeTruthy();
      expect(checkbox.checked).toBe(false); // Default is off

      // Toggle on
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('change'));

      // Wait for async save to complete
      await vi.waitFor(() => {
        expect(persistence.saveSettings).toHaveBeenCalled();
      });

      const savedSettings = (persistence.saveSettings as ReturnType<typeof vi.fn>).mock.calls.slice(-1)[0][0];
      expect(savedSettings.defaultNetworkPolicy?.useHubProxy).toBe(true);
    });

    it('web proxy patterns textarea saves correctly', async () => {
      const connections: HubConnection[] = [
        { id: 'hub-1', name: 'Test Hub', url: 'ws://localhost:3002', connected: true, tools: [] },
      ];
      const hubClient = createMockHubClient(connections);

      const panel = new SettingsPanel(container, {
        persistence,
        extensionLoader,
        hubClient,
        onApiKeyChange: vi.fn(),
        onApiKeyDelete: vi.fn(),
      });

      await panel.show();

      // Enable hub proxy first
      const checkbox = container.querySelector('.settings-web-proxy__enabled-checkbox') as HTMLInputElement;
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('change'));

      // Wait for first save to complete
      await vi.waitFor(() => {
        expect(persistence.saveSettings).toHaveBeenCalled();
      });

      // Enter patterns
      const textarea = container.querySelector('.settings-web-proxy__patterns') as HTMLTextAreaElement;
      expect(textarea).toBeTruthy();
      textarea.value = 'https://api.example.com/*\nhttps://*.internal.corp/*';
      textarea.dispatchEvent(new Event('blur'));

      // Wait for second save to complete
      await vi.waitFor(() => {
        expect((persistence.saveSettings as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
      });

      const savedSettings = (persistence.saveSettings as ReturnType<typeof vi.fn>).mock.calls.slice(-1)[0][0];
      expect(savedSettings.defaultNetworkPolicy?.hubProxyPatterns).toEqual([
        'https://api.example.com/*',
        'https://*.internal.corp/*',
      ]);
    });
  });

  describe('hub settings section', () => {
    it('shows hub settings section when hub is connected', async () => {
      const connections: HubConnection[] = [
        { id: 'hub-1', name: 'Test Hub', url: 'ws://localhost:3002', connected: true, tools: [] },
      ];
      const hubClient = createMockHubClient(connections);

      const panel = new SettingsPanel(container, {
        persistence,
        extensionLoader,
        hubClient,
        onApiKeyChange: vi.fn(),
        onApiKeyDelete: vi.fn(),
      });

      await panel.show();

      const hubSettingsSection = container.querySelector('.settings-hub-settings');
      expect(hubSettingsSection).toBeTruthy();
    });

    it('does not show hub settings section when no hub connections', async () => {
      const hubClient = createMockHubClient([]);

      const panel = new SettingsPanel(container, {
        persistence,
        extensionLoader,
        hubClient,
        onApiKeyChange: vi.fn(),
        onApiKeyDelete: vi.fn(),
      });

      await panel.show();

      const hubSettingsSection = container.querySelector('.settings-hub-settings');
      expect(hubSettingsSection).toBeNull();
    });

    it('shows default sandbox path input', async () => {
      const connections: HubConnection[] = [
        { id: 'hub-1', name: 'Test Hub', url: 'ws://localhost:3002', connected: true, tools: [] },
      ];
      const hubClient = createMockHubClient(connections);

      const panel = new SettingsPanel(container, {
        persistence,
        extensionLoader,
        hubClient,
        onApiKeyChange: vi.fn(),
        onApiKeyDelete: vi.fn(),
      });

      await panel.show();

      const sandboxInput = container.querySelector('.settings-hub-settings__sandbox-path') as HTMLInputElement;
      expect(sandboxInput).toBeTruthy();
      expect(sandboxInput.placeholder).toBe('(uses hub default)');
    });

    it('loads saved default sandbox path', async () => {
      (persistence.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        defaultModel: 'claude-sonnet-4-20250514',
        enabledExtensions: [],
        defaultHubSandboxPath: '/home/user/sandbox',
      });

      const connections: HubConnection[] = [
        { id: 'hub-1', name: 'Test Hub', url: 'ws://localhost:3002', connected: true, tools: [] },
      ];
      const hubClient = createMockHubClient(connections);

      const panel = new SettingsPanel(container, {
        persistence,
        extensionLoader,
        hubClient,
        onApiKeyChange: vi.fn(),
        onApiKeyDelete: vi.fn(),
      });

      await panel.show();

      const sandboxInput = container.querySelector('.settings-hub-settings__sandbox-path') as HTMLInputElement;
      expect(sandboxInput.value).toBe('/home/user/sandbox');
    });

    it('saves default sandbox path on change', async () => {
      const connections: HubConnection[] = [
        { id: 'hub-1', name: 'Test Hub', url: 'ws://localhost:3002', connected: true, tools: [] },
      ];
      const hubClient = createMockHubClient(connections);

      const panel = new SettingsPanel(container, {
        persistence,
        extensionLoader,
        hubClient,
        onApiKeyChange: vi.fn(),
        onApiKeyDelete: vi.fn(),
      });

      await panel.show();

      const sandboxInput = container.querySelector('.settings-hub-settings__sandbox-path') as HTMLInputElement;
      sandboxInput.value = '/new/sandbox/path';
      sandboxInput.dispatchEvent(new Event('change'));

      await vi.waitFor(() => {
        expect(persistence.saveSettings).toHaveBeenCalled();
      });

      const savedSettings = (persistence.saveSettings as ReturnType<typeof vi.fn>).mock.calls.slice(-1)[0][0];
      expect(savedSettings.defaultHubSandboxPath).toBe('/new/sandbox/path');
    });

    it('saves undefined when sandbox path is cleared', async () => {
      (persistence.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        defaultModel: 'claude-sonnet-4-20250514',
        enabledExtensions: [],
        defaultHubSandboxPath: '/old/path',
      });

      const connections: HubConnection[] = [
        { id: 'hub-1', name: 'Test Hub', url: 'ws://localhost:3002', connected: true, tools: [] },
      ];
      const hubClient = createMockHubClient(connections);

      const panel = new SettingsPanel(container, {
        persistence,
        extensionLoader,
        hubClient,
        onApiKeyChange: vi.fn(),
        onApiKeyDelete: vi.fn(),
      });

      await panel.show();

      const sandboxInput = container.querySelector('.settings-hub-settings__sandbox-path') as HTMLInputElement;
      sandboxInput.value = '';
      sandboxInput.dispatchEvent(new Event('change'));

      await vi.waitFor(() => {
        expect(persistence.saveSettings).toHaveBeenCalled();
      });

      const savedSettings = (persistence.saveSettings as ReturnType<typeof vi.fn>).mock.calls.slice(-1)[0][0];
      expect(savedSettings.defaultHubSandboxPath).toBeUndefined();
    });

    it('shows help text explaining the setting', async () => {
      const connections: HubConnection[] = [
        { id: 'hub-1', name: 'Test Hub', url: 'ws://localhost:3002', connected: true, tools: [] },
      ];
      const hubClient = createMockHubClient(connections);

      const panel = new SettingsPanel(container, {
        persistence,
        extensionLoader,
        hubClient,
        onApiKeyChange: vi.fn(),
        onApiKeyDelete: vi.fn(),
      });

      await panel.show();

      const helpText = container.querySelector('.settings-hub-settings__help');
      expect(helpText).toBeTruthy();
      expect(helpText!.textContent).toContain('per-agent');
    });
  });

  describe('web tool routing section', () => {
    it('renders web tool routing section', async () => {
      const panel = new SettingsPanel(container, {
        persistence,
        extensionLoader,
        onApiKeyChange: vi.fn(),
        onApiKeyDelete: vi.fn(),
      });

      await panel.show();

      const routingSection = container.querySelector('.settings-web-tool-routing');
      expect(routingSection).toBeTruthy();
    });

    it('shows routing select with correct options', async () => {
      const panel = new SettingsPanel(container, {
        persistence,
        extensionLoader,
        onApiKeyChange: vi.fn(),
        onApiKeyDelete: vi.fn(),
      });

      await panel.show();

      const select = container.querySelector('.settings-web-tool-routing__select') as HTMLSelectElement;
      expect(select).toBeTruthy();
      expect(select.options.length).toBe(4); // auto, hub, browser, api
    });

    it('defaults to auto routing', async () => {
      const panel = new SettingsPanel(container, {
        persistence,
        extensionLoader,
        onApiKeyChange: vi.fn(),
        onApiKeyDelete: vi.fn(),
      });

      await panel.show();

      const select = container.querySelector('.settings-web-tool-routing__select') as HTMLSelectElement;
      expect(select.value).toBe('auto');
    });

    it('saves routing preference on change', async () => {
      const panel = new SettingsPanel(container, {
        persistence,
        extensionLoader,
        onApiKeyChange: vi.fn(),
        onApiKeyDelete: vi.fn(),
      });

      await panel.show();

      const select = container.querySelector('.settings-web-tool-routing__select') as HTMLSelectElement;
      select.value = 'hub';
      select.dispatchEvent(new Event('change'));

      await vi.waitFor(() => {
        expect(persistence.saveSettings).toHaveBeenCalled();
      });

      const savedSettings = (persistence.saveSettings as ReturnType<typeof vi.fn>).mock.calls.slice(-1)[0][0];
      expect(savedSettings.defaultWebToolRouting).toBe('hub');
    });

    it('loads saved routing preference', async () => {
      // Set up persistence to return saved routing
      (persistence.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        defaultModel: 'claude-sonnet-4-20250514',
        enabledExtensions: [],
        defaultWebToolRouting: 'browser',
      });

      const panel = new SettingsPanel(container, {
        persistence,
        extensionLoader,
        onApiKeyChange: vi.fn(),
        onApiKeyDelete: vi.fn(),
      });

      await panel.show();

      const select = container.querySelector('.settings-web-tool-routing__select') as HTMLSelectElement;
      expect(select.value).toBe('browser');
    });

    it('shows help text about hub and CORS', async () => {
      const panel = new SettingsPanel(container, {
        persistence,
        extensionLoader,
        onApiKeyChange: vi.fn(),
        onApiKeyDelete: vi.fn(),
      });

      await panel.show();

      const helpText = container.querySelector('.settings-web-tool-routing__help');
      expect(helpText).toBeTruthy();
      expect(helpText!.textContent).toContain('hub');
      expect(helpText!.textContent).toContain('CORS');
    });
  });
});
