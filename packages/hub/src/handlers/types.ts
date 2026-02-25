/**
 * Message types for hub WebSocket handlers.
 *
 * Where hub message types match the core protocol exactly, we use Extract<>
 * to derive them from ShellToHub / HubToShell discriminated unions.
 * Where the hub needs different property types (e.g., RunnerEvent vs AgentEvent,
 * or SerializedSession vs unknown), we define hub-specific interfaces.
 */

import type { SerializedSession, ShellToHub, HubToShell, AgentEvent } from '@flo-monster/core';
import type { RunnerEvent } from '../agent-runner.js';

// ============================================================================
// Generic parsed message
// ============================================================================

/** Generic parsed WebSocket message -- used for parseMessage() return type */
export interface HubMessage {
  type: string;
  id?: string;
  [key: string]: unknown;
}

// ============================================================================
// Exact matches with core protocol (derived via Extract)
// ============================================================================

/** Browser -> Hub: tool execution request */
export type ToolCallMessage = Extract<ShellToHub, { type: 'tool_request' }>;

/** Hub -> Browser: tool execution result */
export type ToolResultMessage = Extract<HubToShell, { type: 'tool_result' }>;

/** Hub -> Browser: fetch proxy result */
export type FetchResultMessage = Extract<HubToShell, { type: 'fetch_result' }>;

/** Hub -> Browser: agent persistence result */
export type PersistResultMessage = Extract<HubToShell, { type: 'persist_result' }>;

/** Browser -> Hub: subscribe to agent events */
export type SubscribeAgentMessage = Extract<ShellToHub, { type: 'subscribe_agent' }>;

/** Browser -> Hub: unsubscribe from agent events */
export type UnsubscribeAgentMessage = Extract<ShellToHub, { type: 'unsubscribe_agent' }>;

/** Browser -> Hub: agent lifecycle action */
export type AgentActionMessage = Extract<ShellToHub, { type: 'agent_action' }>;

/** Browser -> Hub: send user message to a persisted agent */
export type SendMessageToAgentMessage = Extract<ShellToHub, { type: 'send_message' }>;

/** Browser -> Hub: restore a persisted agent session */
export type RestoreAgentMessage = Extract<ShellToHub, { type: 'restore_agent' }>;

// ============================================================================
// Hub-specific types (differ from core protocol)
// ============================================================================

/**
 * Browser -> Hub: fetch proxy request.
 * Hub uses a narrower options type than core's RequestInit since only
 * method, headers, and body are proxied.
 */
export interface FetchRequestMessage {
  type: 'fetch_request';
  id: string;
  url: string;
  options?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  };
}

/**
 * Browser -> Hub: authentication message.
 * Hub accepts token as optional (localhost bypass may not send one),
 * while core protocol requires it.
 */
export interface AuthMessage {
  type: 'auth';
  token?: string;
}

/** Hub -> Browser: error message (hub-internal, not in core protocol) */
export interface ErrorMessage {
  type: 'error';
  id?: string;
  message: string;
}

/**
 * Browser -> Hub: persist an agent session.
 * Hub uses SerializedSession instead of core's `unknown` for type safety.
 * Core protocol also includes keyHashes which the hub doesn't use.
 */
export interface PersistAgentMessage {
  type: 'persist_agent';
  session: SerializedSession;
  apiKey?: string;
  apiKeyProvider?: string;
}

/**
 * Hub -> Browser: agent event forwarding.
 * Hub uses RunnerEvent (hub-specific) instead of core's AgentEvent.
 */
export interface AgentEventMessage {
  type: 'agent_event';
  agentId: string;
  event: RunnerEvent;
}

/**
 * Hub -> Browser: agent state update.
 * Hub uses RunnerState (string) since runner states differ from core AgentState.
 */
export interface AgentStateMessage {
  type: 'agent_state';
  agentId: string;
  state: string;
}

/**
 * Hub -> Browser: restored session data.
 * Hub uses SerializedSession | null instead of core's `unknown`.
 */
export interface RestoreSessionMessage {
  type: 'restore_session';
  session: SerializedSession | null;
}

/** Browser -> Hub: proxy an API request through hub's shared keys */
export type ApiProxyRequestMessage = Extract<ShellToHub, { type: 'api_proxy_request' }>;

/**
 * Hub -> Browser: agent loop event (from agentic loop execution).
 * Carries core AgentEvent (text_delta, tool_use_done, usage, etc.)
 */
export interface AgentLoopEventMessage {
  type: 'agent_loop_event';
  agentId: string;
  event: AgentEvent;
}

/** Browser -> Hub: request intervention on a browse session */
export interface BrowseInterveneRequestMessage {
  type: 'browse_intervene_request';
  agentId: string;
  mode: 'visible' | 'private';
}

/** Browser -> Hub: release intervention */
export interface BrowseInterveneReleaseMessage {
  type: 'browse_intervene_release';
  agentId: string;
}
