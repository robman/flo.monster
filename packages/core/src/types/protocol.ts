import type { AgentEvent } from './events.js';
import type { AgentConfig, AgentState, AgentViewState } from './agent.js';
import type { ContentBlock } from './messages.js';
import type { ToolDef } from './tools.js';
import type { SerializedDomState } from '../session/serialization.js';

// ============================================================================
// Browser ↔ Hub WebSocket Protocol
// ============================================================================

// Browser → Hub WebSocket messages
export type ShellToHub =
  | { type: 'auth'; token: string }
  | { type: 'tool_request'; id: string; name: string; input: unknown }
  | { type: 'fetch_request'; id: string; url: string; options?: RequestInit }
  | { type: 'api_proxy_request'; id: string; provider: string; path: string; payload: unknown }
  | { type: 'transfer_key'; hash: string; provider: string; encryptedKey: string }
  | { type: 'persist_agent'; session: unknown; keyHashes: string[]; apiKey?: string; apiKeyProvider?: string }
  | { type: 'subscribe_agent'; agentId: string }
  | { type: 'unsubscribe_agent'; agentId: string }
  | { type: 'send_message'; agentId: string; content: string }
  | { type: 'agent_action'; agentId: string; action: 'pause' | 'resume' | 'stop' | 'kill' | 'remove' }
  | { type: 'restore_agent'; agentId: string }
  | { type: 'list_hub_agents' }
  | { type: 'skill_approval_response'; id: string; approved: boolean }
  | { type: 'browser_tool_result'; id: string; result: { content: string; is_error?: boolean } }
  | { type: 'dom_state_update'; hubAgentId: string; domState: SerializedDomState }
  | { type: 'state_write_through'; hubAgentId: string; key: string; value: unknown; action: 'set' | 'delete' }
  | { type: 'file_write_through'; hubAgentId: string; path: string; content?: string; action: 'write' | 'delete' }
  | { type: 'push_subscribe'; deviceId: string; subscription: { endpoint: string; keys: { p256dh: string; auth: string } } }
  | { type: 'push_verify_pin'; deviceId: string; pin: string }
  | { type: 'push_unsubscribe'; deviceId: string }
  | { type: 'visibility_state'; visible: boolean; deviceId: string };

// Hub → Browser WebSocket messages
export type HubToShell =
  | { type: 'auth_result'; success: boolean; hubId: string; hubName: string; sharedProviders?: string[]; httpApiUrl?: string; error?: string }
  | { type: 'announce_tools'; tools: ToolDef[] }
  | { type: 'tool_result'; id: string; result: { content: string; is_error?: boolean } }
  | { type: 'fetch_result'; id: string; status: number; body: string; error?: string }
  | { type: 'api_stream_chunk'; id: string; chunk: string }
  | { type: 'api_stream_end'; id: string }
  | { type: 'api_error'; id: string; error: string }
  | { type: 'persist_result'; hubAgentId: string; success: boolean; error?: string }
  | { type: 'agent_event'; agentId: string; event: AgentEvent }
  | { type: 'agent_loop_event'; agentId: string; event: AgentEvent }
  | { type: 'conversation_history'; agentId: string; messages: Array<{ role: string; content: unknown }> }
  | { type: 'agent_state'; agentId: string; state: AgentState }
  | { type: 'restore_session'; session: unknown }
  | { type: 'hub_agents_list'; agents: HubAgentSummary[] }
  | { type: 'skill_approval_request'; id: string; skill: { name: string; description: string; content: string } }
  | { type: 'browser_tool_request'; id: string; hubAgentId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'restore_dom_state'; hubAgentId: string; domState: SerializedDomState }
  | { type: 'context_change'; hubAgentId: string; change: 'browser_connected' | 'browser_disconnected'; availableTools: string[] }
  | { type: 'state_push'; hubAgentId: string; key: string; value: unknown; action: 'set' | 'delete' }
  | { type: 'file_push'; hubAgentId: string; path: string; content?: string; action: 'write' | 'delete' }
  | { type: 'push_subscribe_result'; deviceId: string; success: boolean; error?: string }
  | { type: 'push_verify_result'; deviceId: string; verified: boolean }
  | { type: 'vapid_public_key'; key: string };

export interface HubAgentSummary {
  hubAgentId: string;
  agentName: string;
  model: string;
  provider: string;
  state: string;
  totalCost: number;
  createdAt: number;
  lastActivity: number;
}

// ============================================================================
// Worker ↔ Iframe Protocol
// ============================================================================

