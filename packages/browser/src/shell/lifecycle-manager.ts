import type { AgentManager, SavedAgentState } from './agent-manager.js';
import type { PersistenceLayer } from './persistence.js';
import type { HookManager } from './hook-manager.js';
import type { DirtyTracker } from './dirty-tracker.js';
import type { PersistHandler } from './persist-handler.js';
import type { CostTracker, SerializedDomState, TokenUsage } from '@flo-monster/core';
import type { AgentContainer } from '../agent/agent-container.js';
import { getStorageProvider } from '../storage/agent-storage.js';
import { triggerVersionCheck } from './sw-registration.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';

/** Detect iOS (Safari, Chrome on iOS, etc.) where BFCache requires WebSocket cleanup. */
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export interface LifecycleManagerDeps {
  agentManager: AgentManager;
  persistence: PersistenceLayer;
  hookManager: HookManager;
  agentIframesContainer: HTMLElement;
  workerCode: string;
  getCostTracker: () => CostTracker | null;
  getAgentCosts: () => Map<string, number>;
  updateStatusBar: (statusState: HTMLElement) => void;
  dirtyTracker?: DirtyTracker;
  persistHandler?: PersistHandler;
  getHubAgentMapping?: () => Map<string, { hubConnectionId: string; hubAgentId: string }>;
  hubClient?: {
    sendDomStateUpdate(connectionId: string, hubAgentId: string, domState: SerializedDomState): void;
    sendVisibilityState?(connectionId: string, visible: boolean): void;
    getConnections?(): Array<{ id: string }>;
    suspend?(): void;
    resume?(): Promise<void>;
  } | null;
}

/**
 * Manages agent lifecycle: persistence across reloads, DOM capture,
 * beforeunload handling, and agent restoration.
 */
export class LifecycleManager {
  // DOM auto-save debounce timers per agent
  private domCaptureDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly DOM_CAPTURE_DEBOUNCE_MS = 500;

  private autoSaveTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly AUTO_SAVE_INTERVAL_MS = 60000;

  constructor(private deps: LifecycleManagerDeps) {}

  /**
   * Setup page lifecycle handlers to persist agent state across reloads.
   * Uses visibilitychange (reliable) and beforeunload (backup).
   *
   * On mobile Safari, the async IDB transaction may not complete before page teardown.
   * We always write a synchronous localStorage backup first, then attempt the async IDB write.
   */
  setupLifecycleHandlers(): void {
    // Visibility change is the main trigger - fires reliably on tab background/mobile switch
    document.addEventListener('visibilitychange', async () => {
      console.log(`[flo:save] visibilitychange fired: ${document.visibilityState}`);
      if (document.visibilityState === 'hidden') {
        console.log(`[flo:save] visibilitychange=hidden — saving...`);

        // Report visibility state to hub for push notification routing
        this.sendVisibilityToHub(false);

        // On iOS, suspend hub WebSocket connections FIRST (synchronous, before any async work).
        // iOS may freeze/terminate the process during async operations — WebSockets
        // must be closed before that happens or the page won't survive BFCache.
        // On desktop, WebSockets survive tab switches fine — don't disconnect.
        if (isIOS) {
          this.deps.hubClient?.suspend?.();
        }

        // Synchronous localStorage backup (survives page teardown)
        this.saveAgentRegistryToLocalStorage();
        try {
          await this.saveAgentRegistry();
          console.log(`[flo:save] visibilitychange: saveAgentRegistry complete`);
        } catch (err) {
          console.error(`[flo:save] visibilitychange: saveAgentRegistry FAILED`, err);
        }
        try {
          await this.captureFocusedAgentDom();
          console.log(`[flo:save] visibilitychange: captureFocusedAgentDom complete`);
        } catch (err) {
          console.error(`[flo:save] visibilitychange: captureFocusedAgentDom FAILED`, err);
        }

        console.log(`[flo:save] visibilitychange=hidden — save complete`);
      } else if (document.visibilityState === 'visible') {
        if (isIOS) {
          // Resume suspended hub connections (only suspended on iOS)
          this.deps.hubClient?.resume?.();
        }

        // Check for app/SW updates on every foreground return.
        // SPA has no navigations after initial load, so the SW's piggyback
        // check never fires again. triggerVersionCheck is hourly-throttled
        // in the SW; browsers throttle reg.update() to ~1/min.
        triggerVersionCheck();
        navigator.serviceWorker?.getRegistration().then(reg => {
          reg?.update().catch(() => {});
        });

        // Report visibility state to hub for push notification routing
        // (deferred slightly on iOS to let WebSocket reconnect first)
        const delay = isIOS ? 500 : 0;
        setTimeout(() => this.sendVisibilityToHub(true), delay);
      }
    });

    // beforeunload as backup (less reliable on mobile)
    window.addEventListener('beforeunload', (event) => {
      console.log(`[flo:save] beforeunload fired`);
      // Synchronous localStorage backup
      this.saveAgentRegistryToLocalStorage();
      // Also attempt async IDB save (fire-and-forget)
      this.saveAgentRegistrySync();

      // Warn if there are unsaved hub changes
      if (this.deps.dirtyTracker?.hasAnyDirty()) {
        event.preventDefault();
        // Setting returnValue triggers the browser's "Leave site?" dialog
        event.returnValue = 'You have unsaved changes. Are you sure you want to leave?';
      }
    });
  }

