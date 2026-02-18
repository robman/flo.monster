/**
 * Agent-related message handlers: persist, subscribe, actions, restore.
 */

import type { SerializedSession, SerializedDomState, AgentEvent, HookRulesConfig } from '@flo-monster/core';
import type { PushManager } from '../push-manager.js';
import { getAdapter } from '@flo-monster/core';
import { join } from 'node:path';
import type { ConnectedClient } from '../server.js';
import type { AgentStore } from '../agent-store.js';
import type { HubConfig } from '../config.js';
import type { HookExecutor } from '../hook-executor.js';
import { unpackFilesToDisk } from '../tools/hub-files.js';
import { getToolDefinitions } from '../tools/index.js';
import { scheduleToolDef } from '../tools/schedule.js';
import { contextSearchToolDef } from '../tools/context-search.js';
import { hubRunJsToolDef } from '../tools/hub-runjs.js';
import type { HubSkillManager } from '../skill-manager.js';
import type { BrowserToolRouter } from '../browser-tool-router.js';
import type { Scheduler } from '../scheduler.js';
import { HeadlessAgentRunner, type RunnerDeps } from '../agent-runner.js';
import { createSendApiRequest } from '../api-client.js';
import { createToolExecutor } from '../runner-tool-executor.js';
import { DeclarativeHookEvaluator } from '../declarative-hook-evaluator.js';
import { sendWsMessage } from '../utils/ws-utils.js';
import type {
  PersistAgentMessage,
  SubscribeAgentMessage,
  UnsubscribeAgentMessage,
  AgentActionMessage,
  SendMessageToAgentMessage,
  RestoreAgentMessage,
  PersistResultMessage,
  AgentEventMessage,
  AgentLoopEventMessage,
  AgentStateMessage,
  RestoreSessionMessage,
  ErrorMessage,
} from './types.js';

/**
 * Dependencies for agent handler functions.
 */
export interface AgentHandlerDeps {
  hubConfig: HubConfig;
  hookExecutor?: HookExecutor;
  skillManager?: HubSkillManager;
  agentStore?: AgentStore;
  agentStorePath?: string;
  clients: Set<ConnectedClient>;
  browserToolRouter?: BrowserToolRouter;
  scheduler?: Scheduler;
  pushManager?: PushManager;
}

/**
 * Create RunnerDeps for a given agent session and hub agent ID.
 */
export function createRunnerDeps(
  session: SerializedSession,
  hubAgentId: string,
  deps: AgentHandlerDeps,
  runner?: HeadlessAgentRunner,
  perAgentApiKey?: string,
  hooks?: HookRulesConfig,
): RunnerDeps {
  const provider = session.config.provider || 'anthropic';
  const adapter = getAdapter(provider);

  const sendApiRequest = createSendApiRequest({
    hubConfig: deps.hubConfig,
    provider,
    perAgentApiKey,
  });

  // Compute files root for hub-side file operations
  const filesRoot = deps.agentStorePath
    ? join(deps.agentStorePath, hubAgentId, 'files')
    : undefined;

  // Compute per-agent sandbox directory for bash isolation
  const agentSandbox = deps.hubConfig.sandboxPath
    ? join(deps.hubConfig.sandboxPath, hubAgentId)
    : undefined;

  // Compute per-agent data directory for runjs logging
  const agentDataDir = deps.agentStorePath
    ? join(deps.agentStorePath, hubAgentId)
    : undefined;

  const declarativeHookEvaluator = hooks ? new DeclarativeHookEvaluator(hooks) : undefined;

  const executeToolCall = createToolExecutor({
    hubConfig: deps.hubConfig,
    hookExecutor: deps.hookExecutor,
    skillManager: deps.skillManager,
    browserToolRouter: deps.browserToolRouter,
    hubAgentId,
    agentConfig: session.config,
    stateStore: runner?.getStateStore(),
    storageStore: runner?.getStorageStore(),
    filesRoot,
    domContainer: runner?.getDomContainer(),
    scheduler: deps.scheduler,
    agentSandbox,
    getMessages: runner ? () => runner.getMessageHistory() : undefined,
    declarativeHookEvaluator,
    pushManager: deps.pushManager,
    runner,
    agentDataDir,
  });

  // Compute hub tool definitions to inject for the LLM
  // These are tools the hub can execute but aren't in the browser agent's config.tools
  const hubToolDefs = [
    ...getToolDefinitions(deps.hubConfig, true),  // bash, filesystem, skill tools
    ...(deps.scheduler ? [scheduleToolDef] : []),
    contextSearchToolDef,
    hubRunJsToolDef,
  ];

  return {
    sendApiRequest,
    executeToolCall,
    adapter,
    agentStore: deps.agentStore,
    hubAgentId,
    hubToolDefs,
  };
}

