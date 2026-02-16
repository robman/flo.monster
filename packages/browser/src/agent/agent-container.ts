import type { AgentConfig, AgentState, AgentViewState, AgentEvent, SubworkerInfo, SerializedDomState } from '@flo-monster/core';
import { generateRequestId } from '@flo-monster/core';
import { generateIframeSrcdoc, injectBootstrap } from './iframe-template.js';
import type { HubClient } from '../shell/hub-client.js';

type EventCallback = (event: AgentEvent) => void;

export type ViewStateRequestCallback = (agentId: string, requestedState: AgentViewState) => void;

/**
 * Context provided to restored agents so they know their restoration status
 */
export interface RestorationContext {
  domRestored: boolean;  // Was DOM state successfully restored
}

export class AgentContainer {
  readonly id: string;
  readonly config: AgentConfig;
  private _state: AgentState = 'pending';
  private _isVisible: boolean = false;
  private _viewState: AgentViewState = 'max';
  private iframe: HTMLIFrameElement | null = null;
  private eventCallbacks: EventCallback[] = [];
  private hostElement: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private activePaneEl: HTMLElement | null = null;
  private subworkers = new Map<string, SubworkerInfo>();
  private customSrcdoc: string | null = null;
  private viewStateRequestCallback: ViewStateRequestCallback | null = null;
  private restorationContext: RestorationContext | null = null;
  private _hubPersistInfo: { hubAgentId: string; hubName: string; hubConnectionId: string } | null = null;
  private hubClient: HubClient | null = null;
  private hubConnectionId: string | null = null;
  private hubEventUnsubs: (() => void)[] = [];
  private _hubConnected: boolean = false;
  private pendingConversationHistory: any[] | null = null;
  private _pendingHubDomState: SerializedDomState | null = null;
  private _lastSentMessage: string | null = null;

  constructor(config: AgentConfig, initialState: AgentState = 'pending') {
    this.id = config.id;
    this.config = config;
    this._state = initialState;
  }

  /**
   * Set a custom srcdoc HTML to use instead of the default.
   * Must be called before start().
   */
  setCustomSrcdoc(html: string): void {
    if (this._state !== 'pending') {
      throw new Error('Cannot set custom srcdoc after agent has started');
    }
    this.customSrcdoc = html;
  }

  get state(): AgentState {
    return this._state;
  }

  isVisible(): boolean {
    return this._isVisible;
  }

  getViewState(): AgentViewState {
    return this._viewState;
  }

  get hubPersistInfo(): { hubAgentId: string; hubName: string; hubConnectionId: string } | null {
    return this._hubPersistInfo;
  }

  setHubPersistInfo(info: { hubAgentId: string; hubName: string; hubConnectionId: string }): void {
    this._hubPersistInfo = info;
  }

  /**
   * Whether this agent's hub is currently connected
   */
  get hubConnected(): boolean {
    return this._hubConnected;
  }

  /**
   * Buffered DOM state from hub, waiting for iframe to be ready.
   */
  get pendingHubDomState(): SerializedDomState | null {
    return this._pendingHubDomState;
  }

  /**
   * Update hub connection status. Emits a hub_connection_change event.
   */
  setHubConnected(connected: boolean): void {
    if (this._hubConnected === connected) return;
    this._hubConnected = connected;
    this.emitEvent({ type: 'hub_connection_change', connected } as any);
  }

  /**
   * Set DOM state from hub. If iframe is ready, applies immediately.
   * Otherwise buffers for application after start().
   */
  setHubDomState(state: SerializedDomState): void {
    const hasHtml = !!state?.viewportHtml;
    const htmlLen = state?.viewportHtml?.length || 0;
    if (this.iframe?.contentWindow) {
      console.log(`[flo:dom-debug] setHubDomState ${this.config.name}: iframe ready, applying immediately (hasHtml=${hasHtml}, len=${htmlLen})`);
      this.restoreDomState(state);
      this._pendingHubDomState = null;
    } else {
      console.log(`[flo:dom-debug] setHubDomState ${this.config.name}: no iframe, buffering (hasHtml=${hasHtml}, len=${htmlLen})`);
      this._pendingHubDomState = state;
    }
  }

