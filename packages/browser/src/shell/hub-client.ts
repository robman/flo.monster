import type { ToolDef, ShellToHub, HubToShell, SerializedDomState } from '@flo-monster/core';
import { createCallbackList } from '../utils/event-emitter.js';

export interface HubConnection {
  id: string;              // Hash of URL + token
  name: string;            // User-provided name
  url: string;
  connected: boolean;
  tools: ToolDef[];
  sharedProviders?: string[];  // Provider names with shared API keys
  httpApiUrl?: string;         // URL for HTTP API requests
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface ConnectionState {
  ws: WebSocket;
  conn: HubConnection;
  token?: string;
}

/**
 * Check if a hostname is localhost or a private/link-local IP address.
 * Used to allow ws:// connections to local network hosts while requiring
 * wss:// for public internet connections.
 */
export function isLocalOrPrivateIP(hostname: string): boolean {
  // Strip IPv6 brackets
  const h = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;

  // Named localhost
  if (h === 'localhost') return true;

  // Try to parse as IPv4 (dotted decimal)
  const ipv4Parts = h.split('.');
  if (ipv4Parts.length === 4 && ipv4Parts.every(p => /^\d{1,3}$/.test(p))) {
    const octets = ipv4Parts.map(Number);
    if (octets.some(o => o > 255)) return false;

    // 127.0.0.0/8 — loopback
    if (octets[0] === 127) return true;
    // 10.0.0.0/8
    if (octets[0] === 10) return true;
    // 172.16.0.0/12 — 172.16.x.x through 172.31.x.x
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
    // 192.168.0.0/16
    if (octets[0] === 192 && octets[1] === 168) return true;
    // 169.254.0.0/16 — link-local
    if (octets[0] === 169 && octets[1] === 254) return true;

    return false;
  }

  // IPv6 checks
  if (h.includes(':')) {
    // ::1 loopback
    if (h === '::1') return true;

    const lower = h.toLowerCase();
    // fc00::/7 — ULA (starts with fc or fd)
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    // fe80::/10 — link-local
    if (lower.startsWith('fe80:') || lower.startsWith('fe80')) return true;

    return false;
  }

  // Not an IP address (public hostname)
  return false;
}

export class HubClient {
  private connections = new Map<string, ConnectionState>();
  private pendingRequests = new Map<string, PendingRequest>();
  private pendingStreamRequests = new Map<string, {
    onChunk: (chunk: string) => void;
    onEnd: () => void;
    onError: (error: string) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private connectCallbacks = createCallbackList<HubConnection>();
  private disconnectCallbacks = createCallbackList<string>();
  private toolsCallbacks = createCallbackList<{ id: string; tools: ToolDef[] }>();
  private approvalCallbacks: ((skill: { name: string; description: string; content: string }) => Promise<boolean>)[] = [];
  private browserToolCallbacks: ((hubAgentId: string, toolName: string, input: Record<string, unknown>) => Promise<{ content: string; is_error?: boolean }>)[] = [];
  private domStateCallbacks: ((hubAgentId: string, domState: unknown) => void)[] = [];
  private contextChangeCallbacks: ((hubAgentId: string, change: string, availableTools: string[]) => void)[] = [];
  private statePushCallbacks: ((hubAgentId: string, key: string, value: unknown, action: 'set' | 'delete') => void)[] = [];
  private filePushCallbacks: ((hubAgentId: string, path: string, content: string | undefined, action: 'write' | 'delete') => void)[] = [];
  private agentLoopEventCallbacks: ((agentId: string, event: any) => void)[] = [];
  private agentEventCallbacks: ((agentId: string, event: any) => void)[] = [];
  private conversationHistoryCallbacks: ((agentId: string, messages: any[]) => void)[] = [];
  private pushEventCallbacks: ((msg: any) => void)[] = [];
  private browseStreamCallbacks: ((agentId: string, data: { token: string; streamPort: number; viewport: { width: number; height: number }; streamUrl?: string }) => void)[] = [];
  private browseStreamStoppedCallbacks: ((agentId: string) => void)[] = [];
  private browseStreamErrorCallbacks: ((agentId: string, error: string) => void)[] = [];
  private interveneGrantedCallbacks: ((agentId: string, mode: 'visible' | 'private') => void)[] = [];
  private interveneDeniedCallbacks: ((agentId: string, reason: string) => void)[] = [];
  private interveneEndedCallbacks: ((agentId: string, reason: string, notification?: string) => void)[] = [];
  private vapidKeys = new Map<string, string>(); // connectionId → VAPID public key
  private nextReqId = 0;

  // Reconnection state
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private reconnectAttempts = new Map<string, number>();
  private reconnectingIds = new Set<string>();
  private connectionParams = new Map<string, { url: string; name: string; token?: string }>();
  private intentionalDisconnects = new Set<string>();
  private suspendedIds = new Set<string>();

  // Pending persist/restore promises
  private pendingPersist?: {
    resolve: (result: { hubAgentId: string; success: boolean; error?: string }) => void;
    reject: (error: Error) => void;
  };
  private pendingRestore?: {
    resolve: (session: unknown) => void;
    reject: (error: Error) => void;
  };
  private _pendingListAgents?: {
    resolve: (agents: unknown[]) => void;
    reject: (error: Error) => void;
  };

  /**
   * Connect to a hub server
   */
  async connect(url: string, name: string, token?: string): Promise<HubConnection> {
    // Enforce wss:// for non-localhost/non-private connections
    const parsed = new URL(url);
    const isLocal = isLocalOrPrivateIP(parsed.hostname);
    if (!isLocal && parsed.protocol === 'ws:') {
      throw new Error('Non-localhost hub connections require wss:// (secure WebSocket). Use wss:// or connect to localhost/private IP.');
    }

    const id = await this.generateConnectionId(url, token);

    // Store connection params for potential reconnection
    this.connectionParams.set(id, { url, name, token });

    // Check if already connected
    if (this.connections.has(id)) {
      const existing = this.connections.get(id)!;
      if (existing.conn.connected) {
        return existing.conn;
      }
      // Reconnect if disconnected
      this.connections.delete(id);
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);

      const conn: HubConnection = {
        id,
        name,
        url,
        connected: false,
        tools: [],
      };

      const state: ConnectionState = { ws, conn, token };
      this.connections.set(id, state);

      const timeout = setTimeout(() => {
        ws.close();
        this.connections.delete(id);
        if (!this.reconnectingIds.has(id)) {
          this.connectionParams.delete(id);
        }
        reject(new Error('Connection timeout'));
      }, 10000);

      ws.onopen = () => {
        // Always send auth message - server will validate or bypass based on config
        this.send(ws, { type: 'auth', token: token || '' });
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as HubToShell;
          this.handleMessage(id, msg, { resolve, reject, timeout });
        } catch (err) {
          console.error('[hub-client] Failed to parse message:', err);
        }
      };

      ws.onclose = () => {
        clearTimeout(timeout);
        const wasConnected = conn.connected;
        conn.connected = false;
        this.connections.delete(id);

        if (wasConnected) {
          this.disconnectCallbacks.invoke(id);

          // Clean up pending stream requests for this connection
          for (const [reqId, stream] of this.pendingStreamRequests) {
            clearTimeout(stream.timeout);
            this.pendingStreamRequests.delete(reqId);
            stream.onError('Hub disconnected');
          }

          // Schedule reconnection if not intentional
          if (!this.intentionalDisconnects.has(id) && !this.reconnectingIds.has(id)) {
            this.scheduleReconnect(id);
          }
        }

        // Clean up intentional flag
        this.intentionalDisconnects.delete(id);
      };

      ws.onerror = (err) => {
        clearTimeout(timeout);
        this.connections.delete(id);
        if (!this.reconnectingIds.has(id)) {
          this.connectionParams.delete(id);
        }
        reject(new Error('WebSocket error: ' + String(err)));
      };
    });
  }

  /**
   * Disconnect from a hub server
   */
  disconnect(id: string): void {
    this.intentionalDisconnects.add(id);
    this.cancelReconnect(id);
    this.connectionParams.delete(id);
    const state = this.connections.get(id);
    if (state) {
      state.ws.close();
      this.connections.delete(id);
    }
  }

  /**
   * Schedule a reconnection attempt with exponential backoff
   */
  private scheduleReconnect(id: string): void {
    const attempts = this.reconnectAttempts.get(id) || 0;
    const delay = Math.min(1000 * Math.pow(2, attempts), 30000); // 1s, 2s, 4s, 8s, 16s, 30s cap

    this.reconnectingIds.add(id);

    const timer = setTimeout(() => {
      this.attemptReconnect(id);
    }, delay);

    this.reconnectTimers.set(id, timer);
    this.reconnectAttempts.set(id, attempts + 1);
  }

  /**
   * Attempt to reconnect to a previously-connected hub
   */
  private async attemptReconnect(id: string): Promise<void> {
    const params = this.connectionParams.get(id);
    if (!params) {
      this.cleanupReconnectState(id);
      return;
    }

    try {
      await this.connect(params.url, params.name, params.token);
      // Success — clean up reconnect state
      this.cleanupReconnectState(id);
    } catch {
      // Failed — reschedule if still reconnecting
      if (this.reconnectingIds.has(id)) {
        this.reconnectTimers.delete(id);
        this.scheduleReconnect(id);
      }
    }
  }

  /**
   * Cancel any pending reconnection for a connection
   */
  private cancelReconnect(id: string): void {
    const timer = this.reconnectTimers.get(id);
    if (timer) {
      clearTimeout(timer);
    }
    this.cleanupReconnectState(id);
  }

  private cleanupReconnectState(id: string): void {
    this.reconnectTimers.delete(id);
    this.reconnectAttempts.delete(id);
    this.reconnectingIds.delete(id);
  }

  /**
   * Check if a connection is currently reconnecting
   */
  isReconnecting(id: string): boolean {
    return this.reconnectingIds.has(id);
  }

  /**
   * Stop all pending reconnections (for page unload)
   */
  stopAllReconnections(): void {
    for (const [id, timer] of this.reconnectTimers) {
      clearTimeout(timer);
    }
    // Clean up all reconnect state
    for (const id of [...this.reconnectingIds]) {
      this.cleanupReconnectState(id);
    }
  }

  /**
   * Suspend all connections for BFCache eligibility.
   * Closes WebSockets without firing disconnect callbacks or triggering reconnection.
   * Connection params are preserved so resume() can reconnect.
   */
  suspend(): void {
    for (const [id, state] of this.connections) {
      this.suspendedIds.add(id);
      this.intentionalDisconnects.add(id);
      this.cancelReconnect(id);
      state.ws.close();
    }
  }

  /**
   * Resume suspended connections after returning from BFCache.
   * Reconnects all previously suspended connections using stored params.
   */
  async resume(): Promise<void> {
    const idsToResume = [...this.suspendedIds];
    this.suspendedIds.clear();

    for (const id of idsToResume) {
      // Safety: if a WebSocket still appears connected (iOS may not fire onclose),
      // force-close it before reconnecting
      const existing = this.connections.get(id);
      if (existing) {
        this.intentionalDisconnects.add(id);
        existing.ws.close();
        this.connections.delete(id);
      }

      const params = this.connectionParams.get(id);
      if (params) {
        try {
          await this.connect(params.url, params.name, params.token);
        } catch (err) {
          console.warn(`[hub-client] Failed to resume connection ${id}:`, err);
          // Schedule normal reconnection for this connection
          this.scheduleReconnect(id);
        }
      }
    }
  }

  /**
   * Check if any connections are currently suspended
   */
  isSuspended(): boolean {
    return this.suspendedIds.size > 0;
  }

  /**
   * Get all active connections
   */
  getConnections(): HubConnection[] {
    return Array.from(this.connections.values()).map(s => s.conn);
  }

  /**
   * Get a specific connection by ID
   */
  getConnection(id: string): HubConnection | undefined {
    return this.connections.get(id)?.conn;
  }

  /**
   * Execute a tool on a hub
   */
  async executeTool(
    connectionId: string,
    name: string,
    input: unknown,
    agentId?: string,
  ): Promise<{ result: string; is_error?: boolean }> {
    const state = this.connections.get(connectionId);
    if (!state || !state.conn.connected) {
      throw new Error('Hub not connected: ' + connectionId);
    }

    const id = this.nextRequestId();

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: (result) => resolve(result as { result: string; is_error?: boolean }),
        reject,
      });

      this.send(state.ws, { type: 'tool_request', id, name, input, agentId });

      // Timeout after 5 minutes
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('Tool execution timeout'));
        }
      }, 300000);
    });
  }

  /**
   * Proxy a fetch request through the hub
   */
  async fetch(
    connectionId: string,
    url: string,
    options?: RequestInit,
  ): Promise<{ status: number; body: string; error?: string }> {
    const state = this.connections.get(connectionId);
    if (!state || !state.conn.connected) {
      throw new Error('Hub not connected: ' + connectionId);
    }

    const id = this.nextRequestId();

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: (result) => resolve(result as { status: number; body: string; error?: string }),
        reject,
      });

      // Serialize RequestInit for JSON transport
      const serializedOptions = options ? {
        method: options.method,
        headers: options.headers instanceof Headers
          ? Object.fromEntries(options.headers.entries())
          : options.headers,
        body: options.body,
      } : undefined;

      this.send(state.ws, { type: 'fetch_request', id, url, options: serializedOptions as RequestInit | undefined });

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('Fetch timeout'));
        }
      }, 30000);
    });
  }

  /**
   * Stream an API request through the hub's WebSocket connection.
   * Used for Mode 3 (hub shared keys, browser loop) to bypass PNA restrictions.
   * Returns a cancel function.
   */
  streamApiProxy(
    connectionId: string,
    provider: string,
    path: string,
    payload: unknown,
    callbacks: {
      onChunk: (chunk: string) => void;
      onEnd: () => void;
      onError: (error: string) => void;
    },
  ): () => void {
    const state = this.connections.get(connectionId);
    if (!state || !state.conn.connected) {
      callbacks.onError('Hub not connected: ' + connectionId);
      return () => {};
    }

    const id = this.nextRequestId();

    // Timeout after 5 minutes (same as tool execution)
    const timeout = setTimeout(() => {
      if (this.pendingStreamRequests.has(id)) {
        this.pendingStreamRequests.delete(id);
        callbacks.onError('API proxy request timeout');
      }
    }, 300000);

    this.pendingStreamRequests.set(id, { ...callbacks, timeout });

    this.send(state.ws, { type: 'api_proxy_request', id, provider, path, payload });

    // Return cancel function
    return () => {
      clearTimeout(timeout);
      this.pendingStreamRequests.delete(id);
    };
  }

  /**
   * Register a callback for new connections
   */
  onConnect(cb: (conn: HubConnection) => void): () => void {
    return this.connectCallbacks.add(cb);
  }

  /**
   * Register a callback for disconnections
   */
  onDisconnect(cb: (id: string) => void): () => void {
    return this.disconnectCallbacks.add(cb);
  }

  /**
   * Register a callback for tools announcements
   */
  onToolsAnnounced(cb: (id: string, tools: ToolDef[]) => void): () => void {
    // Wrap the two-arg callback to fit the single-arg createCallbackList
    return this.toolsCallbacks.add(({ id, tools }) => cb(id, tools));
  }

  /**
   * Register a callback for skill approval requests from the hub
   */
  onSkillApprovalRequest(cb: (skill: { name: string; description: string; content: string }) => Promise<boolean>): () => void {
    this.approvalCallbacks.push(cb);
    return () => {
      const idx = this.approvalCallbacks.indexOf(cb);
      if (idx >= 0) this.approvalCallbacks.splice(idx, 1);
    };
  }

  /**
   * Register a handler for browser tool requests from the hub.
   * When the hub needs to execute a browser-only tool, it sends
   * a browser_tool_request. The handler executes the tool locally
   * and the result is sent back to the hub.
   */
  onBrowserToolRequest(
    handler: (hubAgentId: string, toolName: string, input: Record<string, unknown>) => Promise<{ content: string; is_error?: boolean }>
  ): () => void {
    this.browserToolCallbacks.push(handler);
    return () => {
      const idx = this.browserToolCallbacks.indexOf(handler);
      if (idx >= 0) this.browserToolCallbacks.splice(idx, 1);
    };
  }

  /**
   * Register a handler for DOM state restoration from the hub.
   * When a browser subscribes to a hub agent that has DOM state,
   * the hub sends restore_dom_state with the last known DOM.
   */
  onDomStateRestore(
    handler: (hubAgentId: string, domState: unknown) => void
  ): () => void {
    this.domStateCallbacks.push(handler);
    return () => {
      const idx = this.domStateCallbacks.indexOf(handler);
      if (idx >= 0) this.domStateCallbacks.splice(idx, 1);
    };
  }

  /**
   * Register a handler for context change notifications.
   * Fires when a browser connects/disconnects from a hub agent,
   * changing the available tools.
   */
  onContextChange(
    handler: (hubAgentId: string, change: string, availableTools: string[]) => void
  ): () => void {
    this.contextChangeCallbacks.push(handler);
    return () => {
      const idx = this.contextChangeCallbacks.indexOf(handler);
      if (idx >= 0) this.contextChangeCallbacks.splice(idx, 1);
    };
  }

  /**
   * Register a handler for state push notifications from the hub.
   * Fires when the hub-side state store changes (e.g., agent sets state without browser).
   */
  onStatePush(
    handler: (hubAgentId: string, key: string, value: unknown, action: 'set' | 'delete') => void
  ): () => void {
    this.statePushCallbacks.push(handler);
    return () => {
      const idx = this.statePushCallbacks.indexOf(handler);
      if (idx >= 0) this.statePushCallbacks.splice(idx, 1);
    };
  }

  /**
   * Send a state write-through to the hub (browser → hub state sync)
   */
  sendStateWriteThrough(connectionId: string, hubAgentId: string, key: string, value: unknown, action: 'set' | 'delete'): void {
    const state = this.connections.get(connectionId);
    if (state?.conn.connected) {
      this.send(state.ws, {
        type: 'state_write_through',
        hubAgentId,
        key,
        value,
        action,
      } as any);
    }
  }

  /**
   * Register a handler for file push notifications from the hub.
   */
  onFilePush(
    handler: (hubAgentId: string, path: string, content: string | undefined, action: 'write' | 'delete') => void
  ): () => void {
    this.filePushCallbacks.push(handler);
    return () => {
      const idx = this.filePushCallbacks.indexOf(handler);
      if (idx >= 0) this.filePushCallbacks.splice(idx, 1);
    };
  }

  /**
   * Send a file write-through to the hub (browser → hub file sync)
   */
  sendFileWriteThrough(connectionId: string, hubAgentId: string, path: string, content: string | undefined, action: 'write' | 'delete'): void {
    const state = this.connections.get(connectionId);
    if (state?.conn.connected) {
      this.send(state.ws, {
        type: 'file_write_through',
        hubAgentId,
        path,
        content,
        action,
      } as any);
    }
  }

  /**
   * Register a handler for agent loop events from the hub.
   * These are agentic loop events (text_delta, tool_use_done, usage, turn_end)
   * streamed from hub-executed agentic loops.
   */
  onAgentLoopEvent(
    handler: (agentId: string, event: any) => void
  ): () => void {
    this.agentLoopEventCallbacks.push(handler);
    return () => {
      const idx = this.agentLoopEventCallbacks.indexOf(handler);
      if (idx >= 0) this.agentLoopEventCallbacks.splice(idx, 1);
    };
  }

  /**
   * Register a handler for agent events (state_change, message, error).
   * These are RunnerEvent-level events from hub agent runners.
   */
  onAgentEvent(
    handler: (agentId: string, event: any) => void
  ): () => void {
    this.agentEventCallbacks.push(handler);
    return () => {
      const idx = this.agentEventCallbacks.indexOf(handler);
      if (idx >= 0) this.agentEventCallbacks.splice(idx, 1);
    };
  }

  /**
   * Register a handler for conversation history from the hub.
   * Sent when subscribing to a hub agent so the browser can render history.
   */
  onConversationHistory(
    handler: (agentId: string, messages: any[]) => void
  ): () => void {
    this.conversationHistoryCallbacks.push(handler);
    return () => {
      const idx = this.conversationHistoryCallbacks.indexOf(handler);
      if (idx >= 0) this.conversationHistoryCallbacks.splice(idx, 1);
    };
  }

  /**
   * Send a DOM state update to the hub for a hub agent
   */
  sendDomStateUpdate(connectionId: string, hubAgentId: string, domState: SerializedDomState): void {
    const state = this.connections.get(connectionId);
    if (state?.conn.connected) {
      this.send(state.ws, {
        type: 'dom_state_update',
        hubAgentId,
        domState,
      });
    }
  }

  /**
   * Get all tools from all connected hubs
   */
  getAllTools(): ToolDef[] {
    const tools: ToolDef[] = [];
    for (const state of this.connections.values()) {
      tools.push(...state.conn.tools);
    }
    return tools;
  }

  /**
   * Find which hub provides a tool
   */
  findToolHub(toolName: string): string | undefined {
    for (const state of this.connections.values()) {
      if (state.conn.tools.some(t => t.name === toolName)) {
        return state.conn.id;
      }
    }
    return undefined;
  }

  /**
   * Get connections that have a shared API key for a provider
   */
  getConnectionsWithSharedProvider(provider: string): HubConnection[] {
    return Array.from(this.connections.values())
      .map(s => s.conn)
      .filter(c => c.connected && c.sharedProviders?.includes(provider));
  }

  /**
   * Persist an agent session to the hub server
   */
  async persistAgent(
    connectionId: string,
    session: unknown,
    keyHashes: string[] = [],
    apiKey?: string,
    apiKeyProvider?: string,
  ): Promise<{ hubAgentId: string; success: boolean; error?: string }> {
    const state = this.connections.get(connectionId);
    if (!state || !state.conn.connected) {
      throw new Error('Hub not connected: ' + connectionId);
    }

    return new Promise((resolve, reject) => {
      this.pendingPersist = { resolve, reject };

      this.send(state.ws, { type: 'persist_agent', session, keyHashes, apiKey, apiKeyProvider });

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingPersist) {
          this.pendingPersist = undefined;
          reject(new Error('Persist timeout'));
        }
      }, 30000);
    });
  }

  /**
   * Restore an agent session from the hub server
   */
  async restoreAgent(
    connectionId: string,
    agentId: string,
  ): Promise<unknown> {
    const state = this.connections.get(connectionId);
    if (!state || !state.conn.connected) {
      throw new Error('Hub not connected: ' + connectionId);
    }

    return new Promise((resolve, reject) => {
      this.pendingRestore = { resolve, reject };

      this.send(state.ws, { type: 'restore_agent', agentId });

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRestore) {
          this.pendingRestore = undefined;
          reject(new Error('Restore timeout'));
        }
      }, 30000);
    });
  }

  /**
   * Send an agent action (pause/resume/stop/kill)
   */
  sendAgentAction(connectionId: string, agentId: string, action: 'pause' | 'resume' | 'stop' | 'kill' | 'remove'): void {
    const state = this.connections.get(connectionId);
    if (state?.conn.connected) {
      this.send(state.ws, { type: 'agent_action', agentId, action });
    }
  }

  /**
   * Send subscribe_agent message
   */
  sendSubscribeAgent(connectionId: string, agentId: string): void {
    const state = this.connections.get(connectionId);
    if (state?.conn.connected) {
      this.send(state.ws, { type: 'subscribe_agent', agentId });
    }
  }

  /**
   * Send unsubscribe_agent message
   */
  sendUnsubscribeAgent(connectionId: string, agentId: string): void {
    const state = this.connections.get(connectionId);
    if (state?.conn.connected) {
      this.send(state.ws, { type: 'unsubscribe_agent', agentId });
    }
  }

  /**
   * Send a user message to a hub agent (triggers agentic loop on hub)
   */
  sendAgentMessage(connectionId: string, agentId: string, content: string): void {
    const state = this.connections.get(connectionId);
    if (state?.conn.connected) {
      this.send(state.ws, { type: 'send_message', agentId, content });
    }
  }

  // --- Push Notification Methods ---

  /**
   * Send a push subscription to the hub for PIN verification.
   */
  sendPushSubscribe(connectionId: string, deviceId: string, subscription: PushSubscriptionJSON): void {
    const state = this.connections.get(connectionId);
    if (state?.conn.connected) {
      this.send(state.ws, {
        type: 'push_subscribe',
        deviceId,
        subscription: {
          endpoint: subscription.endpoint!,
          keys: {
            p256dh: subscription.keys!.p256dh!,
            auth: subscription.keys!.auth!,
          },
        },
      });
    }
  }

  /**
   * Send a PIN verification attempt to the hub.
   */
  sendPushVerifyPin(connectionId: string, deviceId: string, pin: string): void {
    const state = this.connections.get(connectionId);
    if (state?.conn.connected) {
      this.send(state.ws, { type: 'push_verify_pin', deviceId, pin });
    }
  }

  /**
   * Send a push unsubscribe request to the hub.
   */
  sendPushUnsubscribe(connectionId: string, deviceId: string): void {
    const state = this.connections.get(connectionId);
    if (state?.conn.connected) {
      this.send(state.ws, { type: 'push_unsubscribe', deviceId });
    }
  }

  /**
   * Get the cached VAPID public key for a connection.
   * The key is sent by the hub during authentication and cached automatically.
   */
  getVapidKey(connectionId: string): string | null {
    return this.vapidKeys.get(connectionId) ?? null;
  }

  /**
   * Send visibility state to the hub for push notification routing.
   */
  sendVisibilityState(connectionId: string, visible: boolean): void {
    const deviceId = typeof localStorage !== 'undefined'
      ? localStorage.getItem('flo-device-id')
      : null;
    if (!deviceId) return;
    const state = this.connections.get(connectionId);
    if (state?.conn.connected) {
      this.send(state.ws, { type: 'visibility_state', visible, deviceId });
    }
  }

  /**
   * Register a handler for push-related events from the hub
   * (vapid_public_key, push_subscribe_result, push_verify_result).
   */
  onPushEvent(handler: (msg: any) => void): () => void {
    this.pushEventCallbacks.push(handler);
    return () => {
      const idx = this.pushEventCallbacks.indexOf(handler);
      if (idx >= 0) this.pushEventCallbacks.splice(idx, 1);
    };
  }

  /**
   * Request a browse stream token for watching an agent's headless browser.
   * Returns the stream token, port, and viewport dimensions.
   */
  requestBrowseStream(connectionId: string, agentId: string): void {
    const state = this.connections.get(connectionId);
    if (state?.conn.connected) {
      this.send(state.ws, { type: 'browse_stream_request', agentId } as any);
    }
  }

  /**
   * Stop a browse stream for an agent.
   */
  stopBrowseStream(connectionId: string, agentId: string): void {
    const state = this.connections.get(connectionId);
    if (state?.conn.connected) {
      this.send(state.ws, { type: 'browse_stream_stop', agentId } as any);
    }
  }

  /**
   * Request intervention on an agent's browse session.
   */
  requestIntervene(connectionId: string, agentId: string, mode: 'visible' | 'private'): void {
    const state = this.connections.get(connectionId);
    if (state?.conn.connected) {
      this.send(state.ws, { type: 'browse_intervene_request', agentId, mode });
    }
  }

  /**
   * Release intervention on an agent's browse session.
   */
  releaseIntervene(connectionId: string, agentId: string): void {
    const state = this.connections.get(connectionId);
    if (state?.conn.connected) {
      this.send(state.ws, { type: 'browse_intervene_release', agentId });
    }
  }

  /**
   * Register a handler for intervention granted events.
   */
  onInterveneGranted(handler: (agentId: string, mode: 'visible' | 'private') => void): () => void {
    this.interveneGrantedCallbacks.push(handler);
    return () => {
      const idx = this.interveneGrantedCallbacks.indexOf(handler);
      if (idx >= 0) this.interveneGrantedCallbacks.splice(idx, 1);
    };
  }

  /**
   * Register a handler for intervention denied events.
   */
  onInterveneDenied(handler: (agentId: string, reason: string) => void): () => void {
    this.interveneDeniedCallbacks.push(handler);
    return () => {
      const idx = this.interveneDeniedCallbacks.indexOf(handler);
      if (idx >= 0) this.interveneDeniedCallbacks.splice(idx, 1);
    };
  }

  /**
   * Register a handler for intervention ended events.
   * notification is included for browser-routed agents (hub-persisted get it via runner).
   */
  onInterveneEnded(handler: (agentId: string, reason: string, notification?: string) => void): () => void {
    this.interveneEndedCallbacks.push(handler);
    return () => {
      const idx = this.interveneEndedCallbacks.indexOf(handler);
      if (idx >= 0) this.interveneEndedCallbacks.splice(idx, 1);
    };
  }

  /**
   * Register a handler for browse stream token responses.
   */
  onBrowseStreamToken(
    handler: (agentId: string, data: { token: string; streamPort: number; viewport: { width: number; height: number }; streamUrl?: string }) => void
  ): () => void {
    this.browseStreamCallbacks.push(handler);
    return () => {
      const idx = this.browseStreamCallbacks.indexOf(handler);
      if (idx >= 0) this.browseStreamCallbacks.splice(idx, 1);
    };
  }

  /**
   * Register a handler for browse stream stopped notifications.
   */
  onBrowseStreamStopped(handler: (agentId: string) => void): () => void {
    this.browseStreamStoppedCallbacks.push(handler);
    return () => {
      const idx = this.browseStreamStoppedCallbacks.indexOf(handler);
      if (idx >= 0) this.browseStreamStoppedCallbacks.splice(idx, 1);
    };
  }

  /**
   * Register a handler for browse stream error notifications.
   */
  onBrowseStreamError(handler: (agentId: string, error: string) => void): () => void {
    this.browseStreamErrorCallbacks.push(handler);
    return () => {
      const idx = this.browseStreamErrorCallbacks.indexOf(handler);
      if (idx >= 0) this.browseStreamErrorCallbacks.splice(idx, 1);
    };
  }

  /**
   * Request list of all agents on a hub
   */
  async listHubAgents(connectionId: string): Promise<unknown[]> {
    const state = this.connections.get(connectionId);
    if (!state?.conn.connected) {
      throw new Error('Hub not connected: ' + connectionId);
    }

    return new Promise((resolve, reject) => {
      // Store pending list request
      this._pendingListAgents = { resolve, reject };
      this.send(state.ws, { type: 'list_hub_agents' });

      setTimeout(() => {
        if (this._pendingListAgents) {
          this._pendingListAgents = undefined;
          reject(new Error('List agents timeout'));
        }
      }, 10000);
    });
  }

  /**
   * Generate a unique connection ID from URL and token
   */
  private async generateConnectionId(url: string, token?: string): Promise<string> {
    const data = url + (token || '');
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  }

  private nextRequestId(): string {
    return `req-${++this.nextReqId}-${Date.now()}`;
  }

  private send(ws: WebSocket, msg: ShellToHub): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private handleMessage(
    connId: string,
    msg: HubToShell,
    connectPromise?: {
      resolve: (conn: HubConnection) => void;
      reject: (err: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    },
  ): void {
    const state = this.connections.get(connId);
    if (!state) return;

    switch (msg.type) {
      case 'auth_result': {
        if (connectPromise) {
          clearTimeout(connectPromise.timeout);
        }

        if (msg.success) {
          state.conn.connected = true;
          state.conn.sharedProviders = msg.sharedProviders;
          state.conn.httpApiUrl = msg.httpApiUrl;

          // Send initial visibility state so hub knows the device is active.
          // visibilitychange doesn't fire on page load (page starts visible),
          // so without this the hub defaults to documentVisible=false and
          // sends push notifications even when the app is focused.
          this.sendVisibilityState(connId, true);

          this.connectCallbacks.invoke(state.conn);

          if (connectPromise) {
            connectPromise.resolve(state.conn);
          }
        } else {
          this.connections.delete(connId);
          this.connectionParams.delete(connId);
          if (connectPromise) {
            connectPromise.reject(new Error(msg.error || 'Authentication failed'));
          }
        }
        break;
      }

      case 'announce_tools': {
        state.conn.tools = msg.tools;

        this.toolsCallbacks.invoke({ id: connId, tools: msg.tools });
        break;
      }

      case 'tool_result': {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          this.pendingRequests.delete(msg.id);
          // msg.result is a ToolResult object with { content, is_error }
          const toolResult = msg.result as { content: string; is_error?: boolean };
          pending.resolve({ result: toolResult.content, is_error: toolResult.is_error });
        }
        break;
      }

      case 'fetch_result': {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          this.pendingRequests.delete(msg.id);
          pending.resolve({ status: msg.status, body: msg.body, error: msg.error });
        }
        break;
      }

      case 'api_stream_chunk': {
        const stream = this.pendingStreamRequests.get(msg.id);
        if (stream) {
          stream.onChunk(msg.chunk);
        }
        break;
      }

      case 'api_stream_end': {
        const stream = this.pendingStreamRequests.get(msg.id);
        if (stream) {
          clearTimeout(stream.timeout);
          this.pendingStreamRequests.delete(msg.id);
          stream.onEnd();
        }
        break;
      }

      case 'api_error': {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          this.pendingRequests.delete(msg.id);
          pending.reject(new Error(msg.error));
        }
        const pendingStream = this.pendingStreamRequests.get(msg.id);
        if (pendingStream) {
          clearTimeout(pendingStream.timeout);
          this.pendingStreamRequests.delete(msg.id);
          pendingStream.onError(msg.error);
        }
        break;
      }

      case 'skill_approval_request': {
        const { id, skill } = msg as { type: string; id: string; skill: { name: string; description: string; content: string } };

        // Ask first registered callback
        const callback = this.approvalCallbacks[0];
        if (callback) {
          callback(skill).then(approved => {
            this.send(state.ws, { type: 'skill_approval_response', id, approved });
          }).catch(() => {
            this.send(state.ws, { type: 'skill_approval_response', id, approved: false });
          });
        } else {
          // No handler - reject
          this.send(state.ws, { type: 'skill_approval_response', id, approved: false });
        }
        break;
      }

      case 'persist_result': {
        if (this.pendingPersist) {
          const pending = this.pendingPersist;
          this.pendingPersist = undefined;
          pending.resolve({
            hubAgentId: msg.hubAgentId,
            success: msg.success,
            error: msg.error,
          });
        }
        break;
      }

      case 'restore_session': {
        if (this.pendingRestore) {
          const pending = this.pendingRestore;
          this.pendingRestore = undefined;
          pending.resolve(msg.session);
        }
        break;
      }

      case 'hub_agents_list': {
        if (this._pendingListAgents) {
          const pending = this._pendingListAgents;
          this._pendingListAgents = undefined;
          pending.resolve(msg.agents || []);
        }
        break;
      }

      case 'browser_tool_request': {
        this.handleBrowserToolRequest(state, msg.id, msg.hubAgentId, msg.toolName, msg.input);
        break;
      }

      case 'restore_dom_state': {
        for (const cb of this.domStateCallbacks) {
          try { cb(msg.hubAgentId, msg.domState); } catch { /* ignore */ }
        }
        break;
      }

      case 'context_change': {
        for (const cb of this.contextChangeCallbacks) {
          try { cb(msg.hubAgentId, msg.change, msg.availableTools); } catch { /* ignore */ }
        }
        break;
      }

      case 'state_push': {
        const spMsg = msg as { type: string; hubAgentId: string; key: string; value: unknown; action: 'set' | 'delete' };
        for (const cb of this.statePushCallbacks) {
          try { cb(spMsg.hubAgentId, spMsg.key, spMsg.value, spMsg.action); } catch { /* ignore */ }
        }
        break;
      }

      case 'file_push': {
        const fpMsg = msg as { type: string; hubAgentId: string; path: string; content?: string; action: 'write' | 'delete' };
        for (const cb of this.filePushCallbacks) {
          try { cb(fpMsg.hubAgentId, fpMsg.path, fpMsg.content, fpMsg.action); } catch { /* ignore */ }
        }
        break;
      }

      case 'agent_loop_event': {
        const aleMsg = msg as { type: string; agentId: string; event: unknown };
        for (const cb of this.agentLoopEventCallbacks) {
          try { cb(aleMsg.agentId, aleMsg.event); } catch { /* ignore */ }
        }
        break;
      }

      case 'agent_event': {
        const aeMsg = msg as { type: string; agentId: string; event: unknown };
        for (const cb of this.agentEventCallbacks) {
          try { cb(aeMsg.agentId, aeMsg.event); } catch { /* ignore */ }
        }
        break;
      }

      case 'agent_state': {
        // agent_state messages are already partially handled for subscribe flow.
        // Also forward to agentEvent callbacks for unified handling.
        const asMsg = msg as { type: string; agentId: string; state: string };
        for (const cb of this.agentEventCallbacks) {
          try { cb(asMsg.agentId, { type: 'state_change', state: asMsg.state }); } catch { /* ignore */ }
        }
        break;
      }

      case 'conversation_history': {
        const chMsg = msg as { type: string; agentId: string; messages: unknown[] };
        for (const cb of this.conversationHistoryCallbacks) {
          try { cb(chMsg.agentId, chMsg.messages); } catch { /* ignore */ }
        }
        break;
      }

      // Push notification protocol messages
      case 'vapid_public_key': {
        // Cache the VAPID key for this connection
        const vpMsg = msg as { type: string; key: string };
        if (vpMsg.key && connId) {
          this.vapidKeys.set(connId, vpMsg.key);
        }
        for (const cb of this.pushEventCallbacks) {
          try { cb(msg); } catch { /* ignore */ }
        }
        break;
      }
      case 'push_subscribe_result':
      case 'push_verify_result': {
        for (const cb of this.pushEventCallbacks) {
          try { cb(msg); } catch { /* ignore */ }
        }
        break;
      }

      case 'browse_stream_token': {
        const bst = msg as unknown as { type: string; agentId: string; token: string; streamPort: number; viewport: { width: number; height: number }; streamUrl?: string };
        for (const cb of this.browseStreamCallbacks) {
          try { cb(bst.agentId, { token: bst.token, streamPort: bst.streamPort, viewport: bst.viewport, streamUrl: bst.streamUrl }); } catch { /* ignore */ }
        }
        break;
      }

      case 'browse_stream_stopped': {
        const bss = msg as unknown as { type: string; agentId: string };
        for (const cb of this.browseStreamStoppedCallbacks) {
          try { cb(bss.agentId); } catch { /* ignore */ }
        }
        break;
      }

      case 'browse_stream_error': {
        const bse = msg as unknown as { type: string; agentId: string; error: string };
        for (const cb of this.browseStreamErrorCallbacks) {
          try { cb(bse.agentId, bse.error); } catch { /* ignore */ }
        }
        break;
      }

      case 'browse_intervene_granted': {
        const big = msg as unknown as { type: string; agentId: string; mode: 'visible' | 'private' };
        for (const cb of this.interveneGrantedCallbacks) {
          try { cb(big.agentId, big.mode); } catch { /* ignore */ }
        }
        break;
      }

      case 'browse_intervene_denied': {
        const bid = msg as unknown as { type: string; agentId: string; reason: string };
        for (const cb of this.interveneDeniedCallbacks) {
          try { cb(bid.agentId, bid.reason); } catch { /* ignore */ }
        }
        break;
      }

      case 'browse_intervene_ended': {
        const bie = msg as unknown as { type: string; agentId: string; reason: string; notification?: string };
        for (const cb of this.interveneEndedCallbacks) {
          try { cb(bie.agentId, bie.reason, bie.notification); } catch { /* ignore */ }
        }
        break;
      }

      // Handle other message types as needed
      default:
        // Silently ignore unhandled message types for forward compatibility
        break;
    }
  }

  private handleBrowserToolRequest(
    state: ConnectionState,
    id: string,
    hubAgentId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): void {
    const handler = this.browserToolCallbacks[0];
    if (!handler) {
      // No handler registered - return error
      this.send(state.ws, {
        type: 'browser_tool_result',
        id,
        result: { content: 'No browser tool handler registered', is_error: true },
      });
      return;
    }

    handler(hubAgentId, toolName, input)
      .then(result => {
        this.send(state.ws, {
          type: 'browser_tool_result',
          id,
          result,
        });
      })
      .catch(err => {
        this.send(state.ws, {
          type: 'browser_tool_result',
          id,
          result: { content: `Browser tool error: ${(err as Error).message}`, is_error: true },
        });
      });
  }
}
