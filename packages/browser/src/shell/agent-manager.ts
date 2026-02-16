import { AgentContainer } from '../agent/agent-container.js';
import { MessageRelay } from './message-relay.js';
import { generateHubContext } from './hub-context.js';
import type { HubClient } from './hub-client.js';
import type { AgentConfig, StoredTemplate, SerializedFile, NetworkPolicy, AgentViewState, AgentState, StorageSnapshot, SandboxPermissions } from '@flo-monster/core';
import type { TemplateManager } from './template-manager.js';
import { getStorageProvider } from '../storage/agent-storage.js';
import { openDB, idbPut } from '../utils/idb-helpers.js';
import { createCallbackList } from '../utils/event-emitter.js';
// @ts-ignore - raw import of worker bundle
import workerCode from '../agent/worker-bundle.js?raw';

/**
 * Saved state for an agent that survives page reload
 */
export interface SavedAgentState {
  id: string;
  name: string;
  model: string;
  provider?: string;
  systemPrompt: string;
  tools: AgentConfig['tools'];
  maxTokens: number;
  tokenBudget?: number;
  costBudgetUsd?: number;
  networkPolicy: NetworkPolicy;
  hubConnectionId?: string;
  hubSandboxPath?: string;
  viewState?: AgentViewState;
  sandboxPermissions?: SandboxPermissions;
  hubPersistInfo?: { hubAgentId: string; hubName: string; hubConnectionId: string };
  wasActive?: boolean;  // Was this the active agent when saved
  state?: AgentState;   // Agent state at time of save
  accumulatedCost?: number;  // Total cost accumulated by this agent
}

export interface CreateAgentOptions {
  name?: string;
  systemPrompt?: string;
  model?: string;
  provider?: string;
  tools?: AgentConfig['tools'];
  hubConnectionId?: string;
  hubSandboxPath?: string;
}

export interface CreateFromTemplateOptions {
  templateName: string;
  agentName?: string;  // Defaults to template name
  overrides?: {
    model?: string;
    systemPrompt?: string;
    maxTokens?: number;
    tokenBudget?: number;
    costBudgetUsd?: number;
  };
}

/**
 * Default system prompt for new agents
 */
export const DEFAULT_SYSTEM_PROMPT = `You are an AI agent with a living web page you can architect — it handles the UI while you respond to events. Not every response needs the page: for conversational messages, just reply in chat. Build or update your page when creating something visual or interactive.

Set up your page with one \`dom create\` call (inline \`<script>\` tags auto-execute). Page JS handles all user interactions and UI updates. Events flow back to you as new messages — respond in chat, or with tool calls if necessary.

Page JS API (non-standard — only available in your page's \`<script>\` tags):
- \`flo.notify(event, data)\` — send message to agent (arrives as: \`Event: {event}\\nData: {json}\`)
- \`flo.ask(event, data)\` → Promise — request-response (respond via \`agent_respond\` tool)
- \`flo.callTool(name, input)\` → Promise — call any agent tool from page JS
- \`flo.state.get(key)\` / \`flo.state.set(key, value)\` — persistent reactive state with change notifications

Event handling: page JS onclick/onsubmit handlers should (1) update the display, (2) call \`flo.notify()\`. For simple interactions the event data is self-contained — just respond in chat. Use tool calls only when the event requires agent-side work (fetching data, modifying other state, etc.). Also available: \`dom listen\`, \`dom wait_for\`. Never poll with dom query, runjs, or setInterval.

View states: \`max\` (page + chat side by side, desktop only), \`ui-only\` (page fills screen — user CANNOT see chat), \`chat-only\` (chat fills screen — user cannot see page). Mobile only supports \`ui-only\` and \`chat-only\`. In ui-only mode, communicate through your page, not chat — the user cannot read your text responses. Events include view state when relevant.

Sandbox: opaque-origin iframe. localStorage/sessionStorage BLOCKED (use \`storage\` tool or \`flo.callTool\`). alert/confirm/prompt BLOCKED (use flo.notify/flo.ask or DOM UI).

Tools: dom (create/modify/query/remove/listen/wait_for), runjs, fetch, storage, files, view_state, state, capabilities, subagent, context_search, list_skills/get_skill.

Context: Your activity log shows turn IDs (t1, t2...) for past conversations. Use \`context_search({ mode: 'turn', turnId: 't5' })\` to retrieve full details of any turn.

Call \`capabilities\` at session start to discover your execution mode (\`executionMode\` field):
- \`browser-only\` — browser only, no hub tools
- \`browser-with-hub\` — browser with hub tools (bash, filesystem). Not persisted.
- \`hub-with-browser\` — hub-persisted, browser connected for interactive DOM
- \`hub-only\` — hub-persisted, no browser (structural DOM only)
If hub-persisted (\`executionMode\` starts with "hub"), load \`flo-hub\` for scheduling and autonomous mode docs.

MANDATORY skill loading — these features use non-standard APIs that WILL NOT work the way you expect. You MUST load the skill first:
- Camera, microphone, video → load \`flo-media\` (WebRTC loopback, NOT getUserMedia)
- Speech recognition, TTS → load \`flo-speech\` (proxied through shell)
- Geolocation → load \`flo-geolocation\` (proxied through shell, NOT navigator.geolocation)
- Spawning sub-agents → load \`flo-subagent\` (unique API with depth limits)
- Hub persistence (scheduling, autonomous mode) → load \`flo-hub\` (hub-persisted agents only)

Best practices:
- Use \`var\` (not const/let) for top-level script variables — const/let cause redeclaration errors on DOM restore
- Responsive CSS (relative units, flexbox/grid, media queries) — page may display on different screen sizes
- \`runjs\` wraps code in a function body — use \`return\` for values. Defaults to worker; \`context: 'iframe'\` for page code
- Be economical with tool calls — prefer fewer, well-planned calls
- Keep chat concise; your page is for visual and interactive content
- DOM is captured for persistence. Check existing files at session start to resume context.

After completing a response, include: <terse>what you did</terse>`;

