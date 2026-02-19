/**
 * Message handling: routing, tool calls, fetch proxy, auth, audit logging.
 */

import type { HubConfig } from '../config.js';
import { validateToken } from '../auth.js';
import { getToolDefinitions, executeTool } from '../tools/index.js';
import type { ToolInput } from '../tools/index.js';
import type { HookExecutor } from '../hook-executor.js';
import type { HubSkillManager } from '../skill-manager.js';
import type { AgentStore } from '../agent-store.js';
import type { HeadlessAgentRunner } from '../agent-runner.js';
import type { ConnectedClient } from '../server.js';
import type { BrowserToolRouter } from '../browser-tool-router.js';
import type { Scheduler } from '../scheduler.js';
import type { PushManager } from '../push-manager.js';
import { sendWsMessage } from '../utils/ws-utils.js';
import { executeSafeFetch } from '../utils/safe-fetch.js';
import {
  handlePersistAgent,
  handleSubscribeAgent,
  handleUnsubscribeAgent,
  handleAgentAction,
  handleSendMessage,
  handleRestoreAgent,
  handleListHubAgents,
  handleDomStateUpdate,
  handleStateWriteThrough,
} from './agent-handler.js';
import type {
  HubMessage,
  AuthMessage,
  ToolCallMessage,
  ToolResultMessage,
  FetchRequestMessage,
  FetchResultMessage,
  ErrorMessage,
  SubscribeAgentMessage,
  UnsubscribeAgentMessage,
  AgentActionMessage,
  SendMessageToAgentMessage,
  RestoreAgentMessage,
  PersistAgentMessage,
  ApiProxyRequestMessage,
} from './types.js';
import { getProviderRoute } from '../http-server.js';
import { streamCliEvents, type CliProxyRequest } from '../cli-proxy.js';

// ============================================================================
// Audit logging
// ============================================================================

interface AuditLogEntry {
  timestamp: string;
  event: 'tool_request' | 'tool_result' | 'auth_attempt' | 'connection';
  clientIp?: string;
  toolName?: string;
  success?: boolean;
  error?: string;
  details?: Record<string, unknown>;
}

function auditLog(entry: AuditLogEntry): void {
  // Structured log in JSON format for easy parsing
  console.log(JSON.stringify({
    audit: true,
    ...entry,
  }));
}

// ============================================================================
// Pending skill approvals
// ============================================================================