// Worker → Iframe messages
export type WorkerToIframe =
  | { type: 'api_request'; id: string; payload: unknown }
  | { type: 'dom_command'; id: string; command: DomCommand }
  | { type: 'runjs_iframe'; id: string; code: string }
  | { type: 'tool_execute'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'event'; event: AgentEvent }
  | { type: 'ready' }
  // DOM event system
  | { type: 'dom_listen'; id: string; selector: string; events: string[]; options?: DomListenOptions }
  | { type: 'dom_unlisten'; id: string; selector: string }
  | { type: 'dom_wait'; id: string; selector: string; event: string; timeout?: number }
  | { type: 'dom_get_listeners'; id: string }
  // Agent response for flo.ask()
  | { type: 'agent_ask_response'; id: string; result?: unknown; error?: string }
  // Inter-worker messaging
  | { type: 'worker_message'; target: string; event: string; data: unknown }
  | { type: 'capabilities_request'; id: string; action: 'snapshot' | 'probe'; probe?: string; probeArgs?: Record<string, unknown> }
  | { type: 'state_request'; id: string; action: string; key?: string; value?: unknown; condition?: string; message?: string };

// Iframe → Worker messages
export type IframeToWorker =
  | { type: 'start'; config: AgentConfig; userMessage: string }
  | { type: 'user_message'; content: string }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'api_response_chunk'; id: string; chunk: string }
  | { type: 'api_response_end'; id: string }
  | { type: 'api_response_error'; id: string; error: string }
  | { type: 'dom_result'; id: string; result?: unknown; error?: string }
  | { type: 'runjs_result'; id: string; result?: unknown; error?: string }
  | { type: 'storage_result'; id: string; result?: unknown; error?: string }
  | { type: 'file_result'; id: string; result?: string | null; error?: string }
  | { type: 'fetch_response'; id: string; status?: number; headers?: Record<string, string>; body?: string }
  | { type: 'fetch_error'; id: string; error: string }
  | { type: 'tool_execute_result'; id: string; result?: unknown; error?: string }
  // DOM event system
  | { type: 'dom_event'; event: DomEventData }
  | { type: 'dom_wait_result'; id: string; event?: DomEventData; error?: string }
  | { type: 'dom_listen_result'; id: string; success: boolean; error?: string }
  | { type: 'dom_listeners_result'; id: string; listeners: DomListenerInfo[] }
  // JS → Agent calls (flo API)
  | { type: 'agent_notify'; event: string; data: unknown }
  | { type: 'agent_ask'; id: string; event: string; data: unknown }
  // Inter-worker messaging
  | { type: 'worker_event'; from: string; event: string; data: unknown }
  | { type: 'capabilities_result'; id: string; result?: unknown; error?: string }
  | { type: 'viewport_update'; viewport: { width: number; height: number; orientation: string; viewState: string } }
  | { type: 'state_result'; id: string; result?: unknown; error?: string };

// Iframe → Shell messages
export type IframeToShell =
  | { type: 'api_request'; id: string; agentId: string; payload: unknown; browserId?: string }
  | { type: 'storage_request'; id: string; agentId: string; action: string; key?: string; value?: unknown }
  | { type: 'file_request'; id: string; agentId: string; action: string; path: string; content?: string }
  | { type: 'fetch_request'; id: string; agentId: string; url: string; options?: RequestInit }
  | { type: 'tool_execute'; id: string; agentId: string; name: string; input: Record<string, unknown> }
  | { type: 'event'; agentId: string; event: AgentEvent }
  | { type: 'ready'; agentId: string }
  | { type: 'request_view_state'; agentId: string; state: AgentViewState }
  | { type: 'runjs_iframe'; agentId: string; id: string; code: string }
  | { type: 'dom_command'; agentId: string; id: string; command: unknown }
  | { type: 'pre_tool_use'; agentId: string; id: string; toolName: string; toolInput: Record<string, unknown> }
  | { type: 'post_tool_use'; agentId: string; id: string; toolName: string; toolInput: Record<string, unknown>; toolResult: { content: string; is_error?: boolean } }
  | { type: 'agent_stop'; agentId: string; id: string; stopReason: string }
  | { type: 'user_prompt_submit'; agentId: string; id: string; prompt: string }
  | { type: 'agent_start'; agentId: string; id: string }
  | { type: 'agent_end'; agentId: string; id: string }
  | { type: 'shell_tool_response'; id: string; agentId: string; result?: string; error?: string }
  | { type: 'shell_script_response'; id: string; agentId: string; result?: unknown; error?: string }
  | { type: 'dom_state_captured'; id: string; agentId: string; state: SerializedDomState }
  | { type: 'runtime_error'; agentId: string; error: { message: string; source?: string; line?: number; column?: number; stack?: string | null; suppressedCount?: number } }
  | { type: 'dom_mutated'; agentId: string }
  | { type: 'srcdoc_tool_call'; id: string; agentId: string; name: string; input: Record<string, unknown> }
  | { type: 'permission_request'; id: string; agentId: string; permission: 'camera' | 'microphone' | 'geolocation' }
  | { type: 'media_request'; id: string; agentId: string; constraints: { video?: boolean; audio?: boolean } }
  | { type: 'media_answer'; id: string; agentId: string; answer: { type: string; sdp: string } }
  | { type: 'media_ice'; id: string; agentId: string; candidate: string }
  | { type: 'capabilities_request'; id: string; agentId: string; iframeData: Record<string, unknown> }
  | { type: 'media_stop'; id: string; agentId: string }
  | { type: 'speech_listen_start'; id: string; agentId: string; lang?: string }
  | { type: 'speech_listen_done'; id: string; agentId: string }
  | { type: 'speech_listen_cancel'; id: string; agentId: string }
  | { type: 'speech_speak'; id: string; agentId: string; text: string; voice?: string; lang?: string }
  | { type: 'speech_voices'; id: string; agentId: string }
  | { type: 'geolocation_get'; id: string; agentId: string; enableHighAccuracy?: boolean; timeout?: number; maximumAge?: number }
  | { type: 'geolocation_watch_start'; id: string; agentId: string; enableHighAccuracy?: boolean; timeout?: number; maximumAge?: number }
  | { type: 'geolocation_watch_stop'; id: string; agentId: string };