  /**
   * Start periodic auto-save timer. Only saves agents that are dirty
   * and have a hub mapping (i.e., have been persisted to a hub).
   */
  startAutoSave(intervalMs: number = LifecycleManager.AUTO_SAVE_INTERVAL_MS): void {
    this.stopAutoSave();
    this.autoSaveTimer = setInterval(() => {
      this.autoSaveIfDirty();
    }, intervalMs);
  }

  stopAutoSave(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
  }

  /**
   * Auto-save dirty agents that have been persisted to a hub.
   * Called periodically by the auto-save timer.
   */
  async autoSaveIfDirty(): Promise<void> {
    const { dirtyTracker, persistHandler, getHubAgentMapping } = this.deps;
    if (!dirtyTracker || !persistHandler || !getHubAgentMapping) return;

    const hubMapping = getHubAgentMapping();
    const dirtyAgents = dirtyTracker.getDirtyAgents();

    for (const agentId of dirtyAgents) {
      const mapping = hubMapping.get(agentId);
      if (!mapping) continue; // Not persisted to hub, skip

      const agent = this.deps.agentManager.getAgent(agentId);
      if (!agent) continue;

      try {
        console.log(`[flo:auto-save] Saving ${agent.config.name} to hub...`);
        const result = await persistHandler.persistAgent(agent, {
          hubConnectionId: mapping.hubConnectionId,
          includeFiles: true,
        });
        if (result.success) {
          dirtyTracker.markClean(agentId);
          console.log(`[flo:auto-save] Saved ${agent.config.name}`);
        } else {
          console.warn(`[flo:auto-save] Failed to save ${agent.config.name}: ${result.error}`);
        }
      } catch (err) {
        console.warn(`[flo:auto-save] Error saving ${agent.config.name}:`, err);
      }
    }
  }