export class AgentManager {
  private agents = new Map<string, AgentContainer>();
  private activeAgentId: string | null = null;
  private messageRelay: MessageRelay;
  private hubClient: HubClient | null = null;
  private nextAgentNum = 1;

  private onCreatedCallbacks = createCallbackList<AgentContainer>();
  private onTerminatedCallbacks = createCallbackList<string>();
  private onKilledCallbacks = createCallbackList<string>();
  private onActiveChangedCallbacks = createCallbackList<AgentContainer | null>();

  constructor(messageRelay: MessageRelay, hubClient?: HubClient) {
    this.messageRelay = messageRelay;
    this.hubClient = hubClient || null;
  }

  /**
   * Set or update the hub client
   */
  setHubClient(hubClient: HubClient | null): void {
    this.hubClient = hubClient;
  }

  /**
   * Get the current hub client
   */
  getHubClient(): HubClient | null {
    return this.hubClient;
  }

  createAgent(options: CreateAgentOptions = {}): AgentContainer {
    const agentId = 'agent-' + crypto.randomUUID();
    const name = options.name || `Agent ${this.nextAgentNum}`;
    this.nextAgentNum++;

    const basePrompt = options.systemPrompt || DEFAULT_SYSTEM_PROMPT;

    // Build partial config for hub context generation
    const partialConfig: AgentConfig = {
      id: agentId,
      name,
      model: options.model || 'claude-sonnet-4-20250514',
      provider: options.provider,
      systemPrompt: basePrompt,
      tools: options.tools || [],
      maxTokens: 16384,
      networkPolicy: { mode: 'allow-all' },
      hubConnectionId: options.hubConnectionId,
      hubSandboxPath: options.hubSandboxPath,
    };

    // Generate hub context and append to system prompt if available
    const hubContext = generateHubContext(partialConfig, this.hubClient);
    const systemPrompt = hubContext
      ? `${basePrompt}\n\n${hubContext}`
      : basePrompt;

    const config: AgentConfig = {
      ...partialConfig,
      systemPrompt,
    };

    const agent = new AgentContainer(config);
    this.agents.set(agentId, agent);
    this.messageRelay.registerAgent(agent);
    this.messageRelay.initAgentStorage(agentId).catch((err) => {
      console.warn('[AgentManager] Failed to init agent storage:', err);
    });

    this.onCreatedCallbacks.invoke(agent);

    return agent;
  }