  /**
   * Wire this agent to receive events from the hub.
   * Registers callbacks on HubClient that filter by hubAgentId and emit through
   * the local event system so ConversationView etc. work unchanged.
   */
  setHubEventSource(hubClient: HubClient, connectionId: string): void {
    // Clean up any previous subscriptions
    this.clearHubEventSource();

    this.hubClient = hubClient;
    this.hubConnectionId = connectionId;

    const hubAgentId = this._hubPersistInfo?.hubAgentId;
    if (!hubAgentId) return;

    // Forward agent loop events (text_delta, tool_use_done, usage, turn_end)
    const unsubLoop = hubClient.onAgentLoopEvent((agentId, event) => {
      if (agentId === hubAgentId) {
        this.emitEvent(event);
      }
    });
    this.hubEventUnsubs.push(unsubLoop);

    // Forward conversation history (for rendering in ConversationView on subscribe)
    const unsubHistory = hubClient.onConversationHistory((agentId, messages) => {
      if (agentId === hubAgentId) {
        this.pendingConversationHistory = messages;
        this.emitEvent({ type: 'conversation_history', messages } as any);
      }
    });
    this.hubEventUnsubs.push(unsubHistory);

    // Forward agent state and message events
    // Two formats: agent_state has { state }, agent_event broadcast has { data: { to } }
    const unsubEvent = hubClient.onAgentEvent((agentId, event) => {
      if (agentId === hubAgentId) {
        if (event.type === 'state_change') {
          const newState = event.state || event.data?.to;
          if (!newState) return;
          const stateMap: Record<string, AgentState> = {
            'pending': 'pending',
            'running': 'running',
            'paused': 'paused',
            'stopped': 'stopped',
          };
          const mappedState = stateMap[newState];
          if (mappedState && mappedState !== this._state) {
            this.setState(mappedState);
          }
        } else if (event.type === 'message' && event.data?.role === 'user') {
          // Broadcast user messages from other browsers
          // Skip if this is the message we just sent (already rendered locally)
          const content = event.data.content;
          if (this._lastSentMessage === content) {
            this._lastSentMessage = null;
            return;
          }
          this.emitEvent({ type: 'hub_user_message', content } as any);
        }
      }
    });
    this.hubEventUnsubs.push(unsubEvent);

    // Enable hub mode in worker so page events route to hub
    this.iframe?.contentWindow?.postMessage({ type: 'set_hub_mode', enabled: true }, '*');
  }

  /**
   * Remove hub event subscriptions
   */
  clearHubEventSource(): void {
    if (this._pendingHubDomState) {
      console.log(`[flo:dom-debug] clearHubEventSource ${this.config.name}: clearing pendingHubDomState!`);
    }
    // Disable hub mode in worker before clearing hub wiring
    this.iframe?.contentWindow?.postMessage({ type: 'set_hub_mode', enabled: false }, '*');
    for (const unsub of this.hubEventUnsubs) {
      unsub();
    }
    this.hubEventUnsubs = [];
    this.hubClient = null;
    this.hubConnectionId = null;
    this.pendingConversationHistory = null;
    this._pendingHubDomState = null;
    this.setHubConnected(false);
  }

  setViewState(state: AgentViewState, requestedBy: 'user' | 'agent' = 'user'): void {
    if (state === this._viewState) return;
    const from = this._viewState;
    this._viewState = state;
    this.emitEvent({ type: 'view_state_change', from, to: state, requestedBy });
    // Notify iframe of view state change
    this.iframe?.contentWindow?.postMessage({ type: 'set_view_state', state }, '*');
  }

  /**
   * Set callback for when agent requests a view state change
   */
  onViewStateRequest(callback: ViewStateRequestCallback): void {
    this.viewStateRequestCallback = callback;
  }

  /**
   * Notify agent of mobile viewport state
   */
  setMobileStatus(isMobile: boolean): void {
    this.iframe?.contentWindow?.postMessage({ type: 'set_mobile', isMobile }, '*');
  }

