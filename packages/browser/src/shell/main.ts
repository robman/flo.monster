import { MessageRelay } from './message-relay.js';
import { AgentManager } from './agent-manager.js';
import { CostDisplay } from '../ui/cost-display.js';
import { SettingsPanel } from '../ui/settings/index.js';
import { PersistenceLayer } from './persistence.js';
import { ExtensionLoader } from './extension-loader.js';
import { ExtensionConfigStore } from './extension-config-store.js';
import { HubClient } from './hub-client.js';
import { KeyStore } from './key-store.js';
import { CostTracker, ToolPluginRegistry, type SerializedDomState, type SerializedSession } from '@flo-monster/core';
import { HookManager } from './hook-manager.js';
import { SkillManager } from './skill-manager.js';
import { TemplateManager } from './template-manager.js';
import { AuditManager } from './audit-manager.js';
import { createSubagentToolPlugin } from './subagent-tool.js';
import { createContextSearchPlugin } from './context-search-tool.js';
import { createWebFetchPlugin } from '../agent/tools/web-fetch.js';
import { createWebSearchPlugin } from '../agent/tools/web-search.js';
import { createSkillToolsPlugins } from '../agent/tools/skill-tools-plugin.js';
import { createAuditToolPlugin } from '../agent/tools/audit.js';
import { NetworkIndicator } from '../ui/network-indicator.js';
import { showSkillApprovalDialog, showConfirmDialog } from '../ui/skill-dialogs.js';
import { getSystemSkills } from './system-skills.js';
import { UIManager } from './ui-manager.js';
import { setupPwaInstall } from './pwa-install.js';
import { setupUpdateListener, setupWaitingSwDetection } from './sw-registration.js';
import { LifecycleManager } from './lifecycle-manager.js';
import { CredentialsManager } from './credentials-manager.js';
import { DirtyTracker } from './dirty-tracker.js';
import { getStorageProvider } from '../storage/agent-storage.js';
import { HubAgentProxy } from './hub-agent-proxy.js';
import { OfflineBanner } from '../ui/offline-banner.js';
import { NotificationPanel } from '../ui/notification-panel.js';
import { PushSubscribeFlow } from '../ui/push-subscribe.js';
import type { HubAgentSummary } from '@flo-monster/core';
// @ts-ignore - raw import of worker bundle
import workerCode from '../agent/worker-bundle.js?raw';

const DEFAULT_MODEL = 'claude-sonnet-4-6';

/**
 * Shell class - main application coordinator
 * Orchestrates initialization and delegates to focused managers:
 * - UIManager: dashboard, agent view, homepage, panels
 * - LifecycleManager: persistence, reload, DOM capture
 * - CredentialsManager: API keys, hub connection, first-use flow
 */
class Shell {
  // Core services
  private messageRelay!: MessageRelay;
  private pluginRegistry!: ToolPluginRegistry;
  private agentManager!: AgentManager;
  private costDisplay: CostDisplay | null = null;
  private costTracker: CostTracker | null = null;
  private persistence!: PersistenceLayer;
  private extensionLoader!: ExtensionLoader;
  private extensionConfigStore!: ExtensionConfigStore;
  private hubClient!: HubClient;
  private keyStore!: KeyStore;
  private hookManager!: HookManager;
  private skillManager!: SkillManager;
  private templateManager!: TemplateManager;

  // Settings panel
  private settingsPanel: SettingsPanel | null = null;

  // Managers
  private uiManager!: UIManager;
  private lifecycleManager!: LifecycleManager;
  private credentialsManager!: CredentialsManager;

  // Persistent iframe container
  private agentIframesContainer!: HTMLElement;

  // DOM elements needed by adoptHubAgent
  private mainContent!: HTMLElement;
  private statusState!: HTMLElement;

  // Per-agent cost tracking
  private agentCosts = new Map<string, number>();

  // Dirty tracking for auto-save
  private dirtyTracker = new DirtyTracker();

  // Hub agent proxies (remote agents discovered from hub)
  private hubAgentProxies = new Map<string, HubAgentProxy>();

  // Mapping from hubAgentId → local agentId (for browser tool routing)
  private hubAgentMapping = new Map<string, string>();

  // Notification panel
  private notificationPanel: NotificationPanel | null = null;

  // Push notification flow
  private pushFlow: PushSubscribeFlow | null = null;

