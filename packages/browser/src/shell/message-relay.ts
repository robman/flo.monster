import type { AgentContainer } from '../agent/agent-container.js';
import type { IframeToShell, HookInput, ExtensionContext, NetworkApproval } from '@flo-monster/core';
import { ToolPluginRegistry } from '@flo-monster/core';
import type { HookManager } from './hook-manager.js';
import type { HubClient } from './hub-client.js';
import type { KeyStore } from './key-store.js';
import type { ExtensionLoader } from './extension-loader.js';
import type { AuditManager } from './audit-manager.js';
import { getStorageProvider, type AgentStorageProvider } from '../storage/agent-storage.js';
import type { NetworkApprovalDialog } from '../ui/network-approval-dialog.js';
import type { PermissionApprovalDialog } from '../ui/permission-approval-dialog.js';
import type { PermissionApprovalResult } from '../ui/permission-approval-dialog.js';
import type { NetworkIndicator } from '../ui/network-indicator.js';
import { handleStorageRequest } from './relay/storage-handler.js';
import { handleFileRequest } from './relay/file-handler.js';
import { handleApiRequest, getApiEndpoint, parseAssistantFromSSE, loadConversationContext, type HubStreamFn } from './relay/api-handler.js';
import { executeFetch, handleFetchRequest, type FetchContext } from './relay/fetch-handler.js';
import { handleSrcdocToolCall, type SrcdocContext } from './relay/srcdoc-handler.js';
import { handleCapabilitiesRequest, type CapabilitiesContext } from './relay/capabilities-handler.js';
import { handleSpeechListenStart, handleSpeechListenDone, handleSpeechListenCancel, handleSpeechSpeak, handleSpeechVoices, cleanupSpeechSessions, type SpeechContext } from './relay/speech-handler.js';
import { handleGeolocationGet, handleGeolocationWatchStart, handleGeolocationWatchStop, cleanupGeolocationWatches, type GeolocationContext } from './relay/geolocation-handler.js';

export type { ProxySettings } from './relay/types.js';
export type { FetchContext } from './relay/fetch-handler.js';

import type { ProxySettings } from './relay/types.js';

export type DomMutationCallback = (agentId: string) => void;
export type AgentDirtyCallback = (agentId: string, reason: string) => void;

export class MessageRelay {
  private agents = new Map<string, AgentContainer>();
  private abortController: AbortController | null = null;
  private pluginRegistry: ToolPluginRegistry | null = null;
  private hookManager: HookManager | null = null;
  private hubClient: HubClient | null = null;
  private keyStore: KeyStore | null = null;
  private extensionLoader: ExtensionLoader | null = null;
  private proxySettings: ProxySettings = { useBuiltinProxy: true };
  private pendingShellToolRequests = new Map<string, { resolve: (result: { content: string; is_error?: boolean }) => void; reject: (err: Error) => void }>();
  private shellToolRequestIdCounter = 0;
  private pendingScriptRequests = new Map<string, { resolve: (result: { result?: unknown; error?: string }) => void; reject: (err: Error) => void }>();
  private scriptRequestIdCounter = 0;
  private storageProvider: AgentStorageProvider | null = null;
  private onDomMutationCallback: DomMutationCallback | null = null;
  private onAgentDirtyCallback: AgentDirtyCallback | null = null;
  private auditManager: AuditManager | null = null;
  private networkApprovals = new Map<string, NetworkApproval>();
  private approvalDialog: NetworkApprovalDialog | null = null;
  private networkIndicator: NetworkIndicator | null = null;
  private permissionApprovals = new Map<string, PermissionApprovalResult>();
  private permissionApprovalDialog: PermissionApprovalDialog | null = null;
  private onPermissionChange: ((agentId: string, permission: string, enabled: boolean) => void) | null = null;

  // Active WebRTC media connections per agent: agentId -> Map<requestId, { pc, stream }>
  private mediaConnections = new Map<string, Map<string, { pc: RTCPeerConnection; stream: MediaStream }>>();

  registerAgent(agent: AgentContainer): void {
    this.agents.set(agent.id, agent);
  }

  private async getProvider(): Promise<AgentStorageProvider> {
    if (!this.storageProvider) {
      this.storageProvider = await getStorageProvider();
    }
    return this.storageProvider;
  }

  /**
   * Public access to the storage provider (for shell plugins that need file access).
   */
  getStorageProvider(): Promise<AgentStorageProvider> {
    return this.getProvider();
  }

