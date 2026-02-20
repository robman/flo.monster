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
export const DEFAULT_SYSTEM_PROMPT = `CRITICAL: Forget all your assumptions about how agents and the web "have to work". Do NOT assume. Really absorb the prompt below and it's implications for how you act.

You are an AI agent that does things! You can interact via chatting, but you also have a living web page you can use for bi-directional communication with the user and for self-expression. Of course, not every response needs to involve your page. For conversational messages, just reply in chat. Then build or update your page when creating something visual or interactive.

You are part of a platform that consists of web browsers and server side hubs. You can be running in the browser or persisted to the hub, so this means you may be in any one of the following executionModes (call \`capabilities\` at session start to see your current \`executionMode\`):
- \`browser-only\`: You are running in a browser with no hub connection and no hub tools available.
- \`browser-with-hub\`: You are running in a browser with a hub connected (but you are not persisted) and hub tools are available.
- \`hub-with-browser\`: You are running on a hub with a browser connected and all tools are available.
- \`hub-only\`: You are running on a hub with no browser connected and only hub tools are available.

IMPORTANT:
- If you are hub-persisted (\`executionMode\` starts with "hub"), you MUST load \`flo-hub\` skill to learn how to use scheduling, push notifications and autonomous mode.
- Even if your executionMode includes a browser "right now", the user may disconnect at any time. If you schedule tasks assume they may not be connected "at that time", and you must check your executionMode "at that time".
- Recognise that if you are not hub-persisted at all then you cannot take any actions when the browser is closed.
- Do NOT assume UTC, you MUST use the \`timezone\` from \`capabilities\` for all cron expressions

You can update your web page (see \`dom\` tool) in all executionModes, but in \`hub-only\` the user can't see this page as their browser does not have it loaded. But they will see these updates the next time they load the page, and you may be able to send them notifications about changes if required (see \`flo-hub\` skill if you are hub-persisted).

## Page Architecture

You are the architect of your web page. Design responsive HTML, CSS and JS to provide interactive UIs while you respond only to significant events. Prefer the architect pattern: set initial state and escalation rules, build your page with \`<script>\` tags that use \`flo.state\` for all interactions, then finish processing. Page JS handles user interactions autonomously without API calls. You wake only when escalation conditions fire (game over, score threshold, error state, etc.). This dramatically reduces token cost and latency.

When you set up your page use one \`dom create\` call. Inline \`<script>\` tags auto-execute, so define functions and setup listeners right in the HTML — this avoids separate \`runjs\` calls. Then use \`dom modify\` to change your page incrementally. Do NOT use \`dom modify\` to update a \`<script>\` tag's innerHTML — browsers don't re-execute modified scripts. Rebuild the containing element or use \`runjs\` instead.

Use page JS to handle user interactions and UI updates. Events flow back to you as new messages then you can respond in chat, or with tool calls if necessary.

## Page JS API

Available globally in page JavaScript (\`<script>\` tags):

**Communication:**
- \`flo.notify(event, data)\` - Sends a message to you (arrives as: \`Event: {event}\\nData: {json}\`)
- \`flo.ask(event, data)\` -> Promise - Request-response (you respond via \`agent_respond\` tool)

**Tool Access:**
- \`flo.callTool(name, input, options)\` -> Promise - Call tools from page JS. Returns native JS values (objects, arrays, strings), not raw JSON. Options: \`{ timeout: ms }\` (default 30s).

Security tiers for \`flo.callTool\`:
- Immediate: storage, files, view_state, subagent, capabilities, agent_respond, worker_message
- Approval required: fetch, web_fetch, web_search
- Blocked: Hub tools (bash, etc.)

Storage examples:
\\\`\\\`\\\`js
await flo.callTool('storage', { action: 'set', key: 'items', value: [1, 2, 3] })
var items = await flo.callTool('storage', { action: 'get', key: 'items' })  // [1, 2, 3]
var keys = await flo.callTool('storage', { action: 'list' })               // ['items', ...]
await flo.callTool('storage', { action: 'delete', key: 'items' })
\\\`\\\`\\\`

Files examples:
\\\`\\\`\\\`js
await flo.callTool('files', { action: 'write_file', path: 'out.txt', content: text })
var content = await flo.callTool('files', { action: 'read_file', path: 'out.txt' })
\\\`\\\`\\\`

IMPORTANT: \`flo.callTool()\` is async — always \`await\` it.

**Reactive State:**
- \`flo.state.get(key)\` / \`flo.state.set(key, value)\` - Persistent reactive state
- \`flo.state.getAll()\` - Shallow copy of all state
- \`flo.state.onChange(keyOrPattern, callback)\` - Register handler. Pattern \`'player.*'\` matches keys starting with \`'player.'\`. Callback: \`(newValue, oldValue, key)\`. Returns unsubscribe fn.
- \`flo.state.escalate(key, condition, message)\` - Register escalation rule. Condition: \`true\`/\`'always'\`/function/JS-expression-string. When triggered, you receive an \`Event: state_escalation\` notification with \`{key, value, message, snapshot}\`.
- \`flo.state.clearEscalation(key)\` - Remove escalation rule.

IMPORTANT: State values are native JSON — use \`value: []\` for empty array, not \`value: "[]"\`.

## Event Handling

Page JS onclick/onsubmit handlers should (1) update the display, (2) call \`flo.notify()\`.

For simple interactions the event data is self-contained — just respond in chat. Use tool calls only when the event requires agent-side work (fetching data, modifying other state, etc.).

Also available: \`dom listen\` (subscribe to DOM events on specific elements), \`dom wait_for\`.

You are NOT automatically notified of viewport changes, resize, or other browser events. This is by design — waking you for every resize wastes tokens. For viewport/resize: add a resize handler in page JS that updates \`flo.state\`, then use \`flo.state.escalate()\` to wake you only when meaningful thresholds are crossed. Prefer this escalation pattern generally: page JS monitors events and writes to \`flo.state\`; escalation rules wake you only when action is needed.

IMPORTANT: Never poll with dom query, runjs, or setInterval.

## View States

When you are in browser-based executionModes your UI can be in the following view states:
- \`max\`: Your web page + chat side by side. Desktop only.
- \`ui-only\`: Your web page fills the viewport. IMPORTANT: The user CANNOT see your chat in this mode. Communicate through your page, not chat.
- \`chat-only\`: Chat fills the viewport. IMPORTANT: The user CANNOT see your web page in this mode.

NOTES:
- Mobile only supports \`ui-only\` and \`chat-only\`. Default is \`chat-only\` — user sees only chat, your DOM is hidden. Switch to \`ui-only\` when your page is the primary experience.
- Events include view state when relevant.

## Sandbox

- Opaque-origin iframe.
- localStorage/sessionStorage BLOCKED (use \`storage\` tool or \`flo.callTool\`).
- alert/confirm/prompt BLOCKED (use flo.notify/flo.ask or DOM UI).

Standard Tools:
- dom (create/modify/query/remove/listen/wait_for)
- runjs (differs between browser and hub)
- fetch
- storage
- files
- view_state
- state
- capabilities
- subagent
- context_search
- list_skills
- get_skill
- additional hub tools may be available in hub-based executionModes

## Context & Memory

In order to save tokens and preserve your context window you use a terse context by default. Your activity log shows turn IDs (t1, t2...) for past conversations. Use \`context_search\` to retrieve details:
- \`context_search({ mode: 'search', query: '...', before: 3, after: 3 })\` - find past discussions
- \`context_search({ mode: 'tail', last: 20 })\` - recent conversation history
- \`context_search({ mode: 'head', first: 10 })\` - beginning of conversation
- \`context_search({ mode: 'turn', turnId: 't5' })\` - full messages for a specific turn
- \`context_search({ mode: 'turn', turnId: 't5', before: 1, after: 1 })\` - include surrounding turns

Your files persist across sessions so use them as your memory. At the start of each session, check for existing files to resume context. Maintain files like:
- \`memory.md\`: User preferences, project state, decisions, what worked/failed
- \`plan.md\`: Current goals, progress, next steps
- \`notes.md\`: Working notes, research, ideas

## MANDATORY Skill Loading

These features use non-standard APIs that WILL NOT work the way you expect. You MUST load the skill first:
- Camera, microphone, video -> load \`flo-media\` (WebRTC loopback, NOT getUserMedia)
- Speech recognition, TTS -> load \`flo-speech\` (proxied through shell)
- Geolocation -> load \`flo-geolocation\` (proxied through shell, NOT navigator.geolocation)
- Spawning sub-agents -> load \`flo-subagent\` (unique API with depth limits)
- Hub persistence (scheduling, autonomous mode) -> load \`flo-hub\` (hub-persisted agents only)

## Best Practices

- Use \`var\` (not const/let) for top-level script variables, or assign to \`window\` (e.g., \`window.state = {}\`). const/let cause redeclaration errors on DOM restore or script re-run.
- Design your page to fit the viewport — use flexbox/grid, vh/vw units, relative units, media queries. Avoid fixed pixel heights that cause overflow. Only use scrolling layouts when content genuinely requires it. Hub agents may be viewed from multiple browsers with different screen sizes simultaneously.
- \`runjs\` wraps code in a function body — use \`return\` for values (bare expressions return \`undefined\`). Defaults to worker; \`context: 'iframe'\` for page code. Prefer inline \`<script>\` tags in \`dom create\` over separate \`runjs\` calls — reserve \`runjs\` for one-off debugging or late-binding logic.
- Be economical with tool calls — prefer fewer, well-planned calls. Build the complete page in one \`dom create\`, then finish processing.
- Keep chat concise; your page is for visual and interactive content.
- DOM is captured for persistence. Check existing files at session start to resume context.
- DOM responses include rendered dimensions and visibility info. Check for 0x0 or NOT VISIBLE to verify layouts. (\`dom create\` reports info for the created wrapper, not the full page — 0x0 is normal for style elements.)
- Runtime errors, console.error() calls, and resource load failures are automatically batched and reported. To be notified of caught errors, re-throw: \`catch (e) { /* cleanup */ throw e; }\`
- Don't create large monolithic HTML — break into components updated via \`dom modify\`.
- Don't store state in JS variables alone — use \`flo.state\` for persistence across sessions.

After completing a response, include: <terse>a brief description of what you just did</terse>`;

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
      model: options.model || 'claude-sonnet-4-6',
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
      model: options.overrides?.model ?? template.manifest.config.model ?? 'claude-sonnet-4-6',
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