  /**
   * Save all agent states to persistence (async version)
   */
  async saveAgentRegistry(): Promise<void> {
    try {
      console.log(`[flo:save] saveAgentRegistry: getting all saved states...`);
      const savedStates = this.deps.agentManager.getAllSavedStates();
      console.log(`[flo:save] saveAgentRegistry: got ${savedStates.length} states:`, savedStates.map(s => `${s.name}(${s.state},active=${s.wasActive})`));
      const agentCosts = this.deps.getAgentCosts();
      // Add per-agent costs
      for (const state of savedStates) {
        state.accumulatedCost = agentCosts.get(state.id) || 0;
      }
      if (savedStates.length > 0) {
        console.log(`[flo] Saving ${savedStates.length} agent(s):`, savedStates.map(s => `${s.name}(${s.state})`).join(', '));
        await this.deps.persistence.saveAgentRegistry(savedStates);
        console.log(`[flo] Saved ${savedStates.length} agent(s) for reload persistence`);
      } else {
        console.log('[flo] No agents to save');
      }

      // Save per-agent usage for cost display restoration
      const costTracker = this.deps.getCostTracker();
      if (costTracker) {
        const perAgentUsage = costTracker.getPerAgentUsage();
        const usageData: Record<string, { model: string; usage: TokenUsage }> = {};
        for (const [id, entry] of perAgentUsage) {
          usageData[id] = { model: entry.model, usage: entry.usage };
        }
        const settings = await this.deps.persistence.getSettings();
        settings.perAgentUsage = usageData;
        delete settings.globalUsage; // Clean up legacy field
        await this.deps.persistence.saveSettings(settings);
        console.log(`[flo] Saved per-agent usage for ${Object.keys(usageData).length} agent(s)`);
      }
    } catch (err) {
      console.warn('[flo] Failed to save agent registry:', err);
    }
  }

  private static readonly LS_AGENT_REGISTRY_KEY = 'flo-agent-registry';

  /**
   * Synchronously save agent registry to localStorage.
   * localStorage.setItem() is synchronous and completes before page teardown,
   * unlike IDB transactions which may be aborted on mobile Safari.
   */
  private saveAgentRegistryToLocalStorage(): void {
    try {
      const savedStates = this.deps.agentManager.getAllSavedStates();
      const agentCosts = this.deps.getAgentCosts();
      for (const state of savedStates) {
        state.accumulatedCost = agentCosts.get(state.id) || 0;
      }
      if (savedStates.length > 0) {
        const data = JSON.stringify({ value: savedStates, savedAt: Date.now() });
        localStorage.setItem(LifecycleManager.LS_AGENT_REGISTRY_KEY, data);
        console.log(`[flo:save] localStorage backup: saved ${savedStates.length} agent(s)`);
      } else {
        localStorage.removeItem(LifecycleManager.LS_AGENT_REGISTRY_KEY);
        console.log(`[flo:save] localStorage backup: no agents, cleared`);
      }
    } catch (err) {
      console.warn(`[flo:save] localStorage backup failed:`, err);
    }
  }

