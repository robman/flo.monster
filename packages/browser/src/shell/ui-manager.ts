import { AgentView } from '../ui/agent-view.js';
import { Dashboard } from '../ui/dashboard.js';
import { NewAgentDialog } from '../ui/new-agent-dialog.js';
import { CostDisplay } from '../ui/cost-display.js';
import { SaveAsTemplateDialog } from '../ui/save-template-dialog.js';
import { PersistDialog } from '../ui/persist-dialog.js';
import { AgentSettingsPanel } from '../ui/agent-settings-panel.js';
import { AgentFilesPanel } from '../ui/agent-files-panel.js';
import { TemplatesPanel } from '../ui/templates-panel.js';
import { PersistHandler } from './persist-handler.js';
import { loadCurrentSkin, getSkinBaseUrl, getSkinId, OuterSkinContainer } from '../outer-skin/index.js';
import { NavHeader } from '../navigation/index.js';
import { getBuiltinToolDefinitions } from '../agent/tools/builtin-tools.js';
import type { AgentCardCallbacks } from '../ui/agent-card.js';
import type { AgentContainer } from '../agent/agent-container.js';
import type { LoadedOuterSkin } from '../outer-skin/loader.js';
import type { AgentManager } from './agent-manager.js';
import type { MessageRelay } from './message-relay.js';
import type { PersistenceLayer } from './persistence.js';
import type { HookManager } from './hook-manager.js';
import type { SkillManager } from './skill-manager.js';
import type { TemplateManager } from './template-manager.js';
import type { HubClient } from './hub-client.js';
import type { KeyStore } from './key-store.js';
import type { AgentViewState, CostTracker, ToolPluginRegistry } from '@flo-monster/core';
import type { HubAgentProxy } from './hub-agent-proxy.js';
import type { HubAgentCardCallbacks } from '../ui/hub-agent-card.js';

export interface HubAgentCardConfig {
  proxy: HubAgentProxy;
  callbacks: HubAgentCardCallbacks;
  hubName: string;
}

export interface UIManagerDeps {
  agentManager: AgentManager;
  messageRelay: MessageRelay;
  persistence: PersistenceLayer;
  hookManager: HookManager;
  skillManager: SkillManager;
  templateManager: TemplateManager;
  hubClient: HubClient;
  keyStore: KeyStore;
  pluginRegistry: ToolPluginRegistry;
  agentIframesContainer: HTMLElement;
  workerCode: string;
  getCostTracker: () => CostTracker | null;
  getCostDisplay: () => CostDisplay | null;
  getAgentCosts: () => Map<string, number>;
  getHubAgentCards?: () => HubAgentCardConfig[];
  onAgentPersisted?: (agent: AgentContainer, hubAgentId: string, hubConnectionId: string) => void;
  onAgentShown?: (agentId: string) => void;
}

/**
 * Manages all UI views: dashboard, focused agent view, homepage,
 * panel toggling, and view transitions.
 */
export class UIManager {
  // UI panels
  private agentSettingsPanel: AgentSettingsPanel | null = null;
  private agentFilesPanel: AgentFilesPanel | null = null;
  private templatesPanel: TemplatesPanel | null = null;
  private persistHandler: PersistHandler | null = null;
  private persistDialog: PersistDialog | null = null;

  // UI state
  private dashboard: Dashboard | null = null;
  private agentView: AgentView | null = null;
  private currentMode: 'homepage' | 'dashboard' | 'focused' = 'dashboard';
  private activeAgentEventUnsub: (() => void) | null = null;
  private browseStreamUnsubs: (() => void)[] = [];
  private browseStreamInfo: { connectionId: string; agentId: string } | null = null;
  private browseStreamRetryTimer: ReturnType<typeof setTimeout> | null = null;

  // Outer skin system
  private outerSkin: LoadedOuterSkin | null = null;
  private outerSkinContainer: OuterSkinContainer | null = null;
  private navHeader: NavHeader | null = null;

  constructor(private deps: UIManagerDeps) {}

  private getPersistHandler(): PersistHandler {
    if (!this.persistHandler) {
      this.persistHandler = new PersistHandler(
        this.deps.hubClient,
        this.deps.messageRelay,
        this.deps.skillManager,
        undefined,  // extensionLoader - not currently passed
        this.deps.hookManager,
      );
    }
    return this.persistHandler;
  }

  getCurrentMode(): 'homepage' | 'dashboard' | 'focused' {
    return this.currentMode;
  }

  getDashboard(): Dashboard | null {
    return this.dashboard;
  }

  getOuterSkin(): LoadedOuterSkin | null {
    return this.outerSkin;
  }

  /**
   * Load the outer skin (call once during init).
   */
  async loadOuterSkin(): Promise<void> {
    try {
      this.outerSkin = await loadCurrentSkin();
      console.log('[flo] Loaded outer skin:', this.outerSkin.manifest.id);
    } catch (err) {
      console.warn('[flo] Failed to load outer skin:', err);
    }
  }