/**
 * Set up event forwarding for a runner: both RunnerEvents and AgentEvents.
 */
export function setupEventForwarding(
  runner: HeadlessAgentRunner,
  hubAgentId: string,
  clients: Set<ConnectedClient>,
  pushManager?: PushManager,
): void {
  // Forward runner state events (state_change, message, error)
  runner.onEvent((event) => {
    const eventMsg: AgentEventMessage = {
      type: 'agent_event',
      agentId: hubAgentId,
      event,
    };
    for (const c of clients) {
      if (c.subscribedAgents.has(hubAgentId)) {
        sendWsMessage(c.ws, eventMsg);
      }
    }

    // Send push notification when agent emits notify_user
    if (event.type === 'notify_user' && pushManager) {
      pushManager.sendPush({
        title: 'flo.monster',
        body: String((event.data as any)?.message || 'Notification'),
        tag: `notify-${hubAgentId}`,
        agentId: hubAgentId,
      }).catch(err => {
        console.error(`[push] Failed to send notification for agent ${hubAgentId}:`, err);
      });
    }
  });

  // Forward agentic loop events (text_delta, tool_use_done, usage, etc.)
  runner.onAgentEvent((event: AgentEvent) => {
    const eventMsg: AgentLoopEventMessage = {
      type: 'agent_loop_event',
      agentId: hubAgentId,
      event,
    };
    for (const c of clients) {
      if (c.subscribedAgents.has(hubAgentId)) {
        sendWsMessage(c.ws, eventMsg);
      }
    }
  });
}

/**
 * Handle persist_agent message
 */