interface PendingApproval {
  resolve: (approved: boolean) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const pendingApprovals = new Map<string, PendingApproval>();

/**
 * Request skill approval from a connected browser client
 */
export async function requestSkillApproval(
  clients: Set<ConnectedClient>,
  skill: { name: string; description: string; content: string },
  timeoutMs: number = 60000,
): Promise<boolean> {
  // Find first authenticated client
  const client = Array.from(clients).find(c => c.authenticated);
  if (!client) {
    throw new Error('No browser connected for skill approval');
  }

  const id = `approval-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingApprovals.delete(id);
      reject(new Error('Skill approval request timed out'));
    }, timeoutMs);

    pendingApprovals.set(id, { resolve, reject, timeout });

    sendWsMessage(client.ws, {
      type: 'skill_approval_request',
      id,
      skill,
    });
  });
}

// ============================================================================
// Tool call handler
// ============================================================================

/**
 * Handle a tool call message
 */
async function handleToolCall(
  client: ConnectedClient,
  message: ToolCallMessage,
  config: HubConfig,
  clients: Set<ConnectedClient>,
  hookExecutor?: HookExecutor,
  skillManager?: HubSkillManager,
): Promise<void> {
  auditLog({
    timestamp: new Date().toISOString(),
    event: 'tool_request',
    clientIp: client.remoteAddress,
    toolName: message.name,
    details: { id: message.id },
  });

  // Create approval function that routes through connected clients
  const approvalFn = (skill: { name: string; description: string; content: string }) =>
    requestSkillApproval(clients, skill);

  const result = await executeTool(message.name, message.input as ToolInput, config, hookExecutor, skillManager, approvalFn);

  auditLog({
    timestamp: new Date().toISOString(),
    event: 'tool_result',
    clientIp: client.remoteAddress,
    toolName: message.name,
    success: !result.is_error,
    error: result.is_error ? result.content.substring(0, 200) : undefined,
    details: { id: message.id },
  });

  const response: ToolResultMessage = {
    type: 'tool_result',
    id: message.id,
    result,
  };

  sendWsMessage(client.ws, response);
}

// ============================================================================
// Fetch proxy handler
// ============================================================================

/**
 * Handle a fetch request (proxy)
 */
async function handleFetchRequest(
  client: ConnectedClient,
  message: FetchRequestMessage,
  config: HubConfig
): Promise<void> {
  try {
    // Check if fetch proxy is enabled
    if (!config.fetchProxy.enabled) {
      const response: FetchResultMessage = {
        type: 'fetch_result',
        id: message.id,
        status: 0,
        body: '',
        error: 'Fetch proxy is disabled',
      };
      sendWsMessage(client.ws, response);
      return;
    }

    // Delegate to executeSafeFetch — handles private IP checks, blocked patterns,
    // sensitive header stripping, manual redirect following with per-hop validation
    const result = await executeSafeFetch(message.url, {
      method: message.options?.method,
      headers: message.options?.headers as Record<string, string> | undefined,
      body: message.options?.body,
      blockedPatterns: config.fetchProxy.blockedPatterns,
    });

    const response: FetchResultMessage = {
      type: 'fetch_result',
      id: message.id,
      status: result.status,
      body: result.body,
      error: result.error,
    };
    sendWsMessage(client.ws, response);
  } catch (error) {
    const response: FetchResultMessage = {
      type: 'fetch_result',
      id: message.id,
      status: 0,
      body: '',
      error: `Fetch proxy error: ${(error as Error).message}`,
    };
    sendWsMessage(client.ws, response);
  }
}

// ============================================================================
// API proxy handler (Mode 3: browser routes API through hub WS)
// ============================================================================

/**
 * Handle an API proxy request from browser.
 * Proxies API calls through hub's shared keys, streaming response chunks
 * back over the WebSocket connection.
 */
async function handleApiProxyRequest(
  client: ConnectedClient,
  message: ApiProxyRequestMessage,
  config: HubConfig,
): Promise<void> {
  try {
    // 1. Resolve provider route from path
    const route = getProviderRoute(message.path, config);
    // Verbose per-request logging — uncomment for debugging
    // console.log(`[hub] api_proxy: route=${route ? `${route.provider} → ${route.upstreamUrl}` : 'null'}`);
    if (!route) {
      sendWsMessage(client.ws, {
        type: 'api_error',
        id: message.id,
        error: 'Unknown provider path',
      });
      return;
    }

    // 2. CLI proxy — stream via streamCliEvents()
    if (config.cliProviders?.[route.provider]) {
      const cliConfig = config.cliProviders[route.provider];
      try {
        for await (const sseChunk of streamCliEvents(message.payload as CliProxyRequest, cliConfig)) {
          sendWsMessage(client.ws, {
            type: 'api_stream_chunk',
            id: message.id,
            chunk: sseChunk,
          });
        }
        sendWsMessage(client.ws, { type: 'api_stream_end', id: message.id });
      } catch (err) {
        sendWsMessage(client.ws, {
          type: 'api_error',
          id: message.id,
          error: `CLI proxy error: ${(err as Error).message}`,
        });
      }
      return;
    }

    // 3. Look up API key
    let apiKey = config.sharedApiKeys?.[route.provider];
    if (!apiKey && config.providers?.[route.provider]) {
      apiKey = config.providers[route.provider].apiKey;
    }

    if (!apiKey && route.provider !== 'ollama') {
      sendWsMessage(client.ws, {
        type: 'api_error',
        id: message.id,
        error: `No shared API key configured for provider: ${route.provider}`,
      });
      return;
    }

    // 4. Build upstream headers
    const upstreamHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (route.provider === 'anthropic') {
      if (apiKey) upstreamHeaders['x-api-key'] = apiKey;
      upstreamHeaders['anthropic-version'] = '2023-06-01';
    } else if (route.provider === 'gemini' && apiKey) {
      upstreamHeaders['x-goog-api-key'] = apiKey;
    } else if (apiKey) {
      upstreamHeaders['Authorization'] = `Bearer ${apiKey}`;
    }

    // 5. Fetch from upstream
    const response = await fetch(route.upstreamUrl, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(message.payload),
    });

    if (!response.ok) {
      sendWsMessage(client.ws, {
        type: 'api_error',
        id: message.id,
        error: `${response.status} ${response.statusText}`,
      });
      return;
    }

    // 6. Stream response body back over WebSocket
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          sendWsMessage(client.ws, {
            type: 'api_stream_chunk',
            id: message.id,
            chunk,
          });
        }
      } catch (streamError) {
        sendWsMessage(client.ws, {
          type: 'api_error',
          id: message.id,
          error: `Stream error: ${(streamError as Error).message}`,
        });
        return;
      }
    }

    sendWsMessage(client.ws, {
      type: 'api_stream_end',
      id: message.id,
    });
  } catch (error) {
    sendWsMessage(client.ws, {
      type: 'api_error',
      id: message.id,
      error: `API proxy error: ${(error as Error).message}`,
    });
  }
}

// ============================================================================
// Main message router
// ============================================================================

/**
 * Handle incoming message from a client
 */
export async function handleMessage(
  client: ConnectedClient,
  message: HubMessage,
  config: HubConfig,
  agents: Map<string, HeadlessAgentRunner>,
  clients: Set<ConnectedClient>,
  hookExecutor?: HookExecutor,
  skillManager?: HubSkillManager,
  agentStore?: AgentStore,
  browserToolRouter?: BrowserToolRouter,
  agentStorePath?: string,
  scheduler?: Scheduler,
  pushManager?: PushManager,
): Promise<void> {
  // Handle authentication
  if (message.type === 'auth') {
    const authMessage = message as AuthMessage;
    const valid = validateToken(authMessage.token, config, client.remoteAddress);

    auditLog({
      timestamp: new Date().toISOString(),
      event: 'auth_attempt',
      clientIp: client.remoteAddress,
      success: valid,
    });

    if (valid) {
      client.authenticated = true;

      // Generate a hub ID from config
      const hubId = config.name.toLowerCase().replace(/\s+/g, '-') + '-' + config.port;

      // Build the HTTP API URL (use publicHost if set, for TLS cert hostname matching)
      const httpHost = config.publicHost || config.host;
      const httpApiUrl = config.tls
        ? `https://${httpHost}:${config.port}`
        : `http://${httpHost}:${config.port}`;

      // Send auth_result first
      const authResult = {
        type: 'auth_result',
        success: true,
        hubId,
        hubName: config.name,
        sharedProviders: [
          ...Object.keys(config.sharedApiKeys || {}),
          ...Object.keys(config.cliProviders || {}),
        ],
        httpApiUrl,
      };
      console.log(`[hub] Auth success from ${client.remoteAddress}`);
      sendWsMessage(client.ws, authResult);

      // Then announce available tools
      const tools = getToolDefinitions(config);
      const announceTools = {
        type: 'announce_tools',
        tools,
      };
      sendWsMessage(client.ws, announceTools);

      // Send VAPID public key if push is enabled
      if (pushManager?.isEnabled) {
        const vapidKey = pushManager.getVapidPublicKey();
        if (vapidKey) {
          sendWsMessage(client.ws, {
            type: 'vapid_public_key',
            key: vapidKey,
          });
        }
      }
    } else {
      const authResult = {
        type: 'auth_result',
        success: false,
        hubId: '',
        hubName: '',
        error: 'Authentication failed',
      };
      console.log(`[hub] Auth failure from ${client.remoteAddress}`);
      sendWsMessage(client.ws, authResult);
      client.ws.close(4001, 'Authentication failed');
    }
    return;
  }

  // All other messages require authentication
  if (!client.authenticated) {
    const error: ErrorMessage = {
      type: 'error',
      id: message.id,
      message: 'Not authenticated',
    };
    sendWsMessage(client.ws, error);
    return;
  }

  // Handle skill_approval_response
  if (message.type === 'skill_approval_response') {
    const { id, approved } = message as { type: string; id: string; approved: boolean };
    const pending = pendingApprovals.get(id);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingApprovals.delete(id);
      pending.resolve(approved);
    }
    return;
  }

  // Handle browser_tool_result
  if (message.type === 'browser_tool_result') {
    if (browserToolRouter) {
      const { id, result } = message as { type: string; id: string; result: { content: string; is_error?: boolean } };
      browserToolRouter.handleResult(id, result);
    }
    return;
  }

  // Handle tool requests
  if (message.type === 'tool_request') {
    await handleToolCall(client, message as ToolCallMessage, config, clients, hookExecutor, skillManager);
    return;
  }

  // Handle fetch requests (proxy)
  if (message.type === 'fetch_request') {
    await handleFetchRequest(client, message as unknown as FetchRequestMessage, config);
    return;
  }

  // Handle persist_agent
  if (message.type === 'persist_agent') {
    const persistMsg = message as unknown as PersistAgentMessage;
    await handlePersistAgent(client, persistMsg, agents, clients, {
      hubConfig: config,
      hookExecutor,
      skillManager,
      agentStore,
      agentStorePath,
      clients,
      browserToolRouter,
      scheduler,
      pushManager,
    });
    return;
  }

  // Handle subscribe_agent
  if (message.type === 'subscribe_agent') {
    const subMsg = message as SubscribeAgentMessage;
    handleSubscribeAgent(client, subMsg, agents);
    return;
  }

  // Handle unsubscribe_agent
  if (message.type === 'unsubscribe_agent') {
    const unsubMsg = message as UnsubscribeAgentMessage;
    handleUnsubscribeAgent(client, unsubMsg);
    return;
  }

  // Handle agent_action
  if (message.type === 'agent_action') {
    const actionMsg = message as AgentActionMessage;
    handleAgentAction(client, actionMsg, agents, agentStore);
    browserToolRouter?.setLastActiveClient(actionMsg.agentId, client);
    return;
  }

  // Handle send_message
  if (message.type === 'send_message') {
    const sendMsg = message as SendMessageToAgentMessage;
    handleSendMessage(client, sendMsg, agents);
    browserToolRouter?.setLastActiveClient(sendMsg.agentId, client);
    return;
  }

  // Handle restore_agent
  if (message.type === 'restore_agent') {
    const restoreMsg = message as RestoreAgentMessage;
    handleRestoreAgent(client, restoreMsg, agents);
    return;
  }

  // Handle list_hub_agents
  if (message.type === 'list_hub_agents') {
    handleListHubAgents(client, agents);
    return;
  }

  // Handle dom_state_update
  if (message.type === 'dom_state_update') {
    handleDomStateUpdate(client, message as any, agents, agentStore, clients);
    return;
  }

  // Handle state_write_through
  if (message.type === 'state_write_through') {
    handleStateWriteThrough(client, message as any, agents, clients, agentStore);
    return;
  }

  // Handle push_subscribe
  if (message.type === 'push_subscribe') {
    if (pushManager) {
      const { deviceId, subscription } = message as { type: string; deviceId: string; subscription: { endpoint: string; keys: { p256dh: string; auth: string } } };
      const result = await pushManager.subscribe(deviceId, subscription);
      if ('error' in result) {
        sendWsMessage(client.ws, {
          type: 'push_subscribe_result',
          deviceId,
          success: false,
          error: result.error,
        });
      } else {
        sendWsMessage(client.ws, {
          type: 'push_subscribe_result',
          deviceId,
          success: true,
        });
      }
    } else {
      console.error('[hub] push_subscribe: no pushManager available');
    }
    return;
  }

  // Handle push_verify_pin
  if (message.type === 'push_verify_pin') {
    if (pushManager) {
      const { deviceId, pin } = message as { type: string; deviceId: string; pin: string };
      const verified = await pushManager.verifyPin(deviceId, pin);
      sendWsMessage(client.ws, {
        type: 'push_verify_result',
        deviceId,
        verified,
      });
    }
    return;
  }

  // Handle push_unsubscribe
  if (message.type === 'push_unsubscribe') {
    if (pushManager) {
      const { deviceId } = message as { type: string; deviceId: string };
      await pushManager.unsubscribe(deviceId);
    }
    return;
  }

  // Handle visibility_state
  if (message.type === 'visibility_state') {
    if (pushManager) {
      const { deviceId, visible } = message as { type: string; deviceId: string; visible: boolean };
      pushManager.setDeviceVisibility(deviceId, visible);
    }
    return;
  }

  // Handle API proxy request (Mode 3: browser routes API through hub WS)
  if (message.type === 'api_proxy_request') {
    await handleApiProxyRequest(client, message as unknown as ApiProxyRequestMessage, config);
    return;
  }

  // Unknown message type
  const error: ErrorMessage = {
    type: 'error',
    id: message.id,
    message: `Unknown message type: ${message.type}`,
  };
  sendWsMessage(client.ws, error);
}