  /**
   * Initialize agent settings and files panels (call once during init).
   */
  initPanels(): void {
    // Agent settings panel
    this.agentSettingsPanel = new AgentSettingsPanel(document.body, {
      onResetUsage: (agentId: string) => {
        const costTracker = this.deps.getCostTracker();
        if (costTracker) {
          costTracker.resetAgent(agentId);
          this.deps.getAgentCosts().set(agentId, 0);
          const costDisplay = this.deps.getCostDisplay();
          costDisplay?.update(costTracker.getBudgetStatus());
          // Update dashboard card
          this.dashboard?.updateAgentCost(agentId, 0);
        }
      },
    });
    this.agentSettingsPanel.setHubClient(this.deps.hubClient);

    // Agent files panel
    this.agentFilesPanel = new AgentFilesPanel(document.body);
  }

  /**
   * Initialize the templates panel with button binding.
   */
  initTemplatesPanel(mainContent: HTMLElement, statusState: HTMLElement): void {
    const templatesBtn = document.getElementById('templates-btn');
    if (templatesBtn) {
      this.templatesPanel = new TemplatesPanel(document.body, {
        templateManager: this.deps.templateManager,
        onCreateAgent: async (template) => {
          const defaultName = `${template.manifest.name}-${Date.now()}`;
          const agentName = window.prompt('Agent name:', defaultName);
          if (!agentName) return;

          this.templatesPanel?.hide();
          const agent = await this.deps.agentManager.createFromTemplate(this.deps.templateManager, {
            templateName: template.manifest.name,
            agentName: agentName.trim() || defaultName,
          });
          this.showAgent(agent.id, mainContent, statusState);
        },
        onDownload: async (templateName) => {
          const blob = await this.deps.templateManager.exportToZip(templateName);
          if (blob) {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${templateName}.flo.zip`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }
        },
        onDelete: async () => {
          const settings = await this.deps.persistence.getSettings();
          settings.installedTemplates = this.deps.templateManager.exportEntries();
          await this.deps.persistence.saveSettings(settings);
        },
        onUpload: async () => {
          const settings = await this.deps.persistence.getSettings();
          settings.installedTemplates = this.deps.templateManager.exportEntries();
          await this.deps.persistence.saveSettings(settings);
        },
      });
      templatesBtn.addEventListener('click', () => {
        this.templatesPanel?.toggle();
      });
    }
  }

  showDashboard(mainContent: HTMLElement, statusState: HTMLElement): void {
    // Hide current agent's iframe if any
    const activeAgent = this.deps.agentManager.getActiveAgent();
    if (activeAgent) {
      activeAgent.hideFromPane();
    }

    // Clean up focused view if active
    if (this.activeAgentEventUnsub) {
      this.activeAgentEventUnsub();
      this.activeAgentEventUnsub = null;
    }
    if (this.agentView) {
      this.agentView.unmount();
      this.agentView = null;
    }
    this.cleanupBrowseStreamListeners();
    mainContent.innerHTML = '';
    this.currentMode = 'dashboard';

    // Hide homepage/focused mode
    document.body.classList.remove('mode-homepage');
    document.body.classList.remove('mode-focused');
    this.outerSkinContainer?.hide();

    // Update nav header
    if (this.navHeader) {
      this.navHeader.setMode('dashboard');
    }

    this.deps.agentManager.clearActiveAgent();

    // Build card callbacks for lifecycle controls
    const cardCallbacks: Partial<AgentCardCallbacks> = {
      onPause: (id) => this.deps.agentManager.getAgent(id)?.pause(),
      onResume: (id) => this.deps.agentManager.getAgent(id)?.resume(),
      onStop: (id) => this.deps.agentManager.stopAgent(id),
      onKill: (id) => {
        this.removeFromHubIfPersisted(id);
        this.deps.agentManager.killAgent(id);
      },
      onRestart: (id) => {
        this.deps.agentManager.restartAgent(id);
        const agent = this.deps.agentManager.getAgent(id);
        if (agent && agent.state === 'pending') {
          agent.start(this.deps.agentIframesContainer, this.deps.workerCode).then(() => {
            this.updateStatusBar(statusState);
            const hooksConfig = this.deps.hookManager.getHooksConfig();
            agent.getIframeElement()?.contentWindow?.postMessage({
              type: 'hooks_config',
              activeHookTypes: hooksConfig.activeHookTypes,
            }, '*');
          }).catch(err => {
            console.error('[flo] Failed to restart agent:', err);
          });
        }
      },
      onClose: (id) => {
        const agent = this.deps.agentManager.getAgent(id);
        const name = agent?.config.name || 'this agent';
        if (window.confirm(`Delete "${name}"? This cannot be undone.`)) {
          this.deps.agentManager.closeAgent(id);
        }
      },
      onSettings: (id) => {
        const agent = this.deps.agentManager.getAgent(id);
        if (agent && this.agentSettingsPanel) {
          this.agentSettingsPanel.show(agent);
        }
      },
      onFiles: (id) => {
        const agent = this.deps.agentManager.getAgent(id);
        if (agent && this.agentFilesPanel) {
          this.agentFilesPanel.show(agent);
        }
      },
      onSaveAsTemplate: (id) => this.handleSaveAsTemplate(id, mainContent, statusState),
      onPersist: (id) => this.handlePersistToHub(id),
    };

    this.dashboard = new Dashboard(
      mainContent,
      this.deps.agentManager,
      (agentId) => this.showAgent(agentId, mainContent, statusState),
      () => this.showNewAgentDialog(mainContent, statusState),
      cardCallbacks,
    );

    // Update dashboard cards with persisted costs
    const agentCosts = this.deps.getAgentCosts();
    for (const [agentId, cost] of agentCosts) {
      this.dashboard.updateAgentCost(agentId, cost);
    }

    // Set card locations for hub-persisted agents
    for (const agent of this.deps.agentManager.getAllAgents()) {
      const persistInfo = agent.hubPersistInfo;
      if (persistInfo) {
        const card = (this.dashboard as any).cards?.get(agent.id);
        if (card) {
          card.setLocation({ type: 'remote', hubId: persistInfo.hubConnectionId, hubName: persistInfo.hubName });
        }
      }
    }

    // Add hub agent cards for any discovered remote agents
    if (this.deps.getHubAgentCards) {
      for (const config of this.deps.getHubAgentCards()) {
        this.dashboard.addHubAgentCard(config.proxy, config.callbacks, config.hubName);
      }
    }

    // Apply offline state if currently offline
    if (!navigator.onLine) {
      this.dashboard.setOffline(true);
    }

    this.updateStatusBar(statusState);
  }

  showAgent(agentId: string, mainContent: HTMLElement, statusState: HTMLElement): void {
    const agent = this.deps.agentManager.getAgent(agentId);
    if (!agent) return;

    // Notify shell that agent is being shown (e.g., for marking notifications read)
    this.deps.onAgentShown?.(agentId);

    // Update nav header to focused mode (hidden)
    if (this.navHeader) {
      this.navHeader.setMode('focused');
    }

    // Hide previous agent's iframe
    const prevAgent = this.deps.agentManager.getActiveAgent();
    if (prevAgent && prevAgent.id !== agentId) {
      prevAgent.hideFromPane();
    }

    // Clean up dashboard
    if (this.dashboard) {
      this.dashboard.unmount();
      this.dashboard = null;
    }
    mainContent.innerHTML = '';
    this.currentMode = 'focused';
    document.body.classList.add('mode-focused');

    this.deps.agentManager.switchToAgent(agentId);

    // Create agent view with lifecycle callbacks
    this.agentView = new AgentView(mainContent, {
      onPause: (id) => this.deps.agentManager.getAgent(id)?.pause(),
      onResume: (id) => this.deps.agentManager.getAgent(id)?.resume(),
      onStop: (id) => this.deps.agentManager.stopAgent(id),
      onKill: (id) => {
        this.removeFromHubIfPersisted(id);
        this.deps.agentManager.killAgent(id);
        this.showDashboard(mainContent, statusState);
      },
      onRestart: (id) => {
        this.deps.agentManager.restartAgent(id);
        const a = this.deps.agentManager.getAgent(id);
        if (a && a.state === 'pending') {
          a.start(this.deps.agentIframesContainer, this.deps.workerCode).then(async () => {
            a.showInPane(this.agentView!.getIframePane());
            this.agentView?.mount(a);
            this.updateStatusBar(statusState);
            const hooksConfig = this.deps.hookManager.getHooksConfig();
            a.getIframeElement()?.contentWindow?.postMessage({
              type: 'hooks_config',
              activeHookTypes: hooksConfig.activeHookTypes,
            }, '*');

            // If this is a restored agent with pending DOM state, apply it
            // Skip for hub-persisted agents (hub DOM takes precedence)
            if (a.hubPersistInfo) {
              delete (a as any)._pendingDomRestore;
              if (a.pendingHubDomState) {
                await new Promise(resolve => setTimeout(resolve, 100));
                await a.restoreDomState(a.pendingHubDomState);
                (a as any)._pendingHubDomState = null;
                console.log(`[flo] Applied hub DOM state for ${a.config.name}`);
              }
            } else {
              const pendingDom = (a as any)._pendingDomRestore;
              if (pendingDom) {
                delete (a as any)._pendingDomRestore;
                await new Promise(resolve => setTimeout(resolve, 100));
                await a.restoreDomState(pendingDom);
              }
            }
          }).catch(err => {
            console.error('[flo] Failed to restart agent:', err);
          });
        }
      },
      onSettings: (id) => {
        const agent = this.deps.agentManager.getAgent(id);
        if (agent && this.agentSettingsPanel) {
          this.agentSettingsPanel.show(agent);
        }
      },
      onFiles: (id) => {
        const agent = this.deps.agentManager.getAgent(id);
        if (agent && this.agentFilesPanel) {
          this.agentFilesPanel.show(agent);
        }
      },
      onSaveAsTemplate: (id) => this.handleSaveAsTemplate(id, mainContent, statusState),
      onPersist: (id) => this.handlePersistToHub(id),
      onViewStateChange: (id, state) => this.handleViewStateChange(id, state),
      onIntervene: (_agentId, mode) => {
        if (this.browseStreamInfo) {
          this.deps.hubClient.requestIntervene(this.browseStreamInfo.connectionId, this.browseStreamInfo.agentId, mode);
        }
      },
      onReleaseIntervene: (_agentId) => {
        if (this.browseStreamInfo) {
          this.deps.hubClient.releaseIntervene(this.browseStreamInfo.connectionId, this.browseStreamInfo.agentId);
        }
      },
    });

    // Set up browse stream listeners if hub has browse tool (but don't show
    // web-* view state buttons yet — only show them when the agent actually
    // has an active browse session, detected via tool_use_start events)
    const browseHubId = this.deps.hubClient.findToolHub('browse');
    if (browseHubId) {
      this.setupBrowseStreamListeners(browseHubId);
    }

    this.agentView.setOnBack(() => this.showDashboard(mainContent, statusState));
    this.agentView.setAgentName(agent.config.name);

    // Sync AgentView's view state with the agent's persisted view state
    const agentViewState = agent.getViewState();
    // If persisted state is web-*, the agent had a browse session — enable buttons
    if ((agentViewState === 'web-max' || agentViewState === 'web-only') && browseHubId) {
      this.agentView.setHasBrowseSession(true);
    }
    if (agentViewState !== this.agentView.getViewState()) {
      this.agentView.setViewState(agentViewState);
    }

    // Wire up skill invocation
    this.agentView.setSkillInvocationCallback((name, args) => {
      return this.deps.skillManager.invokeSkill(name, args, agentId, this.deps.hookManager);
    });

    if (agent.state === 'pending') {
      // Mount early so user sees chat panel with starting indicator
      this.agentView.mount(agent);
      this.agentView.getConversation().setInputEnabled(false);
      this.agentView.getConversation().showStartingIndicator();

      // Start the agent in the persistent container, then show in pane
      agent.start(this.deps.agentIframesContainer, this.deps.workerCode).then(async () => {
        agent.showInPane(this.agentView!.getIframePane());
        // Don't re-mount — already mounted above
        this.updateStatusBar(statusState);

        // Agent is now running and ready for user input
        this.agentView?.getConversation().removeStartingIndicator();
        this.agentView?.getConversation().setInputEnabled(true);
        const hooksConfig = this.deps.hookManager.getHooksConfig();
        agent.getIframeElement()?.contentWindow?.postMessage({
          type: 'hooks_config',
          activeHookTypes: hooksConfig.activeHookTypes,
        }, '*');

        // If this is a restored agent with pending DOM state, apply it
        // Skip for hub-persisted agents (hub DOM takes precedence)
        if (agent.hubPersistInfo) {
          delete (agent as any)._pendingDomRestore;
          // Hub DOM will be applied via pendingHubDomState
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
            // Wait a tick for iframe to be ready
            await new Promise(resolve => setTimeout(resolve, 100));
            await agent.restoreDomState(pendingDom);
            console.log(`[flo] Restored DOM for ${agent.config.name}`);
          }
        }

        // Load and render conversation history for restored agents
        // Skip for hub-persisted agents — hub conversation_history takes precedence
        if (!agent.hubPersistInfo) {
          this.deps.messageRelay.loadConversationContext(agentId).then((messages) => {
            if (messages && messages.length > 0) {
              this.agentView?.getConversation().renderHistory(messages as any[]);
            }
          }).catch(() => {
            // Ignore errors loading history
          });
        }
      }).catch((err) => {
        console.error('[flo] Failed to start agent:', err);
        statusState.textContent = 'Error';
      });
    } else {
      // Agent already running/paused -- show iframe and render history
      console.log(`[flo:dom-debug] showAgent ${agent.config.name}: else path (state=${agent.state}, hasIframe=${!!agent.getIframeElement()}, pendingHubDom=${!!agent.pendingHubDomState})`);
      agent.showInPane(this.agentView.getIframePane());
      this.agentView.mount(agent);

      // If view state was restored to a web state before mount, request the stream now
      this.ensureStreamIfWebState(agentId, agent);

      // Apply pending hub DOM state for hub-persisted agents
      if (agent.hubPersistInfo && agent.pendingHubDomState) {
        const domState = agent.pendingHubDomState;
        (agent as any)._pendingHubDomState = null;
        setTimeout(async () => {
          try {
            await agent.restoreDomState(domState);
            console.log(`[flo] Applied hub DOM state for ${agent.config.name}`);
          } catch (err) {
            console.warn(`[flo] Failed to apply hub DOM state:`, err);
          }
        }, 100);
      }

      // Load and render conversation history
      // Skip for hub-persisted agents — hub conversation_history takes precedence
      if (!agent.hubPersistInfo) {
        this.deps.messageRelay.loadConversationContext(agentId).then((messages) => {
          if (messages && messages.length > 0) {
            this.agentView?.getConversation().renderHistory(messages as any[]);
          }
        }).catch(() => {
          // Ignore errors loading history
        });
      }
    }

    // Clean up previous subscription
    if (this.activeAgentEventUnsub) {
      this.activeAgentEventUnsub();
      this.activeAgentEventUnsub = null;
    }
    // Subscribe to new agent events for status bar updates + browse detection
    this.activeAgentEventUnsub = agent.onEvent((event) => {
      if (event.type === 'state_change') {
        this.updateStatusBar(statusState);
      }
      // Detect when agent starts using browse tool → show web-* view state buttons
      if (event.type === 'tool_use_start' && event.toolName === 'browse' && this.agentView && !this.agentView.getHasBrowseSession()) {
        this.agentView.setHasBrowseSession(true);
      }
      // Scan conversation history for browse tool_use (restored hub agents)
      const ev = event as any;
      if (ev.type === 'conversation_history' && this.agentView && !this.agentView.getHasBrowseSession()) {
        const messages = ev.messages as Array<{ content?: Array<{ type: string; name?: string }> }> | undefined;
        if (messages?.some((m: any) => m.content?.some((b: any) => b.type === 'tool_use' && b.name === 'browse'))) {
          this.agentView.setHasBrowseSession(true);
        }
      }
    });

    // Set hub location if persisted (before mount renders header)
    const persistInfo = agent.hubPersistInfo;
    if (persistInfo && this.agentView) {
      this.agentView.setAgentLocation({ type: 'remote', hubName: persistInfo.hubName });
    }
  }

  async showNewAgentDialog(mainContent: HTMLElement, statusState: HTMLElement): Promise<void> {
    const builtinTools = getBuiltinToolDefinitions();
    const pluginTools = this.deps.pluginRegistry.getDefinitions();
    const hubTools = this.deps.hubClient.getAllTools();

    // Deduplicate tools - browser tools take precedence over hub tools
    const seenNames = new Set<string>();
    const allTools = [...builtinTools, ...pluginTools, ...hubTools].filter(tool => {
      if (seenNames.has(tool.name)) return false;
      seenNames.add(tool.name);
      return true;
    });

    const dialog = new NewAgentDialog();
    dialog.setTemplateManager(this.deps.templateManager);
    const result = await dialog.show(allTools, this.deps.agentManager.getAgentCount() + 1);

    if (!result) return;

    let agent;

    if (result.type === 'template') {
      // Create from template
      agent = await this.deps.agentManager.createFromTemplate(this.deps.templateManager, {
        templateName: result.templateName,
        agentName: result.agentName,
        overrides: result.overrides,
      });
    } else {
      // Create custom agent
      const selectedTools = allTools.filter(t => result.selectedTools.includes(t.name));

      agent = this.deps.agentManager.createAgent({
        name: result.name,
        model: result.model,
        provider: result.provider,
        systemPrompt: result.systemPrompt,
        tools: selectedTools,
      });
    }

    // Switch to the new agent's focused view
    this.showAgent(agent.id, mainContent, statusState);
  }

  showCostResetMenu(options: Array<{ type: 'all' } | { type: 'agent'; agentId: string; agentName: string }>): void {
    // Build menu options
    const menuItems: string[] = ['Reset All Costs'];
    for (const opt of options) {
      if (opt.type === 'agent') {
        menuItems.push(`Reset "${opt.agentName}"`);
      }
    }

    // Simple prompt-based menu
    const choice = window.prompt(
      `Cost Reset Options:\n${menuItems.map((item, i) => `${i + 1}. ${item}`).join('\n')}\n\nEnter number to reset (or cancel):`,
    );

    if (!choice) return;

    const index = parseInt(choice, 10) - 1;
    if (isNaN(index) || index < 0 || index >= menuItems.length) return;

    if (index === 0) {
      this.resetAllCosts();
    } else {
      const agentOpt = options.filter(o => o.type === 'agent')[index - 1];
      if (agentOpt && agentOpt.type === 'agent') {
        this.resetAgentCost(agentOpt.agentId);
      }
    }
  }

  private resetAllCosts(): void {
    const costTracker = this.deps.getCostTracker();
    const costDisplay = this.deps.getCostDisplay();
    if (costTracker) {
      costTracker.reset();
      costDisplay?.update(costTracker.getBudgetStatus());
    }

    const agentCosts = this.deps.getAgentCosts();
    agentCosts.clear();

    if (this.dashboard) {
      for (const agent of this.deps.agentManager.getAllAgents()) {
        this.dashboard.updateAgentCost(agent.id, 0);
      }
    }

    console.log('[flo] Reset all costs');
  }

  private resetAgentCost(agentId: string): void {
    const agent = this.deps.agentManager.getAgent(agentId);
    if (!agent) return;

    const agentCosts = this.deps.getAgentCosts();
    agentCosts.set(agentId, 0);

    if (this.dashboard) {
      this.dashboard.updateAgentCost(agentId, 0);
    }

    console.log(`[flo] Reset cost for agent: ${agent.config.name}`);
  }

  updateStatusBar(statusState: HTMLElement): void {
    // Status state element is hidden — the status bar shows network indicator,
    // token counts, and cost which are sufficient in all modes.
    statusState.style.display = 'none';
  }

  private async handleSaveAsTemplate(agentId: string, mainContent: HTMLElement, statusState: HTMLElement): Promise<void> {
    const agent = this.deps.agentManager.getAgent(agentId);
    if (!agent) return;

    const dialog = new SaveAsTemplateDialog();
    const result = await dialog.show(agent.config.name);
    if (!result) return;

    try {
      const blob = await this.deps.templateManager.createFromAgent(agent, {
        name: result.name,
        version: result.version,
        description: result.description,
      }, {
        includeDomState: true,
        includeFiles: true,
        includeConversation: result.includeConversation,
        includeStorage: result.includeStorage,
      });

      await this.deps.templateManager.installFromZip(blob, { type: 'local' });

      const settings = await this.deps.persistence.getSettings();
      settings.installedTemplates = this.deps.templateManager.exportEntries();
      await this.deps.persistence.saveSettings(settings);

      console.log(`[flo] Saved template: ${result.name}`);
    } catch (err) {
      console.error('[flo] Failed to save template:', err);
      window.alert(`Failed to save template: ${(err as Error).message}`);
    }
  }

  private removeFromHubIfPersisted(agentId: string): void {
    const agent = this.deps.agentManager.getAgent(agentId);
    const persistInfo = agent?.hubPersistInfo;
    if (persistInfo) {
      this.deps.hubClient.sendAgentAction(
        persistInfo.hubConnectionId,
        persistInfo.hubAgentId,
        'remove',
      );
    }
  }

  /**
   * Handle view state changes — start/stop browse streams for web-max/web-only.
   */
  private handleViewStateChange(agentId: string, state: AgentViewState): void {
    const isWebState = state === 'web-max' || state === 'web-only';

    if (isWebState) {
      // Already streaming — just keep it going (e.g. web-max ↔ web-only transition)
      if (this.browseStreamInfo) return;

      this.requestBrowseStream(agentId);
    } else {
      // Leaving web state — stop stream and retry timer
      this.clearBrowseStreamRetry();
      if (this.agentView) {
        this.agentView.stopStream();
      }
      if (this.browseStreamInfo) {
        this.deps.hubClient.stopBrowseStream(
          this.browseStreamInfo.connectionId,
          this.browseStreamInfo.agentId,
        );
        this.browseStreamInfo = null;
      }
    }
  }

  /**
   * If the agent view is in a web state (web-max/web-only) and no stream is
   * running, request one. Called after mount when view state was restored
   * before the agent was available.
   */
  private ensureStreamIfWebState(agentId: string, agent: AgentContainer): void {
    if (!this.agentView) return;
    const viewState = this.agentView.getViewState();
    if ((viewState === 'web-max' || viewState === 'web-only') && !this.browseStreamInfo) {
      const hubAgentId = agent.hubPersistInfo?.hubAgentId || agentId;
      this.requestBrowseStream(hubAgentId);
    }
  }

  private requestBrowseStream(agentId: string): void {
    const browseHubId = this.deps.hubClient.findToolHub('browse');
    if (!browseHubId) return;

    const agent = this.deps.agentManager.getAgent(agentId);
    const hubAgentId = agent?.hubPersistInfo?.hubAgentId || agentId;

    this.browseStreamInfo = { connectionId: browseHubId, agentId: hubAgentId };
    this.deps.hubClient.requestBrowseStream(browseHubId, hubAgentId);
  }

  /** Clear hasBrowseSession flag and fall back from web-* view states. */
  private clearBrowseSession(): void {
    if (!this.agentView) return;
    this.clearBrowseStreamRetry();
    this.agentView.setHasBrowseSession(false);
    const state = this.agentView.getViewState();
    if (state === 'web-max') {
      this.agentView.setViewState('max');
    } else if (state === 'web-only') {
      this.agentView.setViewState('chat-only');
    }
  }

  private clearBrowseStreamRetry(): void {
    if (this.browseStreamRetryTimer) {
      clearTimeout(this.browseStreamRetryTimer);
      this.browseStreamRetryTimer = null;
    }
  }

  private retryBrowseStream(failedAgentId: string): void {
    if (!this.agentView) return;
    const currentState = this.agentView.getViewState();
    if (currentState !== 'web-max' && currentState !== 'web-only') return;

    this.clearBrowseStreamRetry();
    this.browseStreamRetryTimer = setTimeout(() => {
      this.browseStreamRetryTimer = null;
      if (!this.browseStreamInfo && this.agentView) {
        const state = this.agentView.getViewState();
        if (state === 'web-max' || state === 'web-only') {
          this.requestBrowseStream(failedAgentId);
        }
      }
    }, 3000);
  }

  /**
   * Set up listeners for browse stream token/stopped/error events.
   */
  private setupBrowseStreamListeners(browseHubId: string): void {
    this.cleanupBrowseStreamListeners();

    const unsub1 = this.deps.hubClient.onBrowseStreamToken((_agentId, data) => {
      if (!this.agentView) return;

      // Use streamUrl from hub if provided (path-based routing behind nginx),
      // otherwise construct from hub WS URL + stream port (direct connection)
      let streamUrl: string;
      if (data.streamUrl) {
        streamUrl = data.streamUrl;
      } else {
        const conn = this.deps.hubClient.getConnection(browseHubId);
        if (!conn) return;
        const hubUrl = new URL(conn.url);
        hubUrl.port = String(data.streamPort);
        streamUrl = hubUrl.toString();
      }

      try {
        const agentId = this.browseStreamInfo?.agentId;
        this.agentView.startStream(streamUrl, data.token, data.viewport, agentId ? () => {
          // Stream closed (e.g. browse session crash/restart) — retry
          this.browseStreamInfo = null;
          this.retryBrowseStream(agentId);
        } : undefined);
      } catch (err) {
        console.warn('[ui-manager] Failed to construct stream URL:', err);
      }
    });

    const unsub2 = this.deps.hubClient.onBrowseStreamStopped(() => {
      if (this.agentView) {
        this.agentView.stopStream();
        this.clearBrowseSession();
      }
    });

    const unsub3 = this.deps.hubClient.onBrowseStreamError((_agentId, error) => {
      console.warn('[ui-manager] Browse stream error:', error);
      if (this.agentView) {
        this.agentView.stopStream();
      }
      this.browseStreamInfo = null;
      this.clearBrowseSession();
    });

    const unsub4 = this.deps.hubClient.onInterveneGranted((agentId, mode) => {
      if (this.agentView && this.browseStreamInfo?.agentId === agentId) {
        this.agentView.setInterveneMode(mode);
      }
    });

    const unsub5 = this.deps.hubClient.onInterveneDenied((agentId, reason) => {
      console.warn(`[ui-manager] Intervention denied for ${agentId}: ${reason}`);
    });

    const unsub6 = this.deps.hubClient.onInterveneEnded((agentId, reason, notification) => {
      if (this.agentView && this.browseStreamInfo?.agentId === agentId) {
        this.agentView.setInterveneMode('none');
        if (notification) {
          // Show intervention block in chat
          this.agentView.showInterventionBlock(notification);
          // For browser-routed agents (no hub runner), also send to worker so LLM processes it.
          // Hub-persisted agents get the notification via runner.interveneEnd() instead.
          const agent = this.deps.agentManager.getAgent(agentId);
          if (agent && !agent.hubPersistInfo) {
            agent.sendUserMessage(notification, undefined, { messageType: 'intervention' });
          }
        }
      }
    });

    this.browseStreamUnsubs = [unsub1, unsub2, unsub3, unsub4, unsub5, unsub6];
  }

  private cleanupBrowseStreamListeners(): void {
    this.clearBrowseStreamRetry();
    for (const unsub of this.browseStreamUnsubs) {
      unsub();
    }
    this.browseStreamUnsubs = [];
    this.browseStreamInfo = null;
  }

  private handlePersistToHub(agentId: string): void {
    const agent = this.deps.agentManager.getAgent(agentId);
    if (!agent) return;

    // Get available hub connections
    const connections = this.deps.hubClient.getConnections();
    const hubs = connections
      .filter(c => c.connected)
      .map(c => ({ id: c.id, name: c.name }));

    if (hubs.length === 0) {
      window.alert('No hub connected. Configure a hub in Settings first.');
      return;
    }

    // If only one hub, skip the dialog and persist directly
    // Otherwise show the dialog for hub selection
    if (!this.persistDialog) {
      this.persistDialog = new PersistDialog();
    }

    this.persistDialog.show({
      hubs,
      onPersist: async (hubId: string, includeFiles: boolean) => {
        const handler = this.getPersistHandler();
        const result = await handler.persistAgent(agent, {
          hubConnectionId: hubId,
          includeFiles,
        });

        if (!result.success) {
          throw new Error(result.error || 'Failed to persist agent');
        }

        // Mark agent as hub-persisted (affects capabilities response)
        const hubConn = this.deps.hubClient.getConnection(hubId);
        const hubName = hubConn?.name || 'Hub';
        agent.setHubPersistInfo({
          hubAgentId: result.hubAgentId!,
          hubName,
          hubConnectionId: hubId,
        });

        // Update dashboard card if visible
        if (this.dashboard) {
          const card = (this.dashboard as any).cards?.get(agentId);
          if (card) {
            card.setLocation({ type: 'remote', hubId, hubName });
            card.showSaveIndicator(true);
          }
        }

        // Update focused agent view if visible
        if (this.agentView) {
          this.agentView.setAgentLocation({ type: 'remote', hubName });
        }

        // Notify main.ts to wire up hub event source and mapping
        if (this.deps.onAgentPersisted) {
          this.deps.onAgentPersisted(agent, result.hubAgentId!, hubId);
        }

        console.log(`[flo] Agent ${agent.config.name} persisted to hub as ${result.hubAgentId}`);
      },
      onCancel: () => {},
    });
  }

  showHomepage(mainContent: HTMLElement, statusState: HTMLElement): void {
    // Hide current agent's iframe if any
    const activeAgent = this.deps.agentManager.getActiveAgent();
    if (activeAgent) {
      activeAgent.hideFromPane();
    }

    // Clean up focused view if active
    if (this.activeAgentEventUnsub) {
      this.activeAgentEventUnsub();
      this.activeAgentEventUnsub = null;
    }
    if (this.agentView) {
      this.agentView.unmount();
      this.agentView = null;
    }
    this.cleanupBrowseStreamListeners();
    if (this.dashboard) {
      this.dashboard.unmount();
      this.dashboard = null;
    }

    mainContent.innerHTML = '';
    this.currentMode = 'homepage';
    document.body.classList.add('mode-homepage');
    document.body.classList.remove('mode-focused');

    // Show outer skin
    if (this.outerSkinContainer) {
      this.outerSkinContainer.show();
    }

    // Update nav header
    if (this.navHeader) {
      const hasLocalKey = this.deps.keyStore.listProviders().length > 0;
      this.navHeader.setHasCredentials(hasLocalKey);
      this.navHeader.setMode('homepage');
    }

    this.updateStatusBar(statusState);
  }

  /**
   * Initialize the outer skin system (container + nav header).
   * Called for ALL users, regardless of credential status.
   */
  initializeOuterSkin(
    mainContent: HTMLElement,
    statusState: HTMLElement,
    onInitializeApp: () => Promise<void>,
  ): void {
    if (!this.outerSkin || this.outerSkinContainer) return; // Already initialized or no skin

    const skinId = getSkinId();
    const baseUrl = getSkinBaseUrl(skinId);

    // Create outer skin container
    const outerSkinRoot = document.getElementById('outer-skin-root')!;
    this.outerSkinContainer = new OuterSkinContainer(outerSkinRoot, this.outerSkin, baseUrl);

    // Create nav header
    const navHeaderContainer = document.getElementById('nav-header-container')!;
    this.navHeader = NavHeader.fromManifest(
      navHeaderContainer,
      this.outerSkin.manifest,
      baseUrl,
      {
        onLogoClick: () => this.showHomepage(mainContent, statusState),
        onDashboardClick: () => this.transitionToDashboard(mainContent, statusState, onInitializeApp),
      }
    );

    // Listen for CTA events from outer skin
    outerSkinRoot.addEventListener('outer-skin-cta', async (e) => {
      const event = e as CustomEvent;
      if (event.detail?.action === 'credentials') {
        const hasLocalKey = this.deps.keyStore.listProviders().length > 0;
        const settings = await this.deps.persistence.getSettings();
        const hasHubKey = settings.apiKeySource === 'hub' && settings.hubForApiKey;
        const hasCredentials = hasLocalKey || hasHubKey;

        if (hasCredentials) {
          this.transitionToDashboard(mainContent, statusState, onInitializeApp);
        } else {
          const overlay = document.getElementById('api-key-overlay')!;
          overlay.hidden = false;
        }
      }
    });
  }

  async transitionToDashboard(
    mainContent: HTMLElement,
    statusState: HTMLElement,
    onInitializeApp: () => Promise<void>,
  ): Promise<void> {
    // Fade out
    mainContent.classList.add('transitioning');
    await new Promise(resolve => setTimeout(resolve, 300));

    // Hide homepage
    document.body.classList.remove('mode-homepage');
    this.outerSkinContainer?.hide();

    // Mark that user has seen homepage
    const settings = await this.deps.persistence.getSettings();
    if (!settings.hasSeenHomepage) {
      settings.hasSeenHomepage = true;
      await this.deps.persistence.saveSettings(settings);
    }

    // Initialize app and show dashboard
    await onInitializeApp();

    // Fade in
    mainContent.classList.remove('transitioning');
  }

  async transitionToHomepage(mainContent: HTMLElement, statusState: HTMLElement): Promise<void> {
    // Fade out
    mainContent.classList.add('transitioning');
    await new Promise(resolve => setTimeout(resolve, 300));

    // Show homepage
    this.showHomepage(mainContent, statusState);

    // Fade in
    mainContent.classList.remove('transitioning');
  }
}