export async function handlePersistAgent(
  client: ConnectedClient,
  message: PersistAgentMessage,
  agents: Map<string, HeadlessAgentRunner>,
  clients: Set<ConnectedClient>,
  deps: AgentHandlerDeps,
): Promise<void> {
  try {
    const session = message.session;
    if (!session || !session.agentId) {
      const result: PersistResultMessage = {
        type: 'persist_result',
        hubAgentId: '',
        success: false,
        error: 'Invalid session data',
      };
      sendWsMessage(client.ws, result);
      return;
    }

    // Generate a unique hub agent ID
    const hubAgentId = `hub-${session.agentId}-${Date.now()}`;

    // Store per-agent API key if provided
    let perAgentApiKey: string | undefined;
    if (message.apiKey && message.apiKeyProvider) {
      perAgentApiKey = message.apiKey;
      // Save to disk alongside agent data
      if (deps.agentStorePath) {
        try {
          const { mkdir, writeFile } = await import('node:fs/promises');
          const agentDir = join(deps.agentStorePath, hubAgentId);
          await mkdir(agentDir, { recursive: true });
          await writeFile(
            join(agentDir, 'api-key.json'),
            JSON.stringify({ provider: message.apiKeyProvider, key: message.apiKey }),
            { encoding: 'utf-8', mode: 0o600 }
          );
        } catch (err) {
          console.warn(`[hub] Failed to save API key for ${hubAgentId}:`, err);
        }
      }
    }

    // Create runner first (inert) so it can initialize its state store from session
    const runner = new HeadlessAgentRunner(session);

    // Extract hooks from session dependencies
    const hooks = session.dependencies?.hooks as HookRulesConfig | undefined;

    // Create runner deps with the runner's state store
    const runnerDeps = createRunnerDeps(session, hubAgentId, deps, runner, perAgentApiKey, hooks);
    runner.setDeps(runnerDeps);

    // Unpack files to disk if session has files and agentStorePath is configured
    if (session.files && session.files.length > 0 && deps.agentStorePath) {
      const filesRoot = join(deps.agentStorePath, hubAgentId, 'files');
      try {
        await unpackFilesToDisk(session.files, filesRoot);
      } catch (err) {
        console.warn(`[hub] Failed to unpack files for ${hubAgentId}:`, err);
      }
    }

    // Create per-agent sandbox directory
    if (deps.hubConfig.sandboxPath) {
      const agentSandbox = join(deps.hubConfig.sandboxPath, hubAgentId);
      try {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(agentSandbox, { recursive: true });
      } catch (err) {
        console.warn(`[hub] Failed to create agent sandbox for ${hubAgentId}:`, err);
      }

      // Set ownership for runAsUser if configured
      if (deps.hubConfig.tools.bash.runAsUser) {
        try {
          const { executeProcess: execProc } = await import('../utils/process-utils.js');
          await execProc(
            `sudo -n chown -R ${deps.hubConfig.tools.bash.runAsUser} ${agentSandbox}`,
            { cwd: '/tmp', timeout: 5000 }
          );
        } catch {
          // chown may fail if sudo not configured — that's OK, setup command handles this
        }
      }
    }

    // Set ownership of files dir for runAsUser if configured
    if (deps.hubConfig.tools.bash.runAsUser && deps.agentStorePath) {
      const filesDir = join(deps.agentStorePath, hubAgentId, 'files');
      try {
        const { executeProcess: execProc } = await import('../utils/process-utils.js');
        await execProc(
          `sudo -n chown -R ${deps.hubConfig.tools.bash.runAsUser} ${filesDir}`,
          { cwd: '/tmp', timeout: 5000 }
        );
      } catch {
        // chown may fail if sudo not configured
      }
    }

    // Set up event forwarding to subscribed clients
    setupEventForwarding(runner, hubAgentId, clients, deps.pushManager);

    // Store the runner
    agents.set(hubAgentId, runner);

    // Auto-subscribe the persisting client
    client.subscribedAgents.add(hubAgentId);

    // Add info message to conversation log (visible in UI, not sent to LLM)
    runner.addInfoMessage(`Agent persisted to hub as ${hubAgentId}`);

    // Start the runner
    await runner.start();

    // Save to disk
    if (deps.agentStore) {
      try {
        await deps.agentStore.save(hubAgentId, session, {
          state: runner.getState(),
          totalTokens: session.metadata.totalTokens,
          totalCost: session.metadata.totalCost,
          savedAt: Date.now(),
        });
        console.log(`[hub] Saved agent ${hubAgentId} to disk`);
      } catch (err) {
        console.warn(`[hub] Failed to save agent ${hubAgentId} to disk:`, err);
      }
    }

    const result: PersistResultMessage = {
      type: 'persist_result',
      hubAgentId,
      success: true,
    };
    sendWsMessage(client.ws, result);
  } catch (err) {
    const result: PersistResultMessage = {
      type: 'persist_result',
      hubAgentId: '',
      success: false,
      error: String(err),
    };
    sendWsMessage(client.ws, result);
  }
}

/**
 * Handle subscribe_agent message
 */
export function handleSubscribeAgent(
  client: ConnectedClient,
  message: SubscribeAgentMessage,
  agents: Map<string, HeadlessAgentRunner>,
): void {
  const runner = agents.get(message.agentId);
  if (!runner) {
    const error: ErrorMessage = {
      type: 'error',
      message: `Agent not found: ${message.agentId}`,
    };
    sendWsMessage(client.ws, error);
    return;
  }

  client.subscribedAgents.add(message.agentId);

  // Send current state
  const stateMsg: AgentStateMessage = {
    type: 'agent_state',
    agentId: message.agentId,
    state: runner.getState(),
  };
  sendWsMessage(client.ws, stateMsg);

  // Send last known DOM state if available
  const domState = runner.getDomState();
  if (domState) {
    sendWsMessage(client.ws, {
      type: 'restore_dom_state',
      hubAgentId: message.agentId,
      domState,
    });
  }

  // Send conversation history for the browser to render
  const serialized = runner.serialize();
  if (serialized.conversation && serialized.conversation.length > 0) {
    // Content is ContentBlock[] — pass through directly.
    // Fallback for legacy string format from old serialized sessions.
    const messages = serialized.conversation.map((msg: any) => ({
      role: msg.role,
      content: Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content) }],
    }));
    sendWsMessage(client.ws, {
      type: 'conversation_history',
      agentId: message.agentId,
      messages,
    });
  }
}