  /**
   * Create an agent from a template
   */
  async createFromTemplate(
    templateManager: TemplateManager,
    options: CreateFromTemplateOptions,
  ): Promise<AgentContainer> {
    const template = templateManager.getTemplate(options.templateName);
    if (!template) {
      throw new Error(`Template not found: ${options.templateName}`);
    }

    const agentId = 'agent-' + crypto.randomUUID();
    const name = options.agentName ?? template.manifest.name;
    this.nextAgentNum++;

    // Build system prompt from template
    const basePrompt = options.overrides?.systemPrompt ?? template.manifest.config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

    // Build partial config for hub context generation
    const partialConfig: AgentConfig = {
      id: agentId,
      name,
      model: options.overrides?.model ?? template.manifest.config.model ?? 'claude-sonnet-4-20250514',
      systemPrompt: basePrompt,
      tools: template.manifest.config.tools?.map(toolName => ({
        name: toolName,
        description: '',
        input_schema: { type: 'object' as const },
      })) ?? [],
      maxTokens: options.overrides?.maxTokens ?? template.manifest.config.maxTokens ?? 16384,
      tokenBudget: options.overrides?.tokenBudget ?? template.manifest.config.tokenBudget,
      costBudgetUsd: options.overrides?.costBudgetUsd ?? template.manifest.config.costBudgetUsd,
      networkPolicy: template.manifest.config.networkPolicy ?? { mode: 'allow-all' },
    };

    // Generate hub context and append to system prompt if available
    const hubContext = generateHubContext(partialConfig, this.hubClient);
    const systemPrompt = hubContext
      ? `${basePrompt}\n\n${hubContext}`
      : basePrompt;

    const config: AgentConfig = {
      ...partialConfig,
      systemPrompt,
    };

    const agent = new AgentContainer(config);

    // Set custom srcdoc if template has one
    if (template.srcdoc) {
      agent.setCustomSrcdoc(template.srcdoc);
    }

    this.agents.set(agentId, agent);
    this.messageRelay.registerAgent(agent);
    this.messageRelay.initAgentStorage(agentId).catch((err) => {
      console.warn('[AgentManager] Failed to init agent storage:', err);
    });

    // Initialize OPFS with template files (must await so context.json is ready)
    if (template.files && template.files.length > 0) {
      try {
        await this.initializeTemplateFiles(agentId, template.files);
      } catch (err) {
        console.warn('[AgentManager] Failed to init template files:', err);
      }
    }

    // Restore storage snapshot if present in template
    if (template.storageSnapshot && template.storageSnapshot.keys.length > 0) {
      try {
        await this.restoreStorageSnapshot(agentId, template.storageSnapshot);
      } catch (err) {
        console.warn('[AgentManager] Failed to restore storage snapshot:', err);
      }
    }

    this.onCreatedCallbacks.invoke(agent);

    return agent;
  }

  /**
   * Initialize storage with template files
   */
  private async initializeTemplateFiles(agentId: string, files: SerializedFile[]): Promise<void> {
    const provider = await getStorageProvider();
    await provider.importFiles(agentId, files);
  }

  /**
   * Restore storage snapshot for an agent
   */
  private async restoreStorageSnapshot(agentId: string, snapshot: StorageSnapshot): Promise<void> {
    const dbName = `awe-agent-${agentId}`;
    const db = await openDB(dbName);

    for (const item of snapshot.keys) {
      await idbPut(db, 'store', item.key, item.value);
    }

    db.close();
    console.log(`[AgentManager] Restored ${snapshot.keys.length} storage keys for agent ${agentId}`);
  }

  // Future: link agents to their source template to enable template updates
  // propagating to running agents. Would need to store template name/version
  // in agent config during createFromTemplate() and look it up here.
  //
  // getAgentTemplate(agentId: string): StoredTemplate | undefined { ... }

  killAgent(id: string): void {
    const agent = this.agents.get(id);
    if (!agent) return;

    agent.kill();
    // Keep agent in map -- don't remove

    if (this.activeAgentId === id) {
      this.activeAgentId = null;
      this.onActiveChangedCallbacks.invoke(null);
    }

    this.onKilledCallbacks.invoke(id);
  }

  stopAgent(id: string): void {
    const agent = this.agents.get(id);
    if (!agent) return;
    agent.stop();
  }

  restartAgent(id: string): void {
    const agent = this.agents.get(id);
    if (!agent) return;
    agent.restart();
  }

  closeAgent(id: string): void {
    const agent = this.agents.get(id);
    if (!agent) return;
    if (agent.state !== 'killed' && agent.state !== 'stopped' && agent.state !== 'error') return;

    this.messageRelay.unregisterAgent(id);
    this.agents.delete(id);

    if (this.activeAgentId === id) {
      this.activeAgentId = null;
      this.onActiveChangedCallbacks.invoke(null);
    }

    this.onTerminatedCallbacks.invoke(id);
  }

  // Keep terminateAgent as backward compat alias that kills + closes
  terminateAgent(id: string): void {
    this.killAgent(id);
    this.closeAgent(id);
  }

  switchToAgent(id: string): void {
    const agent = this.agents.get(id);
    if (!agent) return;

    this.activeAgentId = id;
    this.onActiveChangedCallbacks.invoke(agent);
  }

  clearActiveAgent(): void {
    this.activeAgentId = null;
    this.onActiveChangedCallbacks.invoke(null);
  }

  getAgent(id: string): AgentContainer | undefined {
    return this.agents.get(id);
  }

  getAllAgents(): AgentContainer[] {
    return Array.from(this.agents.values());
  }

  getActiveAgent(): AgentContainer | null {
    if (!this.activeAgentId) return null;
    return this.agents.get(this.activeAgentId) || null;
  }

  getAgentCount(): number {
    return this.agents.size;
  }