// Shell → Iframe messages
export type ShellToIframe =
  | { type: 'api_response_chunk'; id: string; chunk: string }
  | { type: 'api_response_end'; id: string }
  | { type: 'api_response_error'; id: string; error: string }
  | { type: 'storage_result'; id: string; result: unknown; error?: string }
  | { type: 'file_result'; id: string; result: string | null; error?: string }
  | { type: 'fetch_response'; id: string; status: number; headers: Record<string, string>; body: string }
  | { type: 'fetch_error'; id: string; error: string }
  | { type: 'tool_execute_result'; id: string; result?: string; error?: string }
  | { type: 'init'; agentId: string; workerCode: string; config: AgentConfig }
  | { type: 'user_message'; content: string }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'set_view_state'; state: AgentViewState }
  | { type: 'pre_tool_use_result'; id: string; decision: string; reason?: string; modifiedInput?: Record<string, unknown> }
  | { type: 'post_tool_use_result'; id: string; decision: string; reason?: string }
  | { type: 'agent_stop_result'; id: string; decision: string; reason?: string }
  | { type: 'user_prompt_submit_result'; id: string; decision: string; reason?: string; modifiedPrompt?: string }
  | { type: 'agent_start_result'; id: string; decision: string; reason?: string }
  | { type: 'agent_end_result'; id: string; decision: string; reason?: string }
  | { type: 'hooks_config'; activeHookTypes: string[] }
  | { type: 'stop_agent' }
  | { type: 'config_update'; config: Partial<AgentConfig> }
  | { type: 'shell_tool_request'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'shell_script_request'; id: string; code: string; context: Record<string, unknown> }
  | { type: 'capture_dom_state'; id: string }
  | { type: 'srcdoc_tool_call_result'; id: string; result?: string; error?: string }
  | { type: 'permission_result'; id: string; granted: boolean; error?: string }
  | { type: 'media_offer'; id: string; offer: { type: string; sdp: string }; expectedTracks: number }
  | { type: 'media_ice'; id: string; candidate: string }
  | { type: 'media_error'; id: string; error: string }
  | { type: 'capabilities_result'; id: string; result?: unknown; error?: string }
  | { type: 'speech_interim'; id: string; text: string }
  | { type: 'speech_result'; id: string; text: string; confidence: number }
  | { type: 'speech_cancelled'; id: string }
  | { type: 'speech_error'; id: string; error: string }
  | { type: 'speech_speak_done'; id: string }
  | { type: 'speech_voices_result'; id: string; voices: Array<{ name: string; lang: string; local: boolean }> };

// Shell → Service Worker messages
export type ShellToServiceWorker =
  | { type: 'configure'; apiKey: string }
  | { type: 'update_key'; apiKey: string }
  | { type: 'configure_hub'; enabled: boolean; httpUrl?: string; token?: string };