/**
 * Handle unsubscribe_agent message
 */
export function handleUnsubscribeAgent(
  client: ConnectedClient,
  message: UnsubscribeAgentMessage,
): void {
  client.subscribedAgents.delete(message.agentId);
}

/**
 * Handle agent_action message
 */
export function handleAgentAction(
  client: ConnectedClient,
  message: AgentActionMessage,
  agents: Map<string, HeadlessAgentRunner>,
  agentStore?: AgentStore,
): void {
  // For 'remove', always delete from disk even if runner not in memory
  if (message.action === 'remove') {
    const runner = agents.get(message.agentId);
    if (runner) {
      runner.kill();
      agents.delete(message.agentId);
    }
    agentStore?.delete(message.agentId).catch(err => {
      console.error(`[AgentHandler] Failed to delete agent ${message.agentId} from disk:`, err);
    });
    return;
  }

  const runner = agents.get(message.agentId);
  if (!runner) {
    const error: ErrorMessage = {
      type: 'error',
      message: `Agent not found: ${message.agentId}`,
    };
    sendWsMessage(client.ws, error);
    return;
  }

  switch (message.action) {
    case 'pause':
      runner.pause();
      break;
    case 'resume':
      runner.resume();
      break;
    case 'stop':
      runner.stop();
      break;
    case 'kill':
      runner.kill();
      agents.delete(message.agentId);
      break;
  }

  // Save updated state to disk (for non-kill actions; 'remove' already returned above)
  if (agentStore && message.action !== 'kill') {
    const serialized = runner.serialize();
    agentStore.save(message.agentId, serialized, {
      state: runner.getState(),
      totalTokens: 0,
      totalCost: 0,
      savedAt: Date.now(),
    }).catch(err => console.warn(`[hub] Failed to save agent state:`, err));
  }

  // Delete from disk on kill
  if (message.action === 'kill' && agentStore) {
    agentStore.delete(message.agentId).catch(err =>
      console.warn(`[hub] Failed to delete agent from disk:`, err));
  }

  // Send updated state
  const stateMsg: AgentStateMessage = {
    type: 'agent_state',
    agentId: message.agentId,
    state: runner.getState(),
  };
  sendWsMessage(client.ws, stateMsg);
}

/**
 * Handle send_message to agent.
 * The runner's sendMessage triggers an async agentic loop — events flow
 * to subscribed clients via the runner's event callbacks.
 */
export function handleSendMessage(
  client: ConnectedClient,
  message: SendMessageToAgentMessage,
  agents: Map<string, HeadlessAgentRunner>,
): void {
  const runner = agents.get(message.agentId);
  if (!runner) {
    const error: ErrorMessage = {
      type: 'error',
      message: `Agent not found: ${message.agentId}`,
    };
    sendWsMessage(client.ws, error);
    return;
  }

  try {
    // sendMessage triggers async loop execution; events are forwarded via callbacks.
    // The runner auto-persists to disk after the loop completes (via RunnerDeps.agentStore).
    runner.sendMessage(message.content);
  } catch (err) {
    const error: ErrorMessage = {
      type: 'error',
      message: String(err),
    };
    sendWsMessage(client.ws, error);
  }
}

/**
 * Handle restore_agent message
 */
export function handleRestoreAgent(
  client: ConnectedClient,
  message: RestoreAgentMessage,
  agents: Map<string, HeadlessAgentRunner>,
): void {
  // Authorization: client must be subscribed to the agent
  if (!client.subscribedAgents.has(message.agentId)) {
    const result: RestoreSessionMessage = {
      type: 'restore_session',
      session: null,
    };
    sendWsMessage(client.ws, result);
    return;
  }

  const runner = agents.get(message.agentId);

  if (!runner) {
    const result: RestoreSessionMessage = {
      type: 'restore_session',
      session: null,
    };
    sendWsMessage(client.ws, result);
    return;
  }

  const session = runner.serialize();
  const result: RestoreSessionMessage = {
    type: 'restore_session',
    session,
  };
  sendWsMessage(client.ws, result);
}