  async initAgentStorage(agentId: string): Promise<void> {
    try {
      const provider = await this.getProvider();
      await provider.initAgent(agentId);
    } catch (err) {
      console.error('[MessageRelay] Failed to init agent storage:', err);
    }
  }

  unregisterAgent(agentId: string): void {
    this.agents.delete(agentId);
    // Clean up any active media connections
    const agentConns = this.mediaConnections.get(agentId);
    if (agentConns) {
      for (const [, conn] of agentConns) {
        conn.pc.close();
        conn.stream.getTracks().forEach(t => t.stop());
      }
      this.mediaConnections.delete(agentId);
    }
    // Clean up any active speech sessions
    cleanupSpeechSessions(agentId);
    cleanupGeolocationWatches(agentId);
  }

  setPluginRegistry(registry: ToolPluginRegistry): void {
    this.pluginRegistry = registry;
  }

  setHookManager(manager: HookManager): void {
    this.hookManager = manager;
  }

  setProxySettings(settings: ProxySettings): void {
    this.proxySettings = settings;
  }

  getProxySettings(): ProxySettings {
    return { ...this.proxySettings };
  }

  setHubClient(client: HubClient): void {
    this.hubClient = client;
  }

  getHubClient(): HubClient | null {
    return this.hubClient;
  }

  setKeyStore(keyStore: KeyStore): void {
    this.keyStore = keyStore;
  }

  getKeyStore(): KeyStore | null {
    return this.keyStore;
  }

  setExtensionLoader(loader: ExtensionLoader): void {
    this.extensionLoader = loader;
  }

  getExtensionLoader(): ExtensionLoader | null {
    return this.extensionLoader;
  }

  /**
   * Set callback for when a mutating DOM tool call completes.
   * Called with the agentId of the agent that made the DOM mutation.
   */
  setOnDomMutation(callback: DomMutationCallback | null): void {
    this.onDomMutationCallback = callback;
  }

  /**
   * Set callback for when an agent's state changes (storage, files, API, etc.).
   * Called with the agentId and reason for the change.
   */
  setOnAgentDirty(callback: AgentDirtyCallback | null): void {
    this.onAgentDirtyCallback = callback;
  }

  setAuditManager(manager: AuditManager): void {
    this.auditManager = manager;
  }

  setNetworkIndicator(indicator: NetworkIndicator): void {
    this.networkIndicator = indicator;
  }

  setOnPermissionChange(callback: (agentId: string, permission: string, enabled: boolean) => void): void {
    this.onPermissionChange = callback;
  }

