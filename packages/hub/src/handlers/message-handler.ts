/**
 * Message handling: routing, tool calls, fetch proxy, auth, audit logging.
 */

import { join } from 'node:path';
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
import type { BrowseSessionManager } from '../browse-session.js';
import type { BrowseProxy } from '../browse-proxy.js';
import type { ScreencastManager } from '../screencast-manager.js';
import type { StreamServer } from '../stream-server.js';
import type { InterveneManager } from '../intervene-manager.js';
import type { InterveneInputExecutor } from '../intervene-input.js';
import { getAccessibilityTree, getPageMetadata } from '../utils/page-accessibility.js';
import { executeBrowse, type BrowseInput, type BrowseDeps } from '../tools/browse.js';
import type { AccessibilityNode } from '../utils/accessibility-tree.js';
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
  BrowseInterveneRequestMessage,
  BrowseInterveneReleaseMessage,
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
  browseSessionManager?: BrowseSessionManager,
  browseProxy?: BrowseProxy,
  signingSecret?: Buffer,
  hubUrl?: string,
  agentStorePath?: string,
): Promise<void> {
  auditLog({
    timestamp: new Date().toISOString(),
    event: 'tool_request',
    clientIp: client.remoteAddress,
    toolName: message.name,
    details: { id: message.id },
  });

  let result;

  // Browse tool needs special handling — it requires session manager, proxy, and per-agent element refs
  if (message.name === 'browse' && browseSessionManager && browseProxy && config.tools.browse?.enabled) {
    // Use the agent's persistent ID (sent from browser) instead of a random per-connection ID
    const browseAgentId = (message as any).agentId || `anon-${client.id}`;
    // Compute files root for this agent's browse session
    const fileRoot = agentStorePath
      ? join(agentStorePath, browseAgentId, 'files')
      : undefined;
    const browseDeps: BrowseDeps = {
      sessionManager: browseSessionManager,
      proxy: browseProxy,
      config: config.tools.browse,
      agentId: browseAgentId,
      elementRefs: browseSessionManager.getElementRefs(browseAgentId),
      fileRoot,
      hubUrl,
      signingSecret,
    };
    result = await executeBrowse(message.input as BrowseInput, browseDeps);
  } else {
    // Create approval function that routes through connected clients
    const approvalFn = (skill: { name: string; description: string; content: string }) =>
      requestSkillApproval(clients, skill);

    result = await executeTool(message.name, message.input as ToolInput, config, hookExecutor, skillManager, approvalFn);
  }

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
// Intervention notification helper
// ============================================================================

/**
 * Build a notification message for the agent after intervention ends.
 */
async function buildInterveneNotification(
  session: { mode: 'visible' | 'private'; eventLog: Array<{ timestamp: number; kind: string; details: Record<string, unknown> }> },
  browseSessionManager: BrowseSessionManager,
  agentId: string,
): Promise<string> {
  const parts: string[] = [];

  if (session.mode === 'visible') {
    parts.push('[User intervention ended — visible mode]');
    if (session.eventLog.length > 0) {
      parts.push('');
      parts.push('User actions during intervention:');
      // Summarize events: collapse consecutive mousemoves/scrolls, format concisely
      const summarized: string[] = [];
      let i = 0;
      while (i < session.eventLog.length) {
        const ev = session.eventLog[i];

        if (ev.kind === 'mousemove') {
          // Collapse consecutive mousemoves — keep only the last position
          let lastMove = ev;
          while (i + 1 < session.eventLog.length && session.eventLog[i + 1].kind === 'mousemove') {
            i++;
            lastMove = session.eventLog[i];
          }
          const x = lastMove.details.x ?? lastMove.details.clientX ?? '?';
          const y = lastMove.details.y ?? lastMove.details.clientY ?? '?';
          summarized.push(`  - mouse moved to (${x}, ${y})`);
        } else if (ev.kind === 'scroll') {
          // Collapse consecutive scrolls — report net direction
          let netDeltaX = 0;
          let netDeltaY = 0;
          let j = i;
          while (j < session.eventLog.length && session.eventLog[j].kind === 'scroll') {
            netDeltaX += (session.eventLog[j].details.deltaX as number) || 0;
            netDeltaY += (session.eventLog[j].details.deltaY as number) || 0;
            j++;
          }
          i = j - 1; // will be incremented at end of loop
          const dirs: string[] = [];
          if (netDeltaY < 0) dirs.push('up');
          if (netDeltaY > 0) dirs.push('down');
          if (netDeltaX < 0) dirs.push('left');
          if (netDeltaX > 0) dirs.push('right');
          summarized.push(`  - scrolled ${dirs.length > 0 ? dirs.join(' and ') : '(no net movement)'}`);
        } else if (ev.kind === 'click' || ev.kind === 'dblclick' || ev.kind === 'contextmenu') {
          const x = ev.details.x ?? ev.details.clientX ?? '?';
          const y = ev.details.y ?? ev.details.clientY ?? '?';
          summarized.push(`  - ${ev.kind} at (${x}, ${y})`);
        } else if (ev.kind === 'keydown' || ev.kind === 'keyup' || ev.kind === 'keypress') {
          const key = ev.details.key ?? ev.details.code ?? '?';
          summarized.push(`  - ${ev.kind} "${key}"`);
        } else if (ev.kind === 'input') {
          const value = ev.details.value !== undefined ? `: "${ev.details.value}"` : '';
          summarized.push(`  - input${value}`);
        } else {
          // Other events: show kind with concise details
          const { kind: _kind, ...rest } = ev.details;
          const detailStr = Object.keys(rest).length > 0
            ? ` ${JSON.stringify(rest)}`
            : '';
          summarized.push(`  - ${ev.kind}${detailStr}`);
        }
        i++;
      }
      parts.push(...summarized);
    }
  } else {
    parts.push('[User completed private interaction — input details hidden]');
  }

  // Get fresh page state
  try {
    const page = browseSessionManager.getPage(agentId);
    if (page) {
      const metadata = await getPageMetadata(page);
      // Use the agent's real element refs so the agent can reference
      // elements from the notification snapshot in subsequent browse calls
      const elementRefs = browseSessionManager.getElementRefs(agentId);
      elementRefs.clear();
      const tree = await getAccessibilityTree(page, elementRefs);
      parts.push('');
      parts.push('Current page state:');
      parts.push(metadata);
      parts.push('');
      parts.push(tree);
    }
  } catch (err) {
    parts.push('');
    parts.push(`[Failed to capture page state: ${(err as Error).message}]`);
  }

  return parts.join('\n');
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
  browseSessionManager?: BrowseSessionManager,
  browseProxy?: BrowseProxy,
  signingSecret?: Buffer,
  hubUrl?: string,
  screencastManager?: ScreencastManager,
  streamServer?: StreamServer,
  interveneManager?: InterveneManager,
  interveneInputExecutor?: InterveneInputExecutor,
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
    await handleToolCall(client, message as ToolCallMessage, config, clients, hookExecutor, skillManager, browseSessionManager, browseProxy, signingSecret, hubUrl, agentStorePath);
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
      browseSessionManager,
      browseProxy,
      signingSecret,
      hubUrl,
    });
    return;
  }

  // Handle subscribe_agent
  if (message.type === 'subscribe_agent') {
    const subMsg = message as SubscribeAgentMessage;
    handleSubscribeAgent(client, subMsg, agents, agentStorePath);
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
    handleAgentAction(client, actionMsg, agents, agentStore, browseSessionManager);
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
    handleDomStateUpdate(client, message as any, agents, agentStore, clients, agentStorePath);
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

  // Handle browse_intervene_request
  if (message.type === 'browse_intervene_request') {
    const { agentId, mode } = message as unknown as BrowseInterveneRequestMessage;

    if (!interveneManager || !browseSessionManager) {
      sendWsMessage(client.ws, {
        type: 'browse_intervene_denied',
        agentId,
        reason: 'Intervention not available',
      });
      return;
    }

    // Verify agent has an active browse session
    if (!browseSessionManager.hasSession(agentId)) {
      sendWsMessage(client.ws, {
        type: 'browse_intervene_denied',
        agentId,
        reason: 'No active browse session for this agent',
      });
      return;
    }

    // Try to start intervention
    const session = interveneManager.requestIntervene(agentId, client.id, mode);
    if (!session) {
      sendWsMessage(client.ws, {
        type: 'browse_intervene_denied',
        agentId,
        reason: 'Another user is already intervening',
      });
      return;
    }

    // Pause the agent runner if it exists
    const runner = agents.get(agentId);
    if (runner) {
      runner.interveneStart();
    }

    sendWsMessage(client.ws, {
      type: 'browse_intervene_granted',
      agentId,
      mode,
    });
    return;
  }

  // Handle browse_intervene_release
  if (message.type === 'browse_intervene_release') {
    const { agentId } = message as unknown as BrowseInterveneReleaseMessage;

    if (!interveneManager || !browseSessionManager) {
      return;
    }

    const session = interveneManager.release(agentId, client.id);
    if (!session) {
      return; // Not intervening or wrong client
    }

    // Clear focus tracking state
    interveneInputExecutor?.clearFocusState(agentId);

    // Build notification for the agent
    const notification = await buildInterveneNotification(session, browseSessionManager, agentId);

    // Resume the agent runner (hub-persisted agents)
    const runner = agents.get(agentId);
    if (runner && runner.isIntervenePaused) {
      runner.interveneEnd(notification);
    }

    // Always include notification so browser can render the intervention block.
    // Hub-persisted agents also get it via runner.interveneEnd above (for LLM processing).
    // Browser-routed agents use the notification to send to the worker.
    sendWsMessage(client.ws, {
      type: 'browse_intervene_ended',
      agentId,
      reason: 'released',
      notification,
    });
    return;
  }

  // Handle browse_stream_request
  if (message.type === 'browse_stream_request') {
    const { agentId } = message as { type: string; agentId: string };

    if (!screencastManager || !streamServer || !browseSessionManager) {
      sendWsMessage(client.ws, {
        type: 'browse_stream_error',
        agentId,
        error: 'Browse streaming not available',
      });
      return;
    }

    // Verify agent has an active browse session
    if (!browseSessionManager.hasSession(agentId)) {
      sendWsMessage(client.ws, {
        type: 'browse_stream_error',
        agentId,
        error: 'No active browse session for this agent',
      });
      return;
    }

    // Generate token and respond with stream port info
    const token = streamServer.generateToken(agentId, client.id);
    const streamPort = streamServer.port;

    // Get viewport dimensions from browse session config
    const viewport = config.tools.browse?.viewport ?? { width: 1419, height: 813 };

    sendWsMessage(client.ws, {
      type: 'browse_stream_token',
      agentId,
      token,
      streamPort,
      viewport,
      ...(config.trustProxy && config.publicHost ? { streamUrl: `wss://${config.publicHost}/stream?token=${token}` } : {}),
    });
    return;
  }

  // Handle browse_stream_stop
  if (message.type === 'browse_stream_stop') {
    const { agentId } = message as { type: string; agentId: string };

    if (streamServer) {
      streamServer.closeConnectionForClient(client.id);
    }
    if (screencastManager) {
      await screencastManager.stopAllForClient(client.id);
    }

    sendWsMessage(client.ws, {
      type: 'browse_stream_stopped',
      agentId,
    });
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