  async init(): Promise<void> {
    // Check for ?reset param to clear all settings (for testing first-use experience)
    const params = new URLSearchParams(window.location.search);
    if (params.has('reset')) {
      console.log('[shell] Resetting all settings...');
      await this.clearAllSettings();
      // Remove ?reset from URL and reload
      params.delete('reset');
      const newUrl = params.toString()
        ? `${window.location.pathname}?${params.toString()}`
        : window.location.pathname;
      window.location.replace(newUrl);
      return;
    }

    const overlay = document.getElementById('api-key-overlay')!;
    const form = document.getElementById('api-key-form') as HTMLFormElement;
    const input = document.getElementById('api-key-input') as HTMLInputElement;
    const mainContent = document.getElementById('main-content')!;
    const statusBar = document.querySelector('.status-bar')!;
    const statusState = document.getElementById('status-state')!;
    const newAgentBtn = document.getElementById('new-agent-btn');

    // Store references for adoptHubAgent
    this.mainContent = mainContent;
    this.statusState = statusState;

    // Get persistent iframe container
    this.agentIframesContainer = document.getElementById('agent-iframes')!;

    // Initialize offline banner (first child of #app, above everything)
    const app = document.getElementById('app')!;
    new OfflineBanner(app);

    // Initialize notification panel (after offline banner, before top-bar)
    const topBar = document.querySelector('.top-bar');
    this.notificationPanel = new NotificationPanel(app, topBar as HTMLElement);

    // Wire badge callbacks to dashboard cards
    this.notificationPanel.onBadgeChange((agentId, count) => {
      const dashboard = this.uiManager?.getDashboard();
      if (dashboard) {
        const card = dashboard.getCard(agentId);
        card?.setBadgeCount(count);
      }
    });

    // Wire dashboard offline state and disable new agent button
    window.addEventListener('offline', () => {
      this.uiManager?.getDashboard()?.setOffline(true);
      if (newAgentBtn) (newAgentBtn as HTMLButtonElement).disabled = true;
    });
    window.addEventListener('online', () => {
      this.uiManager?.getDashboard()?.setOffline(false);
      if (newAgentBtn) (newAgentBtn as HTMLButtonElement).disabled = false;
    });

    // Initialize core services
    this.initCoreServices(statusBar as HTMLElement);

    // Initialize plugin registry plugins
    this.initPlugins();

    // Initialize cost tracking
    this.initCostTracking(statusBar as HTMLElement, statusState);

    // Load persisted state
    await this.loadPersistedState();

    // Initialize managers
    this.initManagers(statusState);

    // Load outer skin
    await this.uiManager.loadOuterSkin();

    // Register SW early for caching/offline support (before credentials)
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(err => {
        console.warn('[flo] Early SW registration failed:', err);
      });
    }

    // Check credentials and determine initial view
    await this.credentialsManager.migrateLegacyKey();
    const hasCredentials = await this.credentialsManager.hasCredentials();
    const settings = await this.persistence.getSettings();
    const hasSeenHomepage = settings.hasSeenHomepage;

    // Initialize outer skin system for all users (creates nav header)
    if (this.uiManager.getOuterSkin()) {
      this.uiManager.initializeOuterSkin(
        mainContent,
        statusState,
        () => this.initializeApp(mainContent, statusState),
      );
    }

    if (!hasCredentials) {
      // New user - show homepage
      if (this.uiManager.getOuterSkin()) {
        this.uiManager.showHomepage(mainContent, statusState);
        this.hideLoadingScreen();
      } else {
        // Fallback if skin failed to load
        overlay.hidden = false;
        this.hideLoadingScreen();
      }
    } else if (!hasSeenHomepage && this.uiManager.getOuterSkin()) {
      // Has credentials but never seen homepage - show it once
      this.uiManager.showHomepage(mainContent, statusState);
      this.hideLoadingScreen();
    } else {
      // Returning user with credentials - go straight to app
      // Hide prerendered homepage (it's visible in the HTML for SEO)
      const prerendered = document.getElementById('prerendered-homepage');
      if (prerendered) prerendered.style.display = 'none';
      await this.initializeApp(mainContent, statusState);
      this.hideLoadingScreen();
    }

    // Setup credential forms (API key + hub setup)
    this.credentialsManager.setupCredentialForms(
      overlay,
      form,
      input,
      () => this.initializeApp(mainContent, statusState),
    );

    // New agent button in top bar
    if (newAgentBtn) {
      newAgentBtn.addEventListener('click', () => {
        this.uiManager.showNewAgentDialog(mainContent, statusState);
      });
    }

    // Top bar logo - back to homepage
    const topBarLogo = document.getElementById('top-bar-logo');
    if (topBarLogo) {
      topBarLogo.addEventListener('click', (e) => {
        e.preventDefault();
        this.uiManager.showHomepage(mainContent, statusState);
      });
    }

    // Settings button
    this.initSettingsPanel(mainContent, statusState);

    // Initialize UI panels
    this.uiManager.initPanels();
    this.uiManager.initTemplatesPanel(mainContent, statusState);

    // PWA install button
    setupPwaInstall();

    // iOS Safari viewport zoom fix: after keyboard dismissal (input blur or
    // window.prompt close), the viewport may stay zoomed in. Reset by briefly
    // forcing maximum-scale=1.0 then removing it to preserve user zooming.
    this.setupIosViewportFix();

    // Listen for SW update notifications (version check broadcasts)
    setupUpdateListener();

    // Detect new SWs entering waiting state (after skipWaiting removal)
    setupWaitingSwDetection();