// DOM command types
export interface DomCommand {
  action: 'create' | 'modify' | 'query' | 'remove' | 'listen' | 'unlisten' | 'wait_for' | 'get_listeners';
  html?: string;
  selector?: string;
  attributes?: Record<string, string>;
  textContent?: string;
  parentSelector?: string;
  // Event listener options
  events?: string[];
  event?: string;
  timeout?: number;
  options?: DomListenOptions;
}

// DOM listen options
export interface DomListenOptions {
  debounce?: number;
}

// DOM event data (sent from iframe to worker when events fire)
export interface DomEventData {
  type: string;           // 'click', 'submit', 'input', etc.
  selector: string;       // The selector that matched
  timestamp: number;
  target: {
    tagName: string;
    id: string;
    className: string;
    value?: string;
    textContent?: string;
    dataset: Record<string, string>;
  };
  formData?: Record<string, string>;
}

// Event listener registration info
export interface DomListenerInfo {
  selector: string;
  events: string[];
  workerId: string;
  options?: DomListenOptions;
}

// ============================================================================
// Admin ↔ Hub WebSocket Protocol
// ============================================================================

// Admin → Hub WebSocket messages
export type AdminToHub =
  | { type: 'admin_auth'; token: string }
  | { type: 'list_agents' }
  | { type: 'inspect_agent'; agentId: string }
  | { type: 'pause_agent'; agentId: string }
  | { type: 'stop_agent'; agentId: string }
  | { type: 'kill_agent'; agentId: string }
  | { type: 'remove_agent'; agentId: string }
  | { type: 'list_connections' }
  | { type: 'disconnect'; connectionId: string }
  | { type: 'get_config' }
  | { type: 'reload_config' }
  | { type: 'subscribe_logs'; follow?: boolean }
  | { type: 'unsubscribe_logs' }
  | { type: 'get_stats' }
  | { type: 'get_usage'; scope?: 'agent' | 'connection' | 'provider' | 'global' }
  | { type: 'rotate_token' }
  | { type: 'show_token' }
  | { type: 'nuke'; target: 'agents' | 'clients' | 'all' }
  | { type: 'get_agent_schedules'; agentId?: string }
  | { type: 'get_agent_log'; agentId: string; limit?: number }
  | { type: 'get_agent_dom'; agentId: string };

// Hub → Admin WebSocket messages
export type HubToAdmin =
  | { type: 'auth_result'; success: boolean; error?: string }
  | { type: 'agents_list'; agents: AdminAgentInfo[] }
  | { type: 'agent_info'; agent: AdminAgentInfo | null }
  | { type: 'connections_list'; connections: AdminConnectionInfo[] }
  | { type: 'config'; config: Record<string, unknown> }
  | { type: 'config_reloaded'; success: boolean; error?: string }
  | { type: 'log_entry'; timestamp: number; level: string; message: string; source?: string }
  | { type: 'stats'; uptime: number; connections: number; agents: number; totalRequests: number }
  | { type: 'usage'; data: AdminUsageData }
  | { type: 'token'; token: string }
  | { type: 'token_rotated'; newToken: string }
  | { type: 'error'; message: string; code?: string }
  | { type: 'ok'; message?: string }
  | { type: 'agent_schedules'; schedules: AdminScheduleInfo[] }
  | { type: 'agent_log'; agentId: string; messages: Array<{ role: string; content: ContentBlock[]; timestamp: number }> }
  | { type: 'agent_dom'; agentId: string; domState: SerializedDomState | null };

// Supporting types for admin protocol
export interface AdminAgentInfo {
  id: string;
  name: string;
  state: 'pending' | 'running' | 'paused' | 'stopped';
  createdAt: number;
  totalTokens: number;
  totalCost: number;
  messageCount: number;
  model?: string;
  provider?: string;
  busy?: boolean;
  lastActivity?: number;
}

export interface AdminScheduleInfo {
  id: string;
  hubAgentId: string;
  type: 'cron' | 'event';
  cronExpression?: string;
  eventName?: string;
  eventCondition?: string;
  message: string;
  enabled: boolean;
  runCount: number;
  lastRunAt?: number;
  createdAt: number;
  maxRuns?: number;
}

export interface AdminConnectionInfo {
  id: string;
  remoteAddress: string;
  authenticated: boolean;
  connectedAt: number;
  subscribedAgents: string[];
}

export interface AdminUsageData {
  scope: 'agent' | 'connection' | 'provider' | 'global';
  entries: AdminUsageEntry[];
}

export interface AdminUsageEntry {
  id: string;
  name?: string;
  tokens: number;
  cost: number;
  requests: number;
}