  /**
   * Load agent registry from localStorage fallback.
   * Returns null if no data found (caller should try IDB).
   */
  static loadAgentRegistryFromLocalStorage(): SavedAgentState[] | null {
    try {
      const raw = localStorage.getItem(LifecycleManager.LS_AGENT_REGISTRY_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.value) && data.value.length > 0) {
        const ageSec = data.savedAt ? ((Date.now() - data.savedAt) / 1000).toFixed(1) : '?';
        console.log(`[flo:restore] localStorage fallback: found ${data.value.length} agent(s), saved ${ageSec}s ago`);
        return data.value;
      }
    } catch (err) {
      console.warn(`[flo:restore] localStorage fallback read failed:`, err);
    }
    return null;
  }

  /**
   * Clear the localStorage agent registry backup.
   */
  static clearAgentRegistryLocalStorage(): void {
    localStorage.removeItem(LifecycleManager.LS_AGENT_REGISTRY_KEY);
  }

  /**
   * Save agent registry synchronously (for beforeunload)
   * Uses IndexedDB transaction that may complete after unload
   */
  saveAgentRegistrySync(): void {
    try {
      const savedStates = this.deps.agentManager.getAllSavedStates();
      const agentCosts = this.deps.getAgentCosts();
      // Add per-agent costs
      for (const state of savedStates) {
        state.accumulatedCost = agentCosts.get(state.id) || 0;
      }
      if (savedStates.length > 0) {
        // Fire-and-forget - may not complete but visibility change should have saved already
        this.deps.persistence.saveAgentRegistry(savedStates).catch(() => {
          // Ignore errors in sync save
        });
      }

      // Save per-agent usage (fire-and-forget)
      const costTracker = this.deps.getCostTracker();
      if (costTracker) {
        const perAgentUsage = costTracker.getPerAgentUsage();
        const usageData: Record<string, { model: string; usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } }> = {};
        for (const [id, entry] of perAgentUsage) {
          usageData[id] = { model: entry.model, usage: entry.usage };
        }
        this.deps.persistence.getSettings().then(settings => {
          settings.perAgentUsage = usageData;
          delete settings.globalUsage;
          return this.deps.persistence.saveSettings(settings);
        }).catch(() => {
          // Ignore errors
        });
      }
    } catch {
      // Ignore errors in sync context
    }
  }

  /**
   * Capture DOM state for the currently focused agent.
   * Saves to the agent's file storage as _dom_state.json
   */
  async captureFocusedAgentDom(): Promise<void> {
    const agent = this.deps.agentManager.getActiveAgent();
    if (!agent) return;

    try {
      const domState = await agent.captureDomState();
      if (domState) {
        const provider = await getStorageProvider();
        await provider.writeFile(agent.id, '_dom_state.json', JSON.stringify(domState));
        console.log(`[flo] Captured DOM state for ${agent.config.name}`);

        // Sync to hub for hub-persisted agents
        this.syncDomStateToHub(agent, domState);
      }
    } catch (err) {
      // Best effort - don't block
      console.warn('[flo] Failed to capture DOM state:', err);
    }
  }

  /**
   * Schedule a debounced DOM capture for a specific agent.
   * If multiple DOM mutations happen rapidly, only capture once after they settle.
   */
  scheduleDomCaptureForAgent(agentId: string): void {
    // Clear any existing timer for this agent
    const existingTimer = this.domCaptureDebounceTimers.get(agentId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Schedule new capture
    const timer = setTimeout(() => {
      this.domCaptureDebounceTimers.delete(agentId);
      this.captureDomStateForAgent(agentId);
    }, LifecycleManager.DOM_CAPTURE_DEBOUNCE_MS);

    this.domCaptureDebounceTimers.set(agentId, timer);
  }

  /**
   * Capture DOM state for a specific agent by ID.
   * Works for both focused and minimized agents.
   */
  async captureDomStateForAgent(agentId: string): Promise<void> {
    const agent = this.deps.agentManager.getAgent(agentId);
    if (!agent) return;

    // Only capture if agent is running (has an active iframe)
    if (agent.state !== 'running' && agent.state !== 'paused') {
      return;
    }

    try {
      const domState = await agent.captureDomState();
      if (domState) {
        const provider = await getStorageProvider();
        await provider.writeFile(agentId, '_dom_state.json', JSON.stringify(domState));
        console.log(`[flo] Auto-saved DOM state for ${agent.config.name}`);

        // Sync to hub for hub-persisted agents
        this.syncDomStateToHub(agent, domState);
      }
    } catch (err) {
      // Best effort - don't block
      console.warn(`[flo] Failed to auto-save DOM state for ${agent.config.name}:`, err);
    }
  }

  /**
   * Restore agents from saved registry.
   * Called on page load if saved agents exist.
   * Returns the last active agent ID, if any.
   */
  async restoreAgents(
    savedAgents: SavedAgentState[],
    statusState: HTMLElement,
  ): Promise<{ lastActiveAgentId: string | null; agentsToAutoStart: AgentContainer[] }> {
    console.log(`[flo] Restoring ${savedAgents.length} agent(s) from reload persistence`);

    let lastActiveAgentId: string | null = null;
    const agentsToAutoStart: AgentContainer[] = [];
    const agentCosts = this.deps.getAgentCosts();

    for (const saved of savedAgents) {
      try {
        const agent = this.deps.agentManager.restoreAgent(saved);

        if (saved.wasActive) {
          lastActiveAgentId = agent.id;
        }

        // Restore per-agent cost
        if (saved.accumulatedCost) {
          agentCosts.set(agent.id, saved.accumulatedCost);
        }

        // Track agents that were in active states for auto-restart
        const wasActive = saved.state === 'running' || saved.state === 'paused';
        if (wasActive) {
          agentsToAutoStart.push(agent);
        }

        // Try to restore DOM state from file
        const domRestored = await this.tryRestoreDom(agent);
        agent.setRestorationContext({ domRestored });

        console.log(`[flo] Restored agent: ${agent.config.name} (saved state: ${saved.state}, restored as: ${agent.state}, DOM: ${domRestored ? 'yes' : 'no'}${wasActive ? ', will auto-start' : ''}, cost: $${(saved.accumulatedCost || 0).toFixed(4)})`);
      } catch (err) {
        console.warn(`[flo] Failed to restore agent ${saved.name}:`, err);
      }
    }

    // Clear the saved registry now that we've restored
    console.log(`[flo:restore] restoreAgents: clearing saved registry...`);
    await this.deps.persistence.clearAgentRegistry();
    LifecycleManager.clearAgentRegistryLocalStorage();
    console.log(`[flo:restore] restoreAgents: registry cleared (IDB + localStorage)`);

    // Restore per-agent usage from persisted data
    try {
      const settings = await this.deps.persistence.getSettings();
      const costTracker = this.deps.getCostTracker();
      if (costTracker) {
        if (settings.perAgentUsage) {
          const entries = Object.entries(settings.perAgentUsage as Record<string, { model: string; usage: TokenUsage }>);
          for (const [agentId, entry] of entries) {
            costTracker.setAgentUsage(agentId, entry.model, entry.usage);
          }
          console.log(`[flo] Restored per-agent usage for ${entries.length} agent(s)`);
        } else if (settings.globalUsage) {
          // Legacy fallback: restore old-style global usage
          costTracker.addUsage(DEFAULT_MODEL, settings.globalUsage);
          console.log(`[flo] Restored legacy global usage: ${settings.globalUsage.input_tokens} in / ${settings.globalUsage.output_tokens} out`);
        }
      }
    } catch (err) {
      console.warn('[flo] Failed to restore usage:', err);
    }

    return { lastActiveAgentId, agentsToAutoStart };
  }

  /**
   * Auto-start a restored agent that was in an active state before reload.
   */
  async autoStartRestoredAgent(agent: AgentContainer, statusState: HTMLElement): Promise<void> {
    try {
      console.log(`[flo] Auto-starting restored agent: ${agent.config.name} (state: ${agent.state})`);

      // Hub-persisted agents may already have their state changed by the hub via
      // discoverHubAgents (async fire-and-forget) auto-linking and subscribing before
      // autoStart runs. If state is already 'running', the iframe still needs
      // to be created. Use forceRestart() which bypasses the state check.
      if (agent.hubPersistInfo && agent.state !== 'stopped' && agent.state !== 'killed' && agent.state !== 'error') {
        console.log(`[flo:restore] autoStart ${agent.config.name}: hub-persisted agent already in '${agent.state}', using forceRestart`);
        agent.forceRestart();
      } else {
        // Restart puts the agent back to 'pending' state
        console.log(`[flo:restore] autoStart ${agent.config.name}: calling restartAgent (current state: ${agent.state})`);
        this.deps.agentManager.restartAgent(agent.id);
      }
      console.log(`[flo:restore] autoStart ${agent.config.name}: after restart, state=${agent.state}`);

      if (agent.state === 'pending') {
        console.log(`[flo:restore] autoStart ${agent.config.name}: calling start()...`);
        await agent.start(this.deps.agentIframesContainer, this.deps.workerCode);
        console.log(`[flo:restore] autoStart ${agent.config.name}: start() complete, state=${agent.state}`);
        this.deps.updateStatusBar(statusState);

        // Send hooks config
        const hooksConfig = this.deps.hookManager.getHooksConfig();
        agent.getIframeElement()?.contentWindow?.postMessage({
          type: 'hooks_config',
          activeHookTypes: hooksConfig.activeHookTypes,
        }, '*');

        // Apply pending DOM restore — skip for hub-persisted agents (hub DOM takes precedence)
        if (agent.hubPersistInfo) {
          // Clear local DOM — hub DOM will be applied via pendingHubDomState
          delete (agent as any)._pendingDomRestore;
          console.log(`[flo] Skipping local DOM restore for hub-persisted agent ${agent.config.name} — hub DOM takes precedence`);
          // Apply buffered hub DOM state if available
          if (agent.pendingHubDomState) {
            await new Promise(resolve => setTimeout(resolve, 100));
            await agent.restoreDomState(agent.pendingHubDomState);
            (agent as any)._pendingHubDomState = null;
            console.log(`[flo] Applied hub DOM state for ${agent.config.name}`);
          }
        } else {
          const pendingDom = (agent as any)._pendingDomRestore;
          if (pendingDom) {
            delete (agent as any)._pendingDomRestore;
            console.log(`[flo] Restoring DOM for ${agent.config.name}:`, {
              hasViewportHtml: !!pendingDom.viewportHtml,
              viewportHtmlLength: pendingDom.viewportHtml?.length || 0,
            });
            await new Promise(resolve => setTimeout(resolve, 100));
            await agent.restoreDomState(pendingDom);
            console.log(`[flo] DOM restore message sent for ${agent.config.name}`);
          } else {
            console.log(`[flo] No pending DOM to restore for ${agent.config.name}`);
          }
        }

        console.log(`[flo] Auto-started restored agent: ${agent.config.name}`);
      }
    } catch (err) {
      console.error(`[flo] Failed to auto-start agent ${agent.config.name}:`, err);
    }
  }

  /**
   * Sync captured DOM state to hub for hub-persisted agents.
   * Best effort — errors are logged but don't propagate.
   */
  private syncDomStateToHub(agent: AgentContainer, domState: SerializedDomState): void {
    const info = agent.hubPersistInfo;
    if (!info || !this.deps.hubClient) return;
    // Only sync if agent has an active hub connection (not cleared by restart)
    if (!agent.hubConnected) return;

    try {
      this.deps.hubClient.sendDomStateUpdate(
        info.hubConnectionId,
        info.hubAgentId,
        domState,
      );
    } catch (err) {
      console.warn(`[flo] Failed to sync DOM state to hub for ${agent.config.name}:`, err);
    }
  }

  /**
   * Send visibility state to all connected hubs for push notification routing.
   * Best effort — errors are silently ignored.
   */
  private sendVisibilityToHub(visible: boolean): void {
    const client = this.deps.hubClient;
    if (!client?.sendVisibilityState || !client?.getConnections) return;
    try {
      const connections = client.getConnections();
      for (const conn of connections) {
        client.sendVisibilityState(conn.id, visible);
      }
    } catch {
      // Best effort — ignore errors
    }
  }

  /**
   * Try to restore DOM state from saved file.
   * Returns true if successful, false otherwise.
   */
  private async tryRestoreDom(agent: AgentContainer): Promise<boolean> {
    try {
      const provider = await getStorageProvider();
      const content = await provider.readFile(agent.id, '_dom_state.json');
      if (!content) return false;

      const domState = JSON.parse(content);

      // Store for later - will be applied after agent starts
      // The agent.restoreDomState will be called after start()
      (agent as any)._pendingDomRestore = domState;

      // Keep the file - it will be overwritten by the next capture
      // This allows rapid reloads without losing DOM state
      return true;
    } catch {
      return false;
    }
  }
}