    // Listen for SW messages (caches_cleared, notification_click)
    navigator.serviceWorker?.addEventListener('message', (event) => {
      if (event.data?.type === 'caches_cleared') {
        window.location.reload();
      }
      if (event.data?.type === 'notification_click') {
        const agentId = event.data.agentId;
        if (agentId && this.agentManager.getAgent(agentId)) {
          this.uiManager.showAgent(agentId, this.mainContent, this.statusState);
        }
      }
    });
  }

  private initCoreServices(statusBar: HTMLElement): void {
    // Initialize message relay
    this.messageRelay = new MessageRelay();
    this.messageRelay.start();

    // Initialize plugin registry
    this.pluginRegistry = new ToolPluginRegistry();
    this.messageRelay.setPluginRegistry(this.pluginRegistry);

    // Initialize hook manager
    this.hookManager = new HookManager();
    this.messageRelay.setHookManager(this.hookManager);
    this.hookManager.setMessageRelay(this.messageRelay);

    // Initialize audit manager
    const auditManager = new AuditManager();
    this.messageRelay.setAuditManager(auditManager);

    // Initialize network indicator
    const networkIndicator = new NetworkIndicator(statusBar);
    // Move network indicator to the first position in the status bar
    if (statusBar.firstChild) {
      statusBar.insertBefore(networkIndicator.getElement(), statusBar.firstChild);
    }
    this.messageRelay.setNetworkIndicator(networkIndicator);

    // Initialize skill manager and install system skills
    this.skillManager = new SkillManager();
    this.skillManager.installSystemSkills(getSystemSkills());

    // Initialize template manager
    this.templateManager = new TemplateManager();

    // Initialize persistence
    this.persistence = new PersistenceLayer();

    // Initialize extension loader and config store
    this.extensionLoader = new ExtensionLoader(this.pluginRegistry);
    this.extensionConfigStore = new ExtensionConfigStore();

    // Initialize hub client
    this.hubClient = new HubClient();
    this.messageRelay.setHubClient(this.hubClient);

    // Wire hub agent discovery
    this.hubClient.onConnect((conn) => {
      this.discoverHubAgents(conn.id).catch(err => {
        console.warn('[flo] Failed to discover hub agents:', err);
      });
    });
    this.hubClient.onDisconnect((connId) => {
      this.removeHubAgentsForConnection(connId);
    });

    // Close WebSockets and stop reconnection on page teardown.
    // pagehide fires for both navigations and BFCache eviction.
    window.addEventListener('pagehide', () => {
      this.hubClient.suspend();
      this.hubClient.stopAllReconnections();
    });

    // freeze fires when iOS suspends the web content process (screen off, memory pressure).
    // Belt-and-suspenders: ensure WebSockets are closed even if visibilitychange didn't complete.
    document.addEventListener('freeze', () => {
      this.hubClient.suspend();
    });

    // Restore hub connections when page is restored from BFCache or unfrozen
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) {
        console.log('[flo] Page restored from BFCache — resuming hub connections');
        this.hubClient.resume();
      }
    });
    document.addEventListener('resume', () => {
      console.log('[flo] Page unfrozen — resuming hub connections');
      this.hubClient.resume();
    });

    // Route hub agent state updates to dashboard proxies
    this.hubClient.onAgentEvent((agentId, event) => {
      if (event.type === 'state_change') {
        const newState = event.state || event.data?.to;
        if (newState) {
          const proxy = this.hubAgentProxies.get(agentId);
          if (proxy) {
            proxy.updateState(newState);
          }
        }
      }
    });

    // Handle browser tool requests from the hub
    this.hubClient.onBrowserToolRequest(async (hubAgentId, toolName, input) => {
      // Find local agentId for this hub agent
      const localAgentId = this.hubAgentMapping.get(hubAgentId);
      if (!localAgentId) {
        return {
          content: `No local agent container for hub agent "${hubAgentId}". The browser needs an active view of this agent to execute browser tools.`,
          is_error: true,
        };
      }

      // Execute through the message relay's hub tool pipeline
      try {
        const result = await this.messageRelay.executeToolForHub(localAgentId, toolName, input);
        return result;
      } catch (err) {
        return {
          content: `Browser tool execution error: ${(err as Error).message}`,
          is_error: true,
        };
      }
    });

    // Handle DOM state restoration from hub agents
    this.hubClient.onDomStateRestore((hubAgentId, domState) => {
      console.log(`[flo] Received DOM state for hub agent ${hubAgentId}`);
      const localAgentId = this.hubAgentMapping.get(hubAgentId);
      if (!localAgentId) {
        console.log(`[flo] No local agent mapped for hub agent ${hubAgentId}, storing for later`);
        return;
      }
      const agent = this.agentManager.getAgent(localAgentId);
      if (!agent) {
        console.log(`[flo] Local agent ${localAgentId} not found in agent manager`);
        return;
      }
      agent.setHubDomState(domState as SerializedDomState);
    });

    // Handle file push notifications from hub agents (initial + incremental sync)
    this.hubClient.onFilePush(async (hubAgentId, path, content, action) => {
      const localAgentId = this.hubAgentMapping.get(hubAgentId);
      if (!localAgentId) return;

      const provider = await getStorageProvider();
      if (action === 'write' && content !== undefined) {
        await provider.writeFile(localAgentId, path, content);
      } else if (action === 'delete') {
        await provider.deleteFile(localAgentId, path).catch(() => {});
      }
    });

    // Handle context change notifications from hub
    this.hubClient.onContextChange((hubAgentId, change, availableTools) => {
      console.log(`[flo] Context change for hub agent ${hubAgentId}: ${change}, tools: ${availableTools.length}`);
    });

    // Initialize key store
    this.keyStore = new KeyStore();
    this.messageRelay.setKeyStore(this.keyStore);

    // Initialize agent manager
    this.agentManager = new AgentManager(this.messageRelay);

    // Register audit tool plugin (needs auditManager reference)
    const auditPlugin = createAuditToolPlugin(auditManager);
    this.pluginRegistry.register(auditPlugin);
  }

  private initPlugins(): void {
    // Set up DOM mutation callback for auto-save (delegates to lifecycle manager later)
    this.messageRelay.setOnDomMutation((agentId) => {
      this.lifecycleManager?.scheduleDomCaptureForAgent(agentId);
    });

    // Set up dirty tracking callback for auto-save
    this.messageRelay.setOnAgentDirty((agentId, reason) => {
      this.dirtyTracker.markDirty(agentId, reason as any);
    });

    // Register subagent tool plugin
    const subagentPlugin = createSubagentToolPlugin({
      agentManager: this.agentManager,
      messageRelay: this.messageRelay,
      hookManager: this.hookManager,
      workerCode,
    });
    this.pluginRegistry.register(subagentPlugin);

    // Register web tools plugins
    const webFetchPlugin = createWebFetchPlugin({ hubClient: this.hubClient });
    this.pluginRegistry.register(webFetchPlugin);

    const webSearchPlugin = createWebSearchPlugin({ hubClient: this.hubClient });
    this.pluginRegistry.register(webSearchPlugin);

    // Register skill tools plugins
    const skillToolsPlugins = createSkillToolsPlugins({
      skillManager: this.skillManager,
      persistence: this.persistence,
      showApprovalDialog: showSkillApprovalDialog,
      showConfirmDialog: showConfirmDialog,
    });
    for (const plugin of skillToolsPlugins) {
      this.pluginRegistry.register(plugin);
    }

    // Register context search plugin
    const contextSearchPlugin = createContextSearchPlugin({
      getProvider: () => this.messageRelay.getStorageProvider(),
    });
    this.pluginRegistry.register(contextSearchPlugin);
  }

  private initCostTracking(statusBar: HTMLElement, statusState: HTMLElement): void {
    this.costTracker = new CostTracker();
    this.costDisplay = new CostDisplay(statusBar, {
      getAgentList: () => {
        return this.agentManager.getAllAgents().map(a => ({ id: a.id, name: a.config.name }));
      },
      onResetRequest: (options) => {
        this.uiManager.showCostResetMenu(options);
      },
    });

    // Listen for usage events (cumulative from both browser worker and hub)
    document.addEventListener('usage-update', ((e: CustomEvent) => {
      if (this.costTracker && this.costDisplay) {
        const agentId = e.detail.agentId;
        const agent = agentId ? this.agentManager.getAgent(agentId) : null;
        const model = agent?.config.model || DEFAULT_MODEL;

        if (agentId) {
          // Usage is cumulative — SET, don't ADD
          this.costTracker.setAgentUsage(agentId, model, e.detail.usage);

          // Update per-agent cost from tracker (derived from correct model pricing)
          const agentCost = this.costTracker.getAgentCost(agentId);
          this.agentCosts.set(agentId, agentCost);

          // Update dashboard card if visible
          const dashboard = this.uiManager.getDashboard();
          if (dashboard) {
            dashboard.updateAgentCost(agentId, agentCost);
          }
        }

        this.costDisplay.update(this.costTracker.getBudgetStatus());
      }
    }) as EventListener);

    // Update status bar with agent count
    this.agentManager.onAgentCreated(() => this.uiManager.updateStatusBar(statusState));
    this.agentManager.onAgentTerminated(() => this.uiManager.updateStatusBar(statusState));

    // Wire agent notify_user events to notification panel
    this.agentManager.onAgentCreated((agent) => {
      agent.onEvent((event) => {
        if ((event as any).type === 'notify_user' && this.notificationPanel) {
          this.notificationPanel.add(agent.id, agent.config.name, (event as any).message || '');
        }
      });
    });
  }

  private async loadPersistedState(): Promise<void> {
    await this.persistence.open();

    // Initialize extension config store
    await this.extensionConfigStore.init();
    this.extensionLoader.setConfigStore(this.extensionConfigStore);
    this.messageRelay.setExtensionLoader(this.extensionLoader);

    // Load key store from persistence
    try {
      const settings = await this.persistence.getSettings();
      if (settings.keyStoreData) {
        this.keyStore.importEntries(settings.keyStoreData);
      }
    } catch {
      // Ignore errors loading key store
    }

    // Load skills from persistence
    try {
      const settings = await this.persistence.getSettings();
      if (settings.installedSkills) {
        this.skillManager.importEntries(settings.installedSkills);
      }
    } catch {
      // Ignore errors loading skills
    }

    // Load templates from persistence
    try {
      const settings = await this.persistence.getSettings();
      if (settings.installedTemplates) {
        this.templateManager.importEntries(settings.installedTemplates);
      }
    } catch {
      // Ignore errors loading templates
    }

    // Install builtin templates from catalog
    await this.installBuiltinTemplates();
  }

  private async installBuiltinTemplates(): Promise<void> {
    try {
      const res = await fetch('/templates/index.json', { cache: 'no-cache' });
      if (!res.ok) return; // No catalog, no builtins — that's fine
      const catalog: Array<{ name: string; version: string; file: string }> = await res.json();

      for (const entry of catalog) {
        const existing = this.templateManager.getTemplate(entry.name);
        // Skip if already installed as builtin with same version
        if (existing?.source.type === 'builtin' && existing.manifest.version === entry.version) continue;
        // Skip if user installed their own version
        if (existing && existing.source.type !== 'builtin') continue;

        const zipRes = await fetch(`/templates/${entry.file}`, { cache: 'no-cache' });
        if (!zipRes.ok) continue;
        const blob = await zipRes.blob();
        await this.templateManager.installFromZip(blob, { type: 'builtin' });
      }
    } catch { /* No builtins available, non-fatal */ }
  }

  private initManagers(statusState: HTMLElement): void {
    // Initialize credentials manager
    this.credentialsManager = new CredentialsManager({
      persistence: this.persistence,
      hubClient: this.hubClient,
      keyStore: this.keyStore,
    });

    // Initialize UI manager
    this.uiManager = new UIManager({
      agentManager: this.agentManager,
      messageRelay: this.messageRelay,
      persistence: this.persistence,
      hookManager: this.hookManager,
      skillManager: this.skillManager,
      templateManager: this.templateManager,
      hubClient: this.hubClient,
      keyStore: this.keyStore,
      pluginRegistry: this.pluginRegistry,
      agentIframesContainer: this.agentIframesContainer,
      workerCode,
      getCostTracker: () => this.costTracker,
      getCostDisplay: () => this.costDisplay,
      getAgentCosts: () => this.agentCosts,
      getHubAgentCards: () => this.getHubAgentCardConfigs(),
      onAgentPersisted: (agent, hubAgentId, hubConnectionId) => {
        this.hubAgentMapping.set(hubAgentId, agent.id);
        agent.setHubEventSource(this.hubClient, hubConnectionId);
        agent.setHubConnected(true);
        this.hubClient.sendSubscribeAgent(hubConnectionId, hubAgentId);
      },
      onAgentShown: (agentId) => {
        this.notificationPanel?.markRead(agentId);
      },
    });

    // Initialize lifecycle manager
    this.lifecycleManager = new LifecycleManager({
      agentManager: this.agentManager,
      persistence: this.persistence,
      hookManager: this.hookManager,
      agentIframesContainer: this.agentIframesContainer,
      workerCode,
      getCostTracker: () => this.costTracker,
      getAgentCosts: () => this.agentCosts,
      updateStatusBar: (s: HTMLElement) => this.uiManager.updateStatusBar(s),
      dirtyTracker: this.dirtyTracker,
      hubClient: this.hubClient,
    });
  }

  private initSettingsPanel(mainContent: HTMLElement, statusState: HTMLElement): void {
    const settingsBtn = document.getElementById('settings-btn');
    if (settingsBtn) {
      this.settingsPanel = new SettingsPanel(document.body, {
        persistence: this.persistence,
        extensionLoader: this.extensionLoader,
        extensionConfigStore: this.extensionConfigStore,
        hubClient: this.hubClient,
        keyStore: this.keyStore,
        hookManager: this.hookManager,
        skillManager: this.skillManager,
        templateManager: this.templateManager,
        onApiKeyChange: (key: string, provider: string = 'anthropic') =>
          this.credentialsManager.handleApiKeyChange(key, provider),
        onApiKeyDelete: (provider?: string, hash?: string) =>
          this.credentialsManager.handleApiKeyDelete(provider, hash),
        onEnablePush: (hubConnectionId: string) => {
          this.settingsPanel?.hide();
          this.startPushSubscription(hubConnectionId);
        },
        onSwitchToLocalKeys: () => this.credentialsManager.switchToLocalKeys(),
      });

      settingsBtn.addEventListener('click', () => {
        this.settingsPanel?.toggle();
      });
    }
  }

  /**
   * Hide the loading screen and show the app
   */
  private hideLoadingScreen(): void {
    const loadingScreen = document.getElementById('loading-screen');
    const app = document.getElementById('app');
    if (loadingScreen) {
      loadingScreen.classList.add('fade-out');
      loadingScreen.addEventListener('animationend', () => {
        loadingScreen.classList.add('hidden');
        // Reveal app only after loading screen is fully hidden to prevent FOUC
        if (app) {
          app.classList.remove('loading');
        }
      }, { once: true });
    } else if (app) {
      // No loading screen — show app immediately
      app.classList.remove('loading');
    }
  }

  /**
   * Clear all settings for testing first-use experience
   */
  private async clearAllSettings(): Promise<void> {
    // Clear IndexedDB databases
    const databases = await indexedDB.databases();
    for (const db of databases) {
      if (db.name) {
        indexedDB.deleteDatabase(db.name);
      }
    }
    // Clear localStorage
    localStorage.clear();
    // Clear sessionStorage
    sessionStorage.clear();
  }

  /**
   * Discover hub agents on a newly connected hub and add them to the dashboard
   */
  private async discoverHubAgents(connectionId: string): Promise<void> {
    const conn = this.hubClient.getConnection(connectionId);
    if (!conn) return;

    const agents = await this.hubClient.listHubAgents(connectionId) as HubAgentSummary[];
    console.log(`[flo] Discovered ${agents.length} hub agent(s) on ${conn.name}`);

    for (const summary of agents) {
      // Skip if we already have a proxy for this agent
      if (this.hubAgentProxies.has(summary.hubAgentId)) continue;

      // Auto-link: if a local agent matches this hub agent, set hubPersistInfo and skip
      // Hub agent IDs follow the pattern hub-{localAgentId}-{timestamp}
      const localAgent = this.agentManager.getAllAgents().find(
        a => a.hubPersistInfo?.hubAgentId === summary.hubAgentId
          || summary.hubAgentId.startsWith('hub-' + a.id),
      );
      if (localAgent) {
        // Ensure hubPersistInfo is set (handles old saved state without it)
        if (!localAgent.hubPersistInfo) {
          localAgent.setHubPersistInfo({
            hubAgentId: summary.hubAgentId,
            hubName: conn.name,
            hubConnectionId: connectionId,
          });
          console.log(`[flo] Auto-linked local agent ${localAgent.config.name} to hub agent ${summary.hubAgentId}`);
        }
        // Always wire up hub event source and mapping
        this.hubAgentMapping.set(summary.hubAgentId, localAgent.id);
        localAgent.setHubEventSource(this.hubClient, connectionId);
        localAgent.setHubConnected(true);
        this.hubClient.sendSubscribeAgent(connectionId, summary.hubAgentId);
        continue;
      }

      const proxy = new HubAgentProxy(summary, this.hubClient, connectionId);
      this.hubAgentProxies.set(summary.hubAgentId, proxy);

      // Add card to dashboard if it's showing
      const dashboard = this.uiManager.getDashboard();
      if (dashboard) {
        dashboard.addHubAgentCard(proxy, {
          onSelect: (id) => this.adoptHubAgent(id).catch(err =>
            console.error('[flo] Failed to adopt hub agent:', err)),
          onPause: (id) => this.hubAgentProxies.get(id)?.sendAction('pause').catch(console.error),
          onResume: (id) => this.hubAgentProxies.get(id)?.sendAction('resume').catch(console.error),
          onStop: (id) => this.hubAgentProxies.get(id)?.sendAction('stop').catch(console.error),
          onKill: (id) => this.hubAgentProxies.get(id)?.sendAction('kill').catch(console.error),
          onRestore: (id) => console.log('[flo] Restore hub agent:', id),
        }, conn.name);
      }
    }
  }

  /**
   * Reconcile hub agent proxies with restored local agents.
   * Hub discovery may run before agents are restored from IDB, creating
   * duplicate HubAgentCards. This removes duplicates and auto-links locals.
   */
  private reconcileHubAgents(): void {
    const dashboard = this.uiManager.getDashboard();
    for (const [hubAgentId, proxy] of this.hubAgentProxies) {
      const localAgent = this.agentManager.getAllAgents().find(
        a => a.hubPersistInfo?.hubAgentId === hubAgentId
          || hubAgentId.startsWith('hub-' + a.id),
      );
      if (localAgent) {
        // Auto-link if not already linked
        if (!localAgent.hubPersistInfo) {
          const conn = this.hubClient.getConnection(proxy.hubConnectionId);
          localAgent.setHubPersistInfo({
            hubAgentId,
            hubName: conn?.name || 'Hub',
            hubConnectionId: proxy.hubConnectionId,
          });
          console.log(`[flo] Auto-linked local agent ${localAgent.config.name} to hub agent ${hubAgentId}`);
        }
        // Wire up hub event source and mapping
        this.hubAgentMapping.set(hubAgentId, localAgent.id);
        localAgent.setHubEventSource(this.hubClient, proxy.hubConnectionId);
        localAgent.setHubConnected(true);
        this.hubClient.sendSubscribeAgent(proxy.hubConnectionId, hubAgentId);
        // Remove duplicate hub card
        dashboard?.removeHubAgentCard(hubAgentId);
        this.hubAgentProxies.delete(hubAgentId);
      }
    }
  }

  /**
   * Remove hub agent proxies and cards for a disconnected hub
   */
  private removeHubAgentsForConnection(connectionId: string): void {
    const dashboard = this.uiManager.getDashboard();
    for (const [id, proxy] of this.hubAgentProxies) {
      if (proxy.hubConnectionId === connectionId) {
        dashboard?.removeHubAgentCard(id);
        this.hubAgentProxies.delete(id);
        this.hubAgentMapping.delete(id);
      }
    }
    // Clear hub event source on linked local agents for this connection
    for (const agent of this.agentManager.getAllAgents()) {
      if (agent.hubPersistInfo?.hubConnectionId === connectionId) {
        agent.clearHubEventSource();
        agent.setHubConnected(false);
        this.hubAgentMapping.delete(agent.hubPersistInfo.hubAgentId);
      }
    }
  }

  /**
   * Get hub agent card configs for UIManager to render on dashboard
   */
  private getHubAgentCardConfigs() {
    const configs: Array<{ proxy: HubAgentProxy; callbacks: any; hubName: string }> = [];
    const localAgents = this.agentManager.getAllAgents();
    for (const proxy of this.hubAgentProxies.values()) {
      // Skip hub agents that are represented by a local agent
      const isLocallyOwned = localAgents.some(
        a => a.hubPersistInfo?.hubAgentId === proxy.hubAgentId
          || proxy.hubAgentId.startsWith('hub-' + a.id),
      );
      if (isLocallyOwned) continue;
      const conn = this.hubClient.getConnection(proxy.hubConnectionId);
      configs.push({
        proxy,
        callbacks: {
          onSelect: (id: string) => this.adoptHubAgent(id).catch(err =>
            console.error('[flo] Failed to adopt hub agent:', err)),
          onPause: (id: string) => this.hubAgentProxies.get(id)?.sendAction('pause').catch(console.error),
          onResume: (id: string) => this.hubAgentProxies.get(id)?.sendAction('resume').catch(console.error),
          onStop: (id: string) => this.hubAgentProxies.get(id)?.sendAction('stop').catch(console.error),
          onKill: (id: string) => this.hubAgentProxies.get(id)?.sendAction('kill').catch(console.error),
          onRestore: (id: string) => console.log('[flo] Restore hub agent:', id),
        },
        hubName: conn?.name || 'Hub',
      });
    }
    return configs;
  }

  /**
   * Adopt a remote hub agent: create a local agent wrapper, wire it to the hub,
   * and show the focused view. Used when a second browser clicks a HubAgentCard.
   */
  private async adoptHubAgent(hubAgentId: string): Promise<void> {
    const proxy = this.hubAgentProxies.get(hubAgentId);
    if (!proxy) {
      console.error('[flo] No proxy found for hub agent:', hubAgentId);
      return;
    }

    // 1. Subscribe first — hub requires subscription before allowing restore_agent
    this.hubClient.sendSubscribeAgent(proxy.hubConnectionId, hubAgentId);

    // 2. Restore session from hub
    const session = await proxy.restore() as SerializedSession;
    if (!session?.config) {
      console.error('[flo] Failed to restore session for hub agent:', hubAgentId);
      this.hubClient.sendUnsubscribeAgent(proxy.hubConnectionId, hubAgentId);
      return;
    }

    // Validate required session config fields
    const { config } = session;
    if (typeof config.name !== 'string' || !config.name ||
        typeof config.model !== 'string' || !config.model ||
        (config.systemPrompt !== undefined && typeof config.systemPrompt !== 'string')) {
      console.error('[flo] Invalid session config from hub agent:', hubAgentId);
      return;
    }

    const conn = this.hubClient.getConnection(proxy.hubConnectionId);
    const hubName = conn?.name || 'Hub';

    // 2. Create local agent container with session config
    const agent = this.agentManager.adoptHubAgent({
      config: session.config,
      hubPersistInfo: {
        hubAgentId,
        hubName,
        hubConnectionId: proxy.hubConnectionId,
      },
    });

    // 3. Wire hub event source and mapping
    this.hubAgentMapping.set(hubAgentId, agent.id);
    agent.setHubEventSource(this.hubClient, proxy.hubConnectionId);
    agent.setHubConnected(true);

    // 4. Re-subscribe now that local agent is wired — triggers state, DOM, conversation delivery
    this.hubClient.sendSubscribeAgent(proxy.hubConnectionId, hubAgentId);

    // 5. Remove proxy and hub card from dashboard
    const dashboard = this.uiManager.getDashboard();
    dashboard?.removeHubAgentCard(hubAgentId);
    this.hubAgentProxies.delete(hubAgentId);

    // 6. Show focused view
    this.uiManager.showAgent(agent.id, this.mainContent, this.statusState);
  }

  /**
   * Start the push notification subscription flow for a hub connection.
   */
  private startPushSubscription(hubConnectionId: string): void {
    // Clean up previous flow if any
    if (this.pushFlow) {
      this.pushFlow.hideOverlay();
    }

    this.pushFlow = new PushSubscribeFlow(this.hubClient, hubConnectionId);

    // Listen for subscribe results to forward to the flow
    const unsub = this.hubClient.onPushEvent((msg: any) => {
      if (msg.type === 'push_subscribe_result') {
        this.pushFlow?.handleSubscribeResult(msg);
      }
    });

    // Start the flow (shows overlay, requests permission, etc.)
    this.pushFlow.start().catch(err => {
      console.error('[push] Flow failed:', err);
    });

    // Clean up the event listener when the flow overlay closes
    const checkInterval = setInterval(() => {
      if (!this.pushFlow?.isVisible()) {
        unsub();
        clearInterval(checkInterval);
      }
    }, 1000);
  }

  private async initializeApp(mainContent: HTMLElement, statusState: HTMLElement): Promise<void> {
    console.log(`[flo:restore] initializeApp: starting`);

    // Initialize API access (SW registration, hub connection)
    await this.credentialsManager.initializeApiAccess();
    console.log(`[flo:restore] initializeApp: API access initialized`);

    // Setup lifecycle handlers for reload persistence
    this.lifecycleManager.setupLifecycleHandlers();
    this.lifecycleManager.startAutoSave();
    console.log(`[flo:restore] initializeApp: lifecycle handlers set up`);

    // Check for saved agents from previous session
    // Try IDB first, fall back to localStorage (IDB writes may not complete on mobile Safari)
    console.log(`[flo:restore] initializeApp: loading agent registry...`);
    let savedAgents = await this.persistence.loadAgentRegistry();
    if (savedAgents.length === 0) {
      const lsFallback = LifecycleManager.loadAgentRegistryFromLocalStorage();
      if (lsFallback) {
        console.log(`[flo:restore] initializeApp: IDB empty, using localStorage fallback (${lsFallback.length} agents)`);
        savedAgents = lsFallback;
      }
    }
    // Clear the localStorage backup now that we've read it
    LifecycleManager.clearAgentRegistryLocalStorage();
    console.log(`[flo:restore] initializeApp: loadAgentRegistry returned ${savedAgents.length} agent(s)`);

    if (savedAgents.length > 0) {
      // Restore agents from previous session
      console.log(`[flo:restore] initializeApp: calling restoreAgents...`);
      const { lastActiveAgentId, agentsToAutoStart } = await this.lifecycleManager.restoreAgents(
        savedAgents,
        statusState,
      );
      console.log(`[flo:restore] initializeApp: restoreAgents complete — lastActive=${lastActiveAgentId}, toAutoStart=${agentsToAutoStart.length}`);

      // Update cost display after restoring global usage
      if (this.costTracker && this.costDisplay) {
        this.costDisplay.update(this.costTracker.getBudgetStatus());
      }

      // Show dashboard with restored agents
      this.uiManager.showDashboard(mainContent, statusState);

      // Auto-start agents that were in active states
      // Must await to prevent race condition with showAgent
      console.log(`[flo:restore] initializeApp: auto-starting ${agentsToAutoStart.length} agent(s)...`);
      await Promise.all(agentsToAutoStart.map(agent =>
        this.lifecycleManager.autoStartRestoredAgent(agent, statusState)
      ));
      console.log(`[flo:restore] initializeApp: auto-start complete`);

      // Reconcile AFTER autoStart: hub discovery may have run before agents were restored.
      // Auto-link local agents to hub agents, wire hub event source, and subscribe.
      // Must run after autoStart because restartAgent() clears hub event subscriptions
      // and buffers. With iframes ready, hub subscribe responses (DOM state, conversation
      // history) can be applied immediately.
      this.reconcileHubAgents();

      // If there was an active agent, switch to it (agent is now 'running', not 'pending')
      if (lastActiveAgentId) {
        console.log(`[flo:restore] initializeApp: showing last active agent ${lastActiveAgentId}`);
        this.uiManager.showAgent(lastActiveAgentId, mainContent, statusState);
      }
      console.log(`[flo:restore] initializeApp: restore flow complete`);
    } else {
      // Fresh start
      console.log(`[flo:restore] initializeApp: no saved agents — fresh start`);
      this.uiManager.showDashboard(mainContent, statusState);
    }
  }
  private setupIosViewportFix(): void {
    const ua = navigator.userAgent;
    const isIos = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (!isIos) return;

    const viewport = document.querySelector('meta[name="viewport"]');
    if (!viewport) return;

    const resetZoom = () => {
      const vv = window.visualViewport;
      if (vv && vv.scale > 1.05) {
        const content = viewport.getAttribute('content') || '';
        viewport.setAttribute('content', content + ', maximum-scale=1.0');
        requestAnimationFrame(() => {
          viewport.setAttribute('content', content);
        });
      }
    };

    // Reset after input blur (keyboard dismiss)
    document.addEventListener('focusout', () => {
      setTimeout(resetZoom, 100);
    });

    // Reset on visualViewport resize (catches window.prompt close)
    if (window.visualViewport) {
      let wasZoomed = false;
      window.visualViewport.addEventListener('resize', () => {
        const zoomed = window.visualViewport!.scale > 1.05;
        if (wasZoomed && !zoomed) {
          // Zoom just ended naturally — ensure it's fully at 1.0
          setTimeout(resetZoom, 50);
        }
        wasZoomed = zoomed;
      });
    }
  }
}

// Entry point
const shell = new Shell();
shell.init().catch(console.error);