  private setState(newState: AgentState): void {
    const from = this._state;
    this._state = newState;
    this.emitEvent({ type: 'state_change', from, to: newState });
  }

  async start(hostElement: HTMLElement, workerCode: string): Promise<void> {
    if (this._state !== 'pending') {
      throw new Error(`Cannot start agent in state: ${this._state}`);
    }
    this.hostElement = hostElement;

    // Create sandboxed iframe
    this.iframe = document.createElement('iframe');
    this.iframe.setAttribute('sandbox', 'allow-scripts allow-forms');
    // Always delegate all permissions via Permissions Policy.
    // This doesn't grant access — it allows the iframe to REQUEST these APIs.
    // The browser's own permission prompt is the security boundary.
    // Our approval dialog (sandboxPermissions + PermissionApprovalDialog) provides
    // additional agent-level gating via flo.requestPermission().
    this.iframe.setAttribute('allow', 'autoplay; camera; microphone; geolocation');
    // Start offscreen in persistent container
    this.iframe.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;border:none;';

    // Generate srcdoc with bootstrap code
    if (this.customSrcdoc) {
      // Use custom srcdoc with bootstrap injected
      this.iframe.srcdoc = injectBootstrap(this.customSrcdoc, this.id);
    } else {
      this.iframe.srcdoc = generateIframeSrcdoc(this.id, this.config.name);
    }

    // Listen for messages from iframe
    window.addEventListener('message', this.handleIframeMessage);

    // Wait for iframe ready (with timeout to prevent hanging on broken iframes)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.removeEventListener('message', handler);
        console.error(`[agent:${this.id}] Iframe ready timeout after 10s — iframe may have failed to load`);
        reject(new Error('Iframe ready timeout'));
      }, 10000);

      const handler = (e: MessageEvent) => {
        if (e.source !== this.iframe?.contentWindow) return;
        if (e.data?.type === 'ready' && e.data?.agentId === this.id) {
          clearTimeout(timeout);
          window.removeEventListener('message', handler);
          resolve();
        }
      };
      window.addEventListener('message', handler);
      hostElement.appendChild(this.iframe!);
    });

    // Send init message with worker code and config
    this.iframe.contentWindow?.postMessage({
      type: 'init',
      agentId: this.id,
      workerCode,
      config: this.config,
    }, '*');

    // If this is a restored agent, send restoration context
    this.sendRestorationContext();

    // If hub-persisted, enable hub mode in worker (handles case where
    // setHubEventSource was called before start, i.e. before iframe existed)
    if (this._hubPersistInfo) {
      this.iframe?.contentWindow?.postMessage({ type: 'set_hub_mode', enabled: true }, '*');
    }

    this.setState('running');
  }

  pause(): void {
    if (this._state !== 'running') return;
    if (this._hubPersistInfo && this.hubClient && this.hubConnectionId) {
      // Hub-persisted: send to hub, state update will come back via event stream
      this.hubClient.sendAgentAction(
        this.hubConnectionId,
        this._hubPersistInfo.hubAgentId,
        'pause',
      );
      return;
    }
    this.iframe?.contentWindow?.postMessage({ type: 'pause' }, '*');
    this.setState('paused');
  }

  resume(): void {
    if (this._state !== 'paused') return;
    if (this._hubPersistInfo && this.hubClient && this.hubConnectionId) {
      this.hubClient.sendAgentAction(
        this.hubConnectionId,
        this._hubPersistInfo.hubAgentId,
        'resume',
      );
      return;
    }
    this.iframe?.contentWindow?.postMessage({ type: 'resume' }, '*');
    this.setState('running');
  }

  stop(): void {
    if (this._state !== 'running' && this._state !== 'paused') return;
    if (this._hubPersistInfo && this.hubClient && this.hubConnectionId) {
      this.hubClient.sendAgentAction(
        this.hubConnectionId,
        this._hubPersistInfo.hubAgentId,
        'stop',
      );
      return;
    }
    this.iframe?.contentWindow?.postMessage({ type: 'stop_agent' }, '*');
    this.setState('stopped');
  }

  kill(): void {
    if (this._state === 'killed') return;
    // Notify hub first (before cleanup)
    if (this._hubPersistInfo && this.hubClient && this.hubConnectionId) {
      this.hubClient.sendAgentAction(
        this.hubConnectionId,
        this._hubPersistInfo.hubAgentId,
        'kill',
      );
    }
    this.clearHubEventSource();
    this.hideFromPane();
    window.removeEventListener('message', this.handleIframeMessage);
    if (this.iframe && this.iframe.parentElement) {
      this.iframe.parentElement.removeChild(this.iframe);
    }
    this.iframe = null;
    this.setState('killed');
  }

  restart(): void {
    if (this._state !== 'stopped' && this._state !== 'killed' && this._state !== 'error') {
      throw new Error(`Cannot restart agent in state: ${this._state}`);
    }
    // Clean up any existing resources
    this.hideFromPane();
    window.removeEventListener('message', this.handleIframeMessage);
    if (this.iframe && this.iframe.parentElement) {
      this.iframe.parentElement.removeChild(this.iframe);
    }
    this.iframe = null;
    this.setState('pending');
  }

  /**
   * Force restart regardless of current state. Used during restore when a hub-persisted
   * agent's state was changed by the hub (via discoverHubAgents race) before the iframe
   * was created. Does NOT clear hub event source — preserves existing hub wiring.
   */
  forceRestart(): void {
    this.hideFromPane();
    window.removeEventListener('message', this.handleIframeMessage);
    if (this.iframe && this.iframe.parentElement) {
      this.iframe.parentElement.removeChild(this.iframe);
    }
    this.iframe = null;
    this.setState('pending');
  }

  showInPane(paneEl: HTMLElement): void {
    if (!this.iframe) return;
    this.activePaneEl = paneEl;

    const updatePosition = () => {
      if (!this.iframe || !this.activePaneEl) return;
      const rect = this.activePaneEl.getBoundingClientRect();
      this.iframe.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;border:none;z-index:10;`;
    };

    updatePosition();

    this.resizeObserver = new ResizeObserver(updatePosition);
    this.resizeObserver.observe(paneEl);

    // Set visibility and emit event
    this._isVisible = true;
    this.emitEvent({ type: 'visibility_change', visible: true });
    this.iframe.contentWindow?.postMessage({ type: 'visibility_change', visible: true }, '*');
  }

  hideFromPane(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.activePaneEl = null;
    if (this.iframe) {
      this.iframe.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;border:none;';
    }

    // Set visibility and emit event
    if (this._isVisible) {
      this._isVisible = false;
      this.emitEvent({ type: 'visibility_change', visible: false });
      this.iframe?.contentWindow?.postMessage({ type: 'visibility_change', visible: false }, '*');
    }
  }

  updateConfig(changes: Partial<AgentConfig>): void {
    // Merge safe fields - cast to mutable to allow updates
    const mutableConfig = this.config as { -readonly [K in keyof AgentConfig]: AgentConfig[K] };
    if (changes.model !== undefined) mutableConfig.model = changes.model;
    if (changes.provider !== undefined) mutableConfig.provider = changes.provider;
    if (changes.systemPrompt !== undefined) mutableConfig.systemPrompt = changes.systemPrompt;
    if (changes.maxTokens !== undefined) mutableConfig.maxTokens = changes.maxTokens;
    if (changes.tokenBudget !== undefined) mutableConfig.tokenBudget = changes.tokenBudget;
    if (changes.costBudgetUsd !== undefined) mutableConfig.costBudgetUsd = changes.costBudgetUsd;
    if (changes.sandboxPermissions !== undefined) mutableConfig.sandboxPermissions = changes.sandboxPermissions;

    this.iframe?.contentWindow?.postMessage({
      type: 'config_update',
      config: changes,
    }, '*');
  }

  sendUserMessage(content: string, workerId?: string): void {
    if (this._hubPersistInfo && this.hubClient && this.hubConnectionId) {
      // Hub-persisted agent: route message through hub
      // Track locally-sent message to avoid duplicate rendering from broadcast
      this._lastSentMessage = content;
      this.hubClient.sendAgentMessage(
        this.hubConnectionId,
        this._hubPersistInfo.hubAgentId,
        content,
      );
      return;
    }
    // Local agent: send directly to iframe
    this.iframe?.contentWindow?.postMessage({
      type: 'user_message',
      content,
      workerId,
    }, '*');
  }

  /**
   * Spawn a subworker in this agent's iframe (shares DOM with parent)
   */
  spawnSubworker(subworkerId: string, subConfig: AgentConfig, workerCode: string): void {
    // Track the subworker
    this.subworkers.set(subworkerId, {
      id: subworkerId,
      config: subConfig,
      createdAt: Date.now(),
      state: 'running',
    });

    this.iframe?.contentWindow?.postMessage({
      type: 'spawn_subworker',
      subworkerId,
      workerCode,
      config: subConfig,
    }, '*');
  }

  /**
   * Terminate a subworker
   */
  killSubworker(subworkerId: string): void {
    // Remove from tracking
    this.subworkers.delete(subworkerId);

    this.iframe?.contentWindow?.postMessage({
      type: 'kill_subworker',
      subworkerId,
    }, '*');
  }

  /**
   * Send hooks config to a specific subworker
   */
  sendSubworkerHooksConfig(subworkerId: string, activeHookTypes: string[]): void {
    this.iframe?.contentWindow?.postMessage({
      type: 'subworker_message',
      subworkerId,
      message: { type: 'hooks_config', activeHookTypes },
    }, '*');
  }

  /**
   * Get information about all active subworkers
   */
  getSubworkers(): SubworkerInfo[] {
    return Array.from(this.subworkers.values());
  }

  /**
   * Get the count of active subworkers
   */
  getSubworkerCount(): number {
    return this.subworkers.size;
  }

  /**
   * Pause a specific subworker
   */
  pauseSubworker(subworkerId: string): void {
    const info = this.subworkers.get(subworkerId);
    if (info) {
      info.state = 'paused';
    }
    this.iframe?.contentWindow?.postMessage({
      type: 'subworker_message',
      subworkerId,
      message: { type: 'pause' },
    }, '*');
  }

  /**
   * Stop a specific subworker
   */
  stopSubworker(subworkerId: string): void {
    const info = this.subworkers.get(subworkerId);
    if (info) {
      info.state = 'stopped';
    }
    this.iframe?.contentWindow?.postMessage({
      type: 'subworker_message',
      subworkerId,
      message: { type: 'stop_agent' },
    }, '*');
  }

  /**
   * Capture the current DOM state of the agent's viewport
   */
  async captureDomState(): Promise<SerializedDomState | null> {
    const contentWindow = this.iframe?.contentWindow;
    if (!contentWindow) {
      return null;
    }

    const id = generateRequestId('capture-dom');

    return new Promise((resolve) => {
      let resolved = false;

      const handler = (e: MessageEvent) => {
        if (resolved) return;
        if (e.source !== this.iframe?.contentWindow) return;
        if (e.data?.type === 'dom_state_captured' && e.data?.id === id) {
          resolved = true;
          clearTimeout(timeout);
          window.removeEventListener('message', handler);
          resolve(e.data.state || null);
        }
      };

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          window.removeEventListener('message', handler);
          resolve(null);
        }
      }, 5000);

      window.addEventListener('message', handler);
      contentWindow.postMessage({ type: 'capture_dom_state', id }, '*');
    });
  }

  /**
   * Set restoration context - called when restoring agent after page reload.
   * Notifies the iframe/worker of the restoration status.
   */
  setRestorationContext(ctx: RestorationContext): void {
    this.restorationContext = ctx;
    // Will be sent to iframe when it's ready (after start())
  }

  /**
   * Get the restoration context if this agent was restored
   */
  getRestorationContext(): RestorationContext | null {
    return this.restorationContext;
  }

  /**
   * Restore DOM state from a captured snapshot.
   * Called after agent start() to restore DOM from previous session.
   */
  async restoreDomState(state: SerializedDomState): Promise<void> {
    this.iframe?.contentWindow?.postMessage({
      type: 'restore_dom_state',
      state,
    }, '*');
  }

  /**
   * Send restoration context to iframe (called internally after init)
   */
  private sendRestorationContext(): void {
    if (this.restorationContext && this.iframe?.contentWindow) {
      this.iframe.contentWindow.postMessage({
        type: 'restoration_context',
        domRestored: this.restorationContext.domRestored,
      }, '*');
    }
  }

  onEvent(callback: EventCallback): () => void {
    this.eventCallbacks.push(callback);
    // Replay buffered conversation history for newly mounted views
    if (this.pendingConversationHistory) {
      const messages = this.pendingConversationHistory;
      // Use queueMicrotask to ensure the caller finishes setup before receiving events
      queueMicrotask(() => {
        callback({ type: 'conversation_history', messages } as any);
      });
    }
    return () => {
      const idx = this.eventCallbacks.indexOf(callback);
      if (idx >= 0) this.eventCallbacks.splice(idx, 1);
    };
  }

  getIframeElement(): HTMLIFrameElement | null {
    return this.iframe;
  }

  private emitEvent(event: AgentEvent): void {
    for (const cb of this.eventCallbacks) {
      cb(event);
    }
  }

  private handleIframeMessage = (e: MessageEvent): void => {
    if (e.source !== this.iframe?.contentWindow) return;
    const data = e.data;
    if (!data || data.agentId !== this.id) return;

    if (data.type === 'event' && data.event) {
      // Attach workerId to event so listeners can identify subworker events
      const event = data.event as AgentEvent & { workerId?: string };
      if (data.workerId && data.workerId !== 'main') {
        event.workerId = data.workerId;
      }
      // For hub-persisted agents, state comes from hub, not local worker
      if (event.type === 'state_change' && this._hubPersistInfo) {
        return;
      }
      this.emitEvent(event);
    } else if (data.type === 'request_view_state' && data.state) {
      // Agent is requesting a view state change (legacy - no id)
      // Validate state value at runtime (TypeScript types don't protect at runtime)
      const validStates = ['min', 'max', 'ui-only', 'chat-only'];
      if (!validStates.includes(data.state)) {
        console.warn(`[agent:${this.id}] Invalid view state requested: ${data.state}`);
        return;
      }
      if (this.viewStateRequestCallback) {
        this.viewStateRequestCallback(this.id, data.state);
      } else {
        // Auto-approve by default if no callback set
        this.setViewState(data.state, 'agent');
      }
    } else if (data.type === 'hub_page_event' && data.content) {
      // Route page events (flo.notify, flo.ask, dom_event, etc.) to hub
      if (this._hubPersistInfo && this.hubClient && this.hubConnectionId) {
        this.hubClient.sendAgentMessage(
          this.hubConnectionId,
          this._hubPersistInfo.hubAgentId,
          data.content,
        );
      }
      // If hub disconnected, silently drop (per architecture: no local fallback)
    } else if (data.type === 'notify_user') {
      this.emitEvent({ type: 'notify_user', message: data.message } as any);
    } else if (data.type === 'view_state_request' && data.id && data.state) {
      // Agent is requesting a view state change via tool (with request id)
      const validStates = ['min', 'max', 'ui-only', 'chat-only'];
      if (!validStates.includes(data.state)) {
        this.iframe?.contentWindow?.postMessage({
          type: 'view_state_response',
          id: data.id,
          success: false,
          error: `Invalid view state: ${data.state}`,
        }, '*');
        return;
      }
      // Apply the view state change
      this.setViewState(data.state, 'agent');
      // Send success response
      this.iframe?.contentWindow?.postMessage({
        type: 'view_state_response',
        id: data.id,
        success: true,
        state: data.state,
      }, '*');
    }
  };
}