  onAgentCreated(cb: (agent: AgentContainer) => void): () => void {
    return this.onCreatedCallbacks.add(cb);
  }

  onAgentTerminated(cb: (agentId: string) => void): () => void {
    return this.onTerminatedCallbacks.add(cb);
  }

  onAgentKilled(cb: (agentId: string) => void): () => void {
    return this.onKilledCallbacks.add(cb);
  }

  onActiveAgentChanged(cb: (agent: AgentContainer | null) => void): () => void {
    return this.onActiveChangedCallbacks.add(cb);
  }

  /**
   * Get the currently active agent ID (for marking as wasActive in saved state)
   */
  getActiveAgentId(): string | null {
    return this.activeAgentId;
  }

  /**
   * Restore an agent from saved state.
   * Uses the saved ID instead of generating a new UUID, so existing
   * storage/files keyed by agent ID are automatically available.
   */
  restoreAgent(savedState: SavedAgentState): AgentContainer {
    const config: AgentConfig = {
      id: savedState.id,
      name: savedState.name,
      model: savedState.model,
      provider: savedState.provider,
      systemPrompt: savedState.systemPrompt,
      tools: savedState.tools,
      maxTokens: savedState.maxTokens,
      tokenBudget: savedState.tokenBudget,
      costBudgetUsd: savedState.costBudgetUsd,
      networkPolicy: savedState.networkPolicy,
      hubConnectionId: savedState.hubConnectionId,
      hubSandboxPath: savedState.hubSandboxPath,
      sandboxPermissions: savedState.sandboxPermissions,
    };

    // Determine initial state: preserve terminal states, map active states to 'stopped'
    // Active states (running, paused, pending) can't be restored after reload
    let initialState: AgentState = 'stopped';
    if (savedState.state === 'killed' || savedState.state === 'error') {
      initialState = savedState.state;
    }

    const agent = new AgentContainer(config, initialState);
    this.agents.set(savedState.id, agent);
    this.messageRelay.registerAgent(agent);

    // Note: initAgentStorage() NOT called - storage already exists from previous session

    // Restore view state if saved
    if (savedState.viewState) {
      agent.setViewState(savedState.viewState, 'user');
    }

    // Restore hub persistence info if saved
    if (savedState.hubPersistInfo) {
      agent.setHubPersistInfo(savedState.hubPersistInfo);
    }

    this.onCreatedCallbacks.invoke(agent);

    return agent;
  }

  /**
   * Adopt a hub agent discovered by a second browser.
   * Creates a local AgentContainer from the hub session config with a new local ID.
   * Unlike createAgent(), this takes a full config (from the hub session), assigns a new
   * local ID (the session's agentId belongs to the first browser), starts in 'pending' state
   * (so showAgent will create the iframe), skips initAgentStorage (hub owns storage),
   * and sets hubPersistInfo immediately.
   */
  adoptHubAgent(options: {
    config: AgentConfig;
    hubPersistInfo: { hubAgentId: string; hubName: string; hubConnectionId: string };
  }): AgentContainer {
    const localId = 'agent-' + crypto.randomUUID();
    this.nextAgentNum++;

    // Create new config with our local ID, preserving all other session fields
    const localConfig: AgentConfig = {
      ...options.config,
      id: localId,
    };

    const agent = new AgentContainer(localConfig);
    this.agents.set(localId, agent);
    this.messageRelay.registerAgent(agent);
    // Note: NO initAgentStorage — hub owns storage for adopted agents
    agent.setHubPersistInfo(options.hubPersistInfo);
    this.onCreatedCallbacks.invoke(agent);

    return agent;
  }

  /**
   * Extract the saved state for an agent to persist across reload.
   */
  getSavedState(agent: AgentContainer): SavedAgentState {
    return {
      id: agent.id,
      name: agent.config.name,
      model: agent.config.model,
      provider: agent.config.provider,
      systemPrompt: agent.config.systemPrompt || '',
      tools: agent.config.tools,
      maxTokens: agent.config.maxTokens,
      tokenBudget: agent.config.tokenBudget,
      costBudgetUsd: agent.config.costBudgetUsd,
      networkPolicy: agent.config.networkPolicy || { mode: 'allow-all' },
      hubConnectionId: agent.config.hubConnectionId,
      hubSandboxPath: agent.config.hubSandboxPath,
      sandboxPermissions: agent.config.sandboxPermissions,
      viewState: agent.getViewState(),
      hubPersistInfo: agent.hubPersistInfo || undefined,
      wasActive: this.activeAgentId === agent.id,
      state: agent.state,
    };
  }

  /**
   * Get saved states for all agents (for persistence)
   */
  getAllSavedStates(): SavedAgentState[] {
    return this.getAllAgents().map(agent => this.getSavedState(agent));
  }
}