/**
 * Handle list_hub_agents message — returns summaries of all hub agents
 */
export function handleListHubAgents(
  client: ConnectedClient,
  agents: Map<string, HeadlessAgentRunner>,
): void {
  const agentList: Array<{
    hubAgentId: string;
    agentName: string;
    model: string;
    provider: string;
    state: string;
    busy: boolean;
    totalCost: number;
    createdAt: number;
    lastActivity: number;
  }> = [];

  for (const [hubAgentId, runner] of agents) {
    const session = runner.serialize();
    agentList.push({
      hubAgentId,
      agentName: runner.config.name,
      model: runner.config.model,
      provider: runner.config.provider || 'anthropic',
      state: runner.getState(),
      busy: runner.busy,
      totalCost: session.metadata.totalCost,
      createdAt: session.metadata.createdAt,
      lastActivity: session.metadata.serializedAt,
    });
  }

  sendWsMessage(client.ws, {
    type: 'hub_agents_list',
    agents: agentList,
  });
}

/**
 * Handle state_write_through from browser -- update hub state store and push to other browsers
 */
export function handleStateWriteThrough(
  client: ConnectedClient,
  message: { type: string; hubAgentId: string; key: string; value: unknown; action: 'set' | 'delete' },
  agents: Map<string, HeadlessAgentRunner>,
  clients: Set<ConnectedClient>,
  agentStore?: AgentStore,
): void {
  // Authorization: client must be subscribed to the agent
  if (!client.subscribedAgents.has(message.hubAgentId)) return;

  const runner = agents.get(message.hubAgentId);
  if (!runner) return;

  const stateStore = runner.getStateStore();

  // Apply the state change
  if (message.action === 'set') {
    stateStore.set(message.key, message.value);
  } else if (message.action === 'delete') {
    stateStore.delete(message.key);
  }

  // Push to other subscribed browsers (not the sender)
  for (const c of clients) {
    if (c !== client && c.subscribedAgents.has(message.hubAgentId)) {
      sendWsMessage(c.ws, {
        type: 'state_push',
        hubAgentId: message.hubAgentId,
        key: message.key,
        value: message.value,
        action: message.action,
      });
    }
  }

  // Persist to disk
  if (agentStore) {
    agentStore.save(message.hubAgentId, runner.serialize(), {
      state: runner.getState(),
      totalTokens: 0,
      totalCost: 0,
      savedAt: Date.now(),
    }).catch(err => console.warn('[hub] Failed to save state write-through:', err));
  }
}

/**
 * Handle dom_state_update from browser -- store in runner
 */
export function handleDomStateUpdate(
  client: ConnectedClient,
  message: { type: string; hubAgentId: string; domState: unknown },
  agents: Map<string, HeadlessAgentRunner>,
  agentStore?: AgentStore,
  clients?: Set<ConnectedClient>,
): void {
  // Authorization: client must be subscribed to the agent
  if (!client.subscribedAgents.has(message.hubAgentId)) return;

  const runner = agents.get(message.hubAgentId);
  if (!runner) return;

  runner.setDomState(message.domState as SerializedDomState);

  // Broadcast to other subscribed browsers (not the sender)
  if (clients) {
    for (const c of clients) {
      if (c !== client && c.subscribedAgents.has(message.hubAgentId)) {
        sendWsMessage(c.ws, {
          type: 'restore_dom_state',
          hubAgentId: message.hubAgentId,
          domState: message.domState,
        });
      }
    }
  }

  // Persist to disk
  if (agentStore) {
    agentStore.save(message.hubAgentId, runner.serialize(), {
      state: runner.getState(),
      totalTokens: 0,
      totalCost: 0,
      savedAt: Date.now(),
    }).catch(err => console.warn('[hub] Failed to save DOM state:', err));
  }
}