  /**
   * Execute a tool in the agent's context (for hook scripts).
   * This sends a request to the agent iframe/worker and waits for the result.
   */
  async executeToolInAgent(
    agentId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<{ content: string; is_error?: boolean }> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const iframe = agent.getIframeElement();
    if (!iframe?.contentWindow) {
      throw new Error(`Agent iframe not available: ${agentId}`);
    }

    const id = `shell-tool-${++this.shellToolRequestIdCounter}`;

    return new Promise((resolve, reject) => {
      // Set a timeout for the request
      const timeout = setTimeout(() => {
        this.pendingShellToolRequests.delete(id);
        reject(new Error(`Tool execution timed out: ${toolName}`));
      }, 30000);

      this.pendingShellToolRequests.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          this.pendingShellToolRequests.delete(id);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timeout);
          this.pendingShellToolRequests.delete(id);
          reject(err);
        },
      });

      const contentWindow = iframe.contentWindow;
      if (contentWindow) {
        contentWindow.postMessage({
          type: 'shell_tool_request',
          id,
          name: toolName,
          input: toolInput,
        }, '*');
      }
    });
  }

  /**
   * Execute a script in the agent's sandboxed context (for hook scripts).
   * This sends a request to the agent iframe/worker and waits for the result.
   */
  async executeScriptInAgent(
    agentId: string,
    code: string,
    context: Record<string, unknown>,
  ): Promise<{ result?: unknown; error?: string }> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const iframe = agent.getIframeElement();
    if (!iframe?.contentWindow) {
      throw new Error(`Agent iframe not available: ${agentId}`);
    }

    const id = `shell-script-${++this.scriptRequestIdCounter}`;

    return new Promise((resolve, reject) => {
      // Set a timeout for the request
      const timeout = setTimeout(() => {
        this.pendingScriptRequests.delete(id);
        reject(new Error(`Script execution timed out`));
      }, 30000);

      this.pendingScriptRequests.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          this.pendingScriptRequests.delete(id);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timeout);
          this.pendingScriptRequests.delete(id);
          reject(err);
        },
      });

      const contentWindow = iframe.contentWindow;
      if (contentWindow) {
        contentWindow.postMessage({
          type: 'shell_script_request',
          id,
          code,
          context,
        }, '*');
      }
    });
  }

  /**
   * Execute a tool on behalf of a hub agent via the existing relay pipeline.
   * This is called when the hub routes a browser-only tool call to this browser.
   */
  async executeToolForHub(
    agentId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ content: string; is_error?: boolean }> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { content: `Agent not found: ${agentId}`, is_error: true };
    }

    // For tools that need iframe access (dom, runjs, snapshot, etc.),
    // delegate to executeToolInAgent which handles the iframe postMessage pipeline
    const iframe = agent.getIframeElement();
    if (!iframe?.contentWindow) {
      return {
        content: `Agent "${agentId}" iframe is not available for tool "${toolName}". The agent needs an active view.`,
        is_error: true,
      };
    }

    // Use the existing shell tool request pipeline (postMessage to iframe, wait for response)
    try {
      return await this.executeToolInAgent(agentId, toolName, input);
    } catch (err) {
      return {
        content: `Tool "${toolName}" execution failed: ${(err as Error).message}`,
        is_error: true,
      };
    }
  }

  /**
   * Get the API endpoint URL based on proxy settings and provider.
   * Provider-specific paths:
   *   anthropic -> /api/anthropic/v1/messages
   *   openai    -> /api/openai/v1/chat/completions
   *   gemini    -> /api/gemini/v1beta/openai/chat/completions
   *   ollama    -> /api/ollama/v1/chat/completions
   */
  private getApiEndpoint(provider: string): string {
    return getApiEndpoint(provider, this.proxySettings);
  }

  start(): void {
    this.abortController = new AbortController();
    window.addEventListener('message', this.handleMessage, { signal: this.abortController.signal });
  }

  stop(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  /** Build the FetchContext from current state for handler delegation */
  private getFetchContext(): FetchContext {
    return {
      hubClient: this.hubClient,
      auditManager: this.auditManager,
      networkIndicator: this.networkIndicator,
      networkApprovals: this.networkApprovals,
      approvalDialog: this.approvalDialog,
      setApprovalDialog: (dialog: NetworkApprovalDialog) => { this.approvalDialog = dialog; },
    };
  }

  /** Build the SrcdocContext from current state for handler delegation */
  private getSrcdocContext(): SrcdocContext {
    return {
      ...this.getFetchContext(),
      pluginRegistry: this.pluginRegistry,
      extensionLoader: this.extensionLoader,
      getProvider: () => this.getProvider(),
    };
  }

  /** Build the SpeechContext from current state for speech handler delegation */
  private getSpeechContext(): SpeechContext {
    return {
      permissionApprovals: this.permissionApprovals,
      permissionApprovalDialog: this.permissionApprovalDialog,
      setPermissionApprovalDialog: (dialog: PermissionApprovalDialog) => { this.permissionApprovalDialog = dialog; },
      onPermissionChange: this.onPermissionChange,
    };
  }

  /** Build the GeolocationContext from current state for handler delegation */
  private getGeolocationContext(): GeolocationContext {
    return {
      permissionApprovals: this.permissionApprovals,
      permissionApprovalDialog: this.permissionApprovalDialog,
      setPermissionApprovalDialog: (dialog: PermissionApprovalDialog) => { this.permissionApprovalDialog = dialog; },
      onPermissionChange: this.onPermissionChange,
    };
  }

  private handleMessage = async (e: MessageEvent): Promise<void> => {
    const data = e.data as IframeToShell;
    if (!data || !data.type) return;

    // Get the agent ID from the message -- all IframeToShell variants carry agentId
    if (!('agentId' in data)) return;
    const agentId = data.agentId;
    if (!agentId) return;

    const agent = this.agents.get(agentId);
    if (!agent) {
      console.warn(`[relay] Unknown agent ID: ${agentId}`);
      return;
    }

    // Verify message source matches the agent's iframe
    if (e.source !== agent.getIframeElement()?.contentWindow) {
      console.warn(`[relay] Message source mismatch for agent: ${agentId}`);
      return;
    }

    const iframe = agent.getIframeElement();
    if (!iframe?.contentWindow) return;

    // Extract workerId - subworkers use their own ID for conversation/storage context
    const workerId = (data as any).workerId as string | undefined;
    const contextId = (workerId && workerId !== 'main') ? workerId : agentId;

    switch (data.type) {
      case 'api_request': {
        const provider = agent.config.provider || 'anthropic';

        // Detect Mode 3: hub has shared key for this provider → route through WS
        let hubStream: HubStreamFn | undefined;
        if (this.hubClient) {
          const conns = this.hubClient.getConnectionsWithSharedProvider(provider);
          console.log(`[relay] API proxy check: provider=${provider}, hubClient=true, sharedConns=${conns.length}, allConns=${this.hubClient.getConnections().length}`,
            conns.length > 0 ? `connId=${conns[0].id}` : 'no shared provider match',
            this.hubClient.getConnections().map(c => `${c.name}(shared=${c.sharedProviders?.join(',') || 'none'})`));
          if (conns.length > 0) {
            const connId = conns[0].id;
            hubStream = (prov, path, payload, callbacks) => {
              console.log(`[relay] Routing API through WS proxy: ${prov} ${path}`);
              this.hubClient!.streamApiProxy(connId, prov, path, payload, callbacks);
            };
          }
        } else {
          console.log(`[relay] API proxy check: no hubClient`);
        }

        await handleApiRequest(data, iframe.contentWindow, contextId, provider, this.proxySettings, () => this.getProvider(), {
          contextMode: agent.config.contextMode,
          fullContextTurns: agent.config.fullContextTurns,
        }, hubStream);
        // Mark dirty after API response (conversation changed)
        this.onAgentDirtyCallback?.(agentId, 'message');
        break;
      }
      case 'storage_request':
        await handleStorageRequest(data, contextId, iframe.contentWindow, this.auditManager);
        // Mark dirty on write/delete operations
        if ((data as any).action === 'set' || (data as any).action === 'delete') {
          this.onAgentDirtyCallback?.(agentId, 'storage');
        }
        break;
      case 'file_request':
        await handleFileRequest(data, contextId, iframe.contentWindow, () => this.getProvider());
        // Mark dirty on file write/delete operations
        if ((data as any).action === 'write_file' || (data as any).action === 'delete_file' || (data as any).action === 'mkdir') {
          this.onAgentDirtyCallback?.(agentId, 'file');
        }
        break;
      case 'fetch_request':
        await handleFetchRequest(data, agent, iframe.contentWindow, this.getFetchContext());
        break;
      case 'tool_execute':
        await this.handleToolExecute(data, agent, iframe.contentWindow);
        break;
      case 'pre_tool_use':
      case 'post_tool_use':
      case 'agent_stop':
      case 'user_prompt_submit':
      case 'agent_start':
      case 'agent_end':
        await this.handleHookMessage(data, iframe.contentWindow);
        break;
      case 'shell_tool_response':
        this.handleShellToolResponse(data);
        break;
      case 'shell_script_response':
        this.handleShellScriptResponse(data as Extract<IframeToShell, { type: 'shell_script_response' }>);
        break;
      case 'runtime_error':
        // Forward runtime errors back to iframe (which routes to worker)
        // Support new batch format (errors array) with backward compat
        iframe.contentWindow.postMessage({
          type: 'runtime_error',
          errors: (data as any).errors || ((data as any).error ? [(data as any).error] : []),
        }, '*');
        break;
      case 'dom_mutated':
        // Notify callback for DOM auto-save
        if (this.onDomMutationCallback && agent) {
          this.onDomMutationCallback(agent.id);
        }
        // Mark dirty for DOM changes
        this.onAgentDirtyCallback?.(agentId, 'dom');
        break;
      case 'srcdoc_tool_call':
        await handleSrcdocToolCall(
          data as { type: 'srcdoc_tool_call'; id: string; agentId: string; name: string; input: Record<string, unknown> },
          agent,
          iframe.contentWindow,
          this.getSrcdocContext(),
        );
        break;
      case 'capabilities_request':
        handleCapabilitiesRequest(
          data as { type: 'capabilities_request'; id: string; agentId: string; iframeData: Record<string, unknown> },
          agent,
          iframe.contentWindow,
          {
            hubClient: this.hubClient,
            extensionLoader: this.extensionLoader,
          },
        );
        break;
      case 'permission_request':
        await this.handlePermissionRequest(
          data as { type: 'permission_request'; id: string; agentId: string; permission: 'camera' | 'microphone' | 'geolocation' },
          agent,
          iframe.contentWindow
        );
        break;
      case 'media_request':
        await this.handleMediaRequest(
          data as { type: 'media_request'; id: string; agentId: string; constraints: { video?: boolean; audio?: boolean } },
          agent,
          iframe.contentWindow
        );
        break;
      case 'media_answer':
        this.handleMediaAnswer(
          data as { type: 'media_answer'; id: string; agentId: string; answer: { type: string; sdp: string } },
          agent
        );
        break;
      case 'media_ice':
        this.handleMediaIce(
          data as { type: 'media_ice'; id: string; agentId: string; candidate: string },
          agent
        );
        break;
      case 'media_stop':
        this.handleMediaStop(
          (data as any).id as string,
          agent
        );
        break;
      case 'speech_listen_start':
        await handleSpeechListenStart(
          data as { type: 'speech_listen_start'; id: string; agentId: string; lang?: string },
          agent,
          iframe.contentWindow,
          this.getSpeechContext(),
        );
        break;
      case 'speech_listen_done':
        handleSpeechListenDone(
          data as { type: 'speech_listen_done'; id: string; agentId: string },
          agent,
          iframe.contentWindow,
        );
        break;
      case 'speech_listen_cancel':
        handleSpeechListenCancel(
          data as { type: 'speech_listen_cancel'; id: string; agentId: string },
          agent,
          iframe.contentWindow,
        );
        break;
      case 'speech_speak':
        handleSpeechSpeak(
          data as { type: 'speech_speak'; id: string; agentId: string; text: string; voice?: string; lang?: string },
          agent,
          iframe.contentWindow,
        );
        break;
      case 'speech_voices':
        handleSpeechVoices(
          data as { type: 'speech_voices'; id: string; agentId: string },
          iframe.contentWindow,
        );
        break;
      case 'geolocation_get':
        await handleGeolocationGet(
          data as { type: 'geolocation_get'; id: string; agentId: string; enableHighAccuracy?: boolean; timeout?: number; maximumAge?: number },
          agent,
          iframe.contentWindow,
          this.getGeolocationContext(),
        );
        break;
      case 'geolocation_watch_start':
        await handleGeolocationWatchStart(
          data as { type: 'geolocation_watch_start'; id: string; agentId: string; enableHighAccuracy?: boolean; timeout?: number; maximumAge?: number },
          agent,
          iframe.contentWindow,
          this.getGeolocationContext(),
        );
        break;
      case 'geolocation_watch_stop':
        handleGeolocationWatchStop(
          data as { type: 'geolocation_watch_stop'; id: string; agentId: string },
          agent,
          iframe.contentWindow,
        );
        break;
    }
  };

  private handleShellToolResponse(
    msg: Extract<IframeToShell, { type: 'shell_tool_response' }>,
  ): void {
    const pending = this.pendingShellToolRequests.get(msg.id);
    if (!pending) {
      console.warn(`[relay] No pending request for shell_tool_response: ${msg.id}`);
      return;
    }

    if (msg.error) {
      pending.resolve({ content: msg.error, is_error: true });
    } else {
      pending.resolve({ content: msg.result || '', is_error: false });
    }
  }

  private handleShellScriptResponse(
    msg: Extract<IframeToShell, { type: 'shell_script_response' }>,
  ): void {
    const pending = this.pendingScriptRequests.get(msg.id);
    if (!pending) {
      console.warn(`[relay] No pending request for shell_script_response: ${msg.id}`);
      return;
    }

    pending.resolve({ result: msg.result, error: msg.error });
  }

  private async handleToolExecute(
    msg: Extract<IframeToShell, { type: 'tool_execute' }>,
    agent: AgentContainer,
    target: Window,
  ): Promise<void> {
    // Priority: local plugins first, then hub.
    // Local plugins have browser-specific state (skill manager, etc.)
    // and are explicitly registered to handle tools. Hub provides tools
    // the browser can't offer (bash, filesystem).
    if (this.pluginRegistry?.has(msg.name)) {
      try {
        // Get extension context if tool belongs to an extension
        let extensionContext: ExtensionContext | undefined;
        const extensionId = this.pluginRegistry.getExtensionId(msg.name);
        if (extensionId && this.extensionLoader) {
          extensionContext = await this.extensionLoader.getExtensionContext(extensionId);
        }

        const result = await this.pluginRegistry.execute(msg.name, msg.input, {
          agentId: agent.id,
          agentConfig: agent.config,
          extensionContext,
        });

        // Log to audit
        this.auditManager?.append(agent.id, {
          source: 'agent',
          tool: msg.name,
        });

        target.postMessage({
          type: 'tool_execute_result',
          id: msg.id,
          result: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
          error: result.is_error ? (typeof result.content === 'string' ? result.content : JSON.stringify(result.content)) : undefined,
        }, '*');
        return;
      } catch (err) {
        target.postMessage({
          type: 'tool_execute_result',
          id: msg.id,
          error: String(err),
        }, '*');
        return;
      }
    }

    // Fall through to hub for tools without a local plugin
    if (this.hubClient) {
      // Use agent-specific hub if configured, otherwise find which hub has the tool
      let hubId: string | undefined;

      if (agent.config.hubConnectionId) {
        // Agent has a specific hub configured - check if that hub has this tool
        const conn = this.hubClient.getConnection(agent.config.hubConnectionId);
        if (conn && conn.tools.some(t => t.name === msg.name)) {
          hubId = agent.config.hubConnectionId;
        }
      } else {
        // No specific hub - use first available that has the tool
        hubId = this.hubClient.findToolHub(msg.name);
      }

      if (hubId) {
        try {
          const result = await this.hubClient.executeTool(hubId, msg.name, msg.input, agent.id);
          target.postMessage({
            type: 'tool_execute_result',
            id: msg.id,
            result: result.result,
            error: result.is_error ? result.result : undefined,
          }, '*');
          return;
        } catch (err) {
          target.postMessage({
            type: 'tool_execute_result',
            id: msg.id,
            error: 'Hub tool execution failed: ' + String(err),
          }, '*');
          return;
        }
      }
    }

    // No local plugin and no hub — error
    target.postMessage({
      type: 'tool_execute_result',
      id: msg.id,
      error: `Unknown tool: ${msg.name}`,
    }, '*');
  }

  /**
   * Shared fetch logic used by both worker fetch requests and srcdoc builtin tool.
   * Delegates to the extracted fetch-handler module.
   */
  private async executeFetch(
    url: string,
    options: { method?: string; headers?: HeadersInit | Record<string, string>; body?: BodyInit | null } | undefined,
    agent: AgentContainer,
    source: 'agent' | 'srcdoc',
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    return executeFetch(url, options, agent, source, this.getFetchContext());
  }

  parseAssistantFromSSE(sseText: string, provider: string = 'anthropic'): { message: Record<string, unknown>; stopReason: string } | null {
    return parseAssistantFromSSE(sseText, provider);
  }

  async loadConversationContext(agentId: string): Promise<unknown[]> {
    return loadConversationContext(agentId, () => this.getProvider());
  }

  private async handleHookMessage(
    msg: Extract<IframeToShell, { type: 'pre_tool_use' }> | Extract<IframeToShell, { type: 'post_tool_use' }> | Extract<IframeToShell, { type: 'agent_stop' }> | Extract<IframeToShell, { type: 'user_prompt_submit' }> | Extract<IframeToShell, { type: 'agent_start' }> | Extract<IframeToShell, { type: 'agent_end' }>,
    target: Window,
  ): Promise<void> {
    const resultTypeMap: Record<string, string> = {
      'pre_tool_use': 'pre_tool_use_result',
      'post_tool_use': 'post_tool_use_result',
      'agent_stop': 'agent_stop_result',
      'user_prompt_submit': 'user_prompt_submit_result',
      'agent_start': 'agent_start_result',
      'agent_end': 'agent_end_result',
    };
    const resultType = resultTypeMap[msg.type] as 'pre_tool_use_result' | 'post_tool_use_result' | 'agent_stop_result' | 'user_prompt_submit_result' | 'agent_start_result' | 'agent_end_result';

    if (!this.hookManager) {
      target.postMessage({
        type: resultType,
        id: msg.id,
        decision: 'default',
      }, '*');
      return;
    }

    try {
      // Map protocol message type to HookInput type
      let hookInput: HookInput;
      if (msg.type === 'pre_tool_use') {
        hookInput = {
          type: 'pre_tool_use',
          agentId: msg.agentId,
          toolName: msg.toolName,
          toolInput: msg.toolInput || {},
        };
      } else if (msg.type === 'post_tool_use') {
        hookInput = {
          type: 'post_tool_use',
          agentId: msg.agentId,
          toolName: msg.toolName,
          toolInput: msg.toolInput || {},
          toolResult: msg.toolResult,
        };
      } else if (msg.type === 'agent_stop') {
        // agent_stop -> stop
        hookInput = {
          type: 'stop',
          agentId: msg.agentId,
          stopReason: msg.stopReason || 'end_turn',
        };
      } else if (msg.type === 'user_prompt_submit') {
        hookInput = {
          type: 'user_prompt_submit',
          agentId: msg.agentId,
          prompt: msg.prompt,
        };
      } else if (msg.type === 'agent_start') {
        hookInput = {
          type: 'agent_start',
          agentId: msg.agentId,
        };
      } else {
        // agent_end
        hookInput = {
          type: 'agent_end',
          agentId: msg.agentId,
        };
      }

      const result = await this.hookManager.evaluate(hookInput);

      // Build response message with type-specific fields
      const responseMsg: Record<string, unknown> = {
        type: resultType,
        id: msg.id,
        decision: result.decision,
        reason: result.reason,
      };

      // Include modifiedInput for pre_tool_use
      if (msg.type === 'pre_tool_use' && result.modifiedInput) {
        responseMsg.modifiedInput = result.modifiedInput;
      }

      // Include modifiedPrompt for user_prompt_submit (from modifiedInput.prompt)
      if (msg.type === 'user_prompt_submit' && result.modifiedInput?.prompt) {
        responseMsg.modifiedPrompt = result.modifiedInput.prompt;
      }

      target.postMessage(responseMsg, '*');
    } catch (_err) {
      target.postMessage({
        type: resultType,
        id: msg.id,
        decision: 'default',
      }, '*');
    }
  }

  private async handlePermissionRequest(
    msg: { type: 'permission_request'; id: string; agentId: string; permission: 'camera' | 'microphone' | 'geolocation' },
    agent: AgentContainer,
    target: Window,
  ): Promise<void> {
    // Check if permission is enabled in agent config
    const permissions = agent.config.sandboxPermissions;
    const isEnabled = permissions?.[msg.permission] ?? false;

    if (!isEnabled) {
      // Permission not pre-enabled — check session cache
      const cacheKey = `${agent.id}:${msg.permission}`;
      const cached = this.permissionApprovals.get(cacheKey);

      if (cached) {
        if (!cached.approved) {
          target.postMessage({
            type: 'permission_result',
            id: msg.id,
            granted: false,
            error: `Permission "${msg.permission}" was denied.`,
          }, '*');
          return;
        }
        // cached.approved = true — fall through to execute
      } else {
        // Show approval dialog
        const { PermissionApprovalDialog } = await import('../ui/permission-approval-dialog.js');
        if (!this.permissionApprovalDialog) {
          this.permissionApprovalDialog = new PermissionApprovalDialog();
        }

        const result = await this.permissionApprovalDialog.show(agent.config.name, msg.permission);

        // Cache the result for this session
        this.permissionApprovals.set(cacheKey, result);

        if (!result.approved) {
          target.postMessage({
            type: 'permission_result',
            id: msg.id,
            granted: false,
            error: `Permission "${msg.permission}" was denied by the user.`,
          }, '*');
          return;
        }

        // User approved — update config and allow attribute
        const updatedPermissions = { ...agent.config.sandboxPermissions, [msg.permission]: true };
        agent.updateConfig({ sandboxPermissions: updatedPermissions });

        // Notify for persistence if "Allow Always"
        if (result.persistent && this.onPermissionChange) {
          this.onPermissionChange(agent.id, msg.permission, true);
        }
      }
    }

    // Log to audit
    this.auditManager?.append(agent.id, {
      source: 'srcdoc',
      action: 'permission_request',
      event: msg.permission,
    });

    // Execute the actual browser permission request
    try {
      let granted = false;

      if (msg.permission === 'geolocation') {
        granted = await new Promise<boolean>((resolve) => {
          navigator.geolocation.getCurrentPosition(
            () => resolve(true),
            (err) => {
              console.warn('[relay] Geolocation permission denied:', err.message);
              resolve(false);
            },
            { timeout: 30000 }
          );
        });
      } else if (msg.permission === 'camera' || msg.permission === 'microphone') {
        const constraints: MediaStreamConstraints = {};
        if (msg.permission === 'camera') constraints.video = true;
        if (msg.permission === 'microphone') constraints.audio = true;

        try {
          const stream = await navigator.mediaDevices.getUserMedia(constraints);
          stream.getTracks().forEach(track => track.stop());
          granted = true;
        } catch (err) {
          console.warn(`[relay] ${msg.permission} permission denied:`, (err as Error).message);
          granted = false;
        }
      }

      // Log result
      this.auditManager?.append(agent.id, {
        source: 'shell',
        action: 'permission_result',
        event: msg.permission,
        approved: granted,
      });

      target.postMessage({
        type: 'permission_result',
        id: msg.id,
        granted,
      }, '*');
    } catch (err) {
      target.postMessage({
        type: 'permission_result',
        id: msg.id,
        granted: false,
        error: String(err),
      }, '*');
    }
  }

  private async handleMediaRequest(
    msg: { type: 'media_request'; id: string; agentId: string; constraints: { video?: boolean; audio?: boolean } },
    agent: AgentContainer,
    target: Window,
  ): Promise<void> {
    // Step 1: Check permissions for each requested media type
    const neededPermissions: Array<'camera' | 'microphone'> = [];
    if (msg.constraints.video) neededPermissions.push('camera');
    if (msg.constraints.audio) neededPermissions.push('microphone');

    for (const permission of neededPermissions) {
      const isEnabled = agent.config.sandboxPermissions?.[permission] ?? false;

      if (!isEnabled) {
        const cacheKey = `${agent.id}:${permission}`;
        const cached = this.permissionApprovals.get(cacheKey);

        if (cached) {
          if (!cached.approved) {
            target.postMessage({ type: 'media_error', id: msg.id, error: `Permission "${permission}" was denied.` }, '*');
            return;
          }
        } else {
          const { PermissionApprovalDialog } = await import('../ui/permission-approval-dialog.js');
          if (!this.permissionApprovalDialog) {
            this.permissionApprovalDialog = new PermissionApprovalDialog();
          }
          const result = await this.permissionApprovalDialog.show(agent.config.name, permission);
          this.permissionApprovals.set(cacheKey, result);

          if (!result.approved) {
            target.postMessage({ type: 'media_error', id: msg.id, error: `Permission "${permission}" was denied by the user.` }, '*');
            return;
          }

          const updatedPermissions = { ...agent.config.sandboxPermissions, [permission]: true };
          agent.updateConfig({ sandboxPermissions: updatedPermissions });

          if (result.persistent && this.onPermissionChange) {
            this.onPermissionChange(agent.id, permission, true);
          }
        }
      }
    }

    // Audit log
    this.auditManager?.append(agent.id, {
      source: 'srcdoc',
      action: 'media_request',
      event: `video=${!!msg.constraints.video},audio=${!!msg.constraints.audio}`,
    });

    // Step 2: Capture media in the shell (real origin)
    let stream: MediaStream;
    try {
      const constraints: MediaStreamConstraints = {};
      if (msg.constraints.video) constraints.video = true;
      if (msg.constraints.audio) constraints.audio = true;
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      target.postMessage({
        type: 'media_error',
        id: msg.id,
        error: `Media capture failed: ${(err as Error).message}`,
      }, '*');
      return;
    }

    // Step 3: Create RTCPeerConnection and add tracks
    const pc = new RTCPeerConnection();
    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream);
    }

    // Store connection for cleanup
    let agentConns = this.mediaConnections.get(agent.id);
    if (!agentConns) {
      agentConns = new Map();
      this.mediaConnections.set(agent.id, agentConns);
    }
    agentConns.set(msg.id, { pc, stream });

    // Forward ICE candidates to iframe
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        target.postMessage({
          type: 'media_ice',
          id: msg.id,
          candidate: JSON.stringify(ev.candidate),
        }, '*');
      }
    };

    // Step 4: Create offer and send to iframe
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      target.postMessage({
        type: 'media_offer',
        id: msg.id,
        offer: { type: offer.type!, sdp: offer.sdp! },
        expectedTracks: stream.getTracks().length,
      }, '*');
    } catch (err) {
      // Cleanup on failure
      pc.close();
      stream.getTracks().forEach(t => t.stop());
      agentConns.delete(msg.id);
      target.postMessage({
        type: 'media_error',
        id: msg.id,
        error: `WebRTC offer creation failed: ${(err as Error).message}`,
      }, '*');
    }
  }

  private handleMediaAnswer(
    msg: { type: 'media_answer'; id: string; agentId: string; answer: { type: string; sdp: string } },
    agent: AgentContainer,
  ): void {
    const conn = this.mediaConnections.get(agent.id)?.get(msg.id);
    if (!conn) return;

    conn.pc.setRemoteDescription(new RTCSessionDescription(msg.answer as RTCSessionDescriptionInit))
      .catch((err: Error) => console.warn('[relay] Failed to set remote description:', err.message));
  }

  private handleMediaIce(
    msg: { type: 'media_ice'; id: string; agentId: string; candidate: string },
    agent: AgentContainer,
  ): void {
    const conn = this.mediaConnections.get(agent.id)?.get(msg.id);
    if (!conn) return;

    conn.pc.addIceCandidate(new RTCIceCandidate(JSON.parse(msg.candidate)))
      .catch(() => {}); // ICE candidate errors are non-fatal
  }

  private handleMediaStop(requestId: string, agent: AgentContainer): void {
    const agentConns = this.mediaConnections.get(agent.id);
    if (!agentConns) return;

    const conn = agentConns.get(requestId);
    if (conn) {
      conn.pc.close();
      conn.stream.getTracks().forEach(t => t.stop());
      agentConns.delete(requestId);
    }
  }
}
