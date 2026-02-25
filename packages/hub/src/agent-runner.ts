/**
 * Headless agent runner for hub-side agent execution.
 * Wraps runAgenticLoop from core with state management.
 *
 * Supports two modes:
 * - Inert mode (no deps): State management only, no LLM calls. Used by tests and basic persistence.
 * - Active mode (with deps): Full agentic loop execution via runAgenticLoop.
 */

import type {
  SerializedSession,
  SerializedDomState,
  AgentConfig,
  AgentEvent,
  Message,
  ContentBlock,
  ProviderAdapter,
  TerseEntry,
} from '@flo-monster/core';
import { runAgenticLoop, extractTerseSummary, buildContextMessages, toApiMessage, compressBrowseResults } from '@flo-monster/core';
import type { LoopDeps } from '@flo-monster/core';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentStore } from './agent-store.js';
import type { ToolResult } from './tools/index.js';
import { HubAgentStateStore, type HubStateData } from './tools/hub-state.js';
import { HubAgentStorageStore } from './tools/hub-storage.js';
import { HubDomContainer } from './dom-container.js';

export type RunnerState = 'pending' | 'running' | 'paused' | 'stopped';

export interface RunnerEvent {
  type: 'state_change' | 'message' | 'error' | 'loop_complete' | 'notify_user';
  timestamp: number;
  data: unknown;
}

export interface RunnerDeps {
  sendApiRequest: (body: string, headers: Record<string, string>, url: string) => AsyncIterable<string>;
  executeToolCall: (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
  adapter: ProviderAdapter;
  agentStore?: AgentStore;
  hubAgentId?: string;
  /** Additional tool definitions to inject for the LLM (hub-native tools like bash, filesystem, schedule) */
  hubToolDefs?: Array<{ name: string; description: string; input_schema: { type: 'object'; properties: Record<string, unknown>; required: readonly string[] } }>;
  /** Root directory for agent files (for writing context.json after each turn) */
  filesRoot?: string;
}

export class HeadlessAgentRunner {
  private _state: RunnerState = 'pending';
  private eventCallbacks: ((event: RunnerEvent) => void)[] = [];
  private agentEventCallbacks: ((event: AgentEvent) => void)[] = [];
  private messageHistory: Array<{ role?: 'user' | 'assistant'; type?: string; content: ContentBlock[]; timestamp: number; turnId?: string }> = [];
  private terseLog: TerseEntry[] = [];
  private nextTurnId = 1;
  private createdAt: number;
  private totalTokens = 0;
  private totalCost = 0;
  private _busy = false;
  private _messageQueue: Array<{ message: string; type?: string }> = [];
  private _pauseRequested = false;
  private _intervenePaused = false;
  private _stopRequested = false;
  private deps?: RunnerDeps;
  private domState?: SerializedDomState;
  private domContainer?: HubDomContainer;
  private stateStore?: HubAgentStateStore;
  private storageStore: HubAgentStorageStore;

  constructor(private session: SerializedSession, deps?: RunnerDeps) {
    this.createdAt = session.metadata.createdAt;
    this.totalTokens = session.metadata.totalTokens;
    this.totalCost = session.metadata.totalCost;
    this.deps = deps;

    // Load DOM state from session if available
    if ((session as any).domState) {
      this.domState = (session as any).domState;
    }

    // Create DOM container from existing DOM state
    if (this.domState) {
      this.domContainer = new HubDomContainer(this.domState);
    }

    // Load state store from session storage __flo_state
    if (session.storage && typeof session.storage === 'object') {
      const storage = session.storage as Record<string, unknown>;
      if (storage.__flo_state) {
        try {
          const stateData = typeof storage.__flo_state === 'string'
            ? JSON.parse(storage.__flo_state) as HubStateData
            : storage.__flo_state as HubStateData;
          if (stateData && typeof stateData === 'object' && stateData.state) {
            this.stateStore = new HubAgentStateStore(stateData);
          }
        } catch {
          // Ignore parse errors for state data
        }
      }
    }
    // Always create a state store (empty if no existing data)
    if (!this.stateStore) {
      this.stateStore = new HubAgentStateStore();
    }

    // Load storage store from session storage (all keys except __flo_state)
    if (session.storage && typeof session.storage === 'object') {
      const storageData: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(session.storage as Record<string, unknown>)) {
        if (key !== '__flo_state') {
          storageData[key] = value;
        }
      }
      this.storageStore = new HubAgentStorageStore(storageData);
    } else {
      this.storageStore = new HubAgentStorageStore();
    }

    // Load terse log from session storage
    if (session.storage && typeof session.storage === 'object') {
      const storage = session.storage as Record<string, unknown>;
      if (storage.__flo_terse) {
        try {
          const terseData = typeof storage.__flo_terse === 'string'
            ? JSON.parse(storage.__flo_terse)
            : storage.__flo_terse;
          if (terseData && typeof terseData === 'object') {
            if (Array.isArray(terseData)) {
              // Migration: old array format
              this.terseLog = (terseData as any[]).map((e, i) => ({
                ts: e.ts,
                turnId: e.turnId || `t${i + 1}`,
                role: e.role,
                summary: e.summary,
              }));
              this.nextTurnId = this.terseLog.length + 1;
            } else if (terseData.entries) {
              this.terseLog = terseData.entries;
              this.nextTurnId = terseData.nextTurnId || this.terseLog.length + 1;
            }
          }
        } catch {
          // Ignore parse errors for terse data
        }
      }
    }

    // Load any existing messages from session
    if (session.conversation && Array.isArray(session.conversation)) {
      for (const msg of session.conversation) {
        if (msg && typeof msg === 'object') {
          const m = msg as Record<string, unknown>;

          let content: ContentBlock[];
          if (typeof m.content === 'string') {
            content = m.content ? [{ type: 'text' as const, text: m.content }] : [];
          } else if (Array.isArray(m.content)) {
            content = m.content as ContentBlock[];
          } else {
            content = [{ type: 'text' as const, text: String(m.content) }];
          }

          // Skip empty messages
          if (content.length === 0) continue;

          if (m.role === 'system') {
            // Legacy: role:'system' → type:'announcement' (no role)
            this.messageHistory.push({
              type: 'announcement',
              content,
              timestamp: this.createdAt,
            });
          } else if (m.role === 'user' || m.role === 'assistant') {
            this.messageHistory.push({
              role: m.role as 'user' | 'assistant',
              content,
              timestamp: this.createdAt,
              ...(m.type ? { type: m.type as string } : {}),
              ...(m.turnId ? { turnId: m.turnId as string } : {}),
            });
          } else if (m.type) {
            // New format: no role, has type (e.g. announcements)
            this.messageHistory.push({
              type: m.type as string,
              content,
              timestamp: this.createdAt,
            });
          }
        }
      }
    }
  }

  /**
   * Get the current state
   */
  get state(): RunnerState {
    return this._state;
  }

  /**
   * Whether the runner is currently executing an agentic loop
   */
  get busy(): boolean {
    return this._busy;
  }

  /**
   * Whether the runner is currently paused due to user intervention.
   */
  get isIntervenePaused(): boolean {
    return this._intervenePaused;
  }

  /**
   * Get the agent ID
   */
  get agentId(): string {
    return this.session.agentId;
  }

  /**
   * Get the agent config
   */
  get config(): AgentConfig {
    return this.session.config;
  }

  /**
   * Start the agent runner. Transitions to 'running' (ready for messages).
   */
  async start(): Promise<void> {
    if (this._state !== 'pending') {
      throw new Error(`Cannot start runner in state: ${this._state}`);
    }
    this.setState('running');
  }

  /**
   * Pause the agent runner. If a loop is active, it will stop after the current turn.
   */
  pause(): void {
    if (this._state !== 'running') return;
    this._pauseRequested = true;
    if (!this._busy) {
      this.setState('paused');
    }
    // If busy, the loop's executeToolCall wrapper checks _pauseRequested
    // and the finally block will transition to paused after the loop ends.
  }

  /**
   * Resume a paused runner.
   */
  resume(): void {
    if (this._state !== 'paused') return;
    this._pauseRequested = false;
    this.setState('running');
  }

  /**
   * Pause the runner for user intervention.
   * Sets a distinct flag so interveneEnd() knows it was an intervention pause.
   */
  interveneStart(): void {
    this._intervenePaused = true;
    this.pause();
  }

  /**
   * End user intervention: clear the flag, emit to browsers, queue notification, and resume.
   * If the runner was manually paused (not via interveneStart), this is a no-op.
   */
  interveneEnd(notification: string): void {
    if (!this._intervenePaused) return;
    this._intervenePaused = false;

    this.resume();

    // Emit the intervention message so browsers can render it in the chat panel
    this.emitEvent({
      type: 'message',
      timestamp: Date.now(),
      data: { role: 'user', content: notification, messageType: 'intervention' },
    });

    if (!this._busy && this.deps) {
      this._runLoop(notification, 'intervention').catch(err => {
        console.error('[HeadlessAgentRunner] Loop error:', err);
        this._busy = false;
      });
    } else {
      // If busy, queue it for when the current loop ends
      this._messageQueue.push({ message: notification, type: 'intervention' });
    }
  }

  /**
   * Stop the runner gracefully. If a loop is active, waits for current turn to finish.
   */
  stop(): void {
    if (this._state !== 'running' && this._state !== 'paused') return;
    this._stopRequested = true;
    if (!this._busy) {
      this.setState('stopped');
    }
    // If busy, the finally block will transition to stopped after the loop ends.
  }

  /**
   * Forcefully kill the runner. Clears all callbacks.
   */
  kill(): void {
    this._stopRequested = true;
    this._pauseRequested = false;
    this.setState('stopped');
    this.eventCallbacks = [];
    this.agentEventCallbacks = [];
    if (this.domContainer) {
      this.domContainer.destroy();
      this.domContainer = undefined;
    }
  }

  /**
   * Send a user message to the agent.
   * In active mode (deps provided), triggers runAgenticLoop.
   * In inert mode, just stores the message.
   */
  sendMessage(content: string): void {
    if (this._state !== 'running') {
      throw new Error(`Cannot send message in state: ${this._state}`);
    }

    if (this._busy) {
      this._messageQueue.push({ message: content });
      this.emitEvent({
        type: 'message',
        timestamp: Date.now(),
        data: { role: 'user', content },
      });
      return;
    }

    const timestamp = Date.now();

    // Emit message event
    this.emitEvent({
      type: 'message',
      timestamp,
      data: { role: 'user', content },
    });

    if (this.deps) {
      // Active mode: run the agentic loop
      this._runLoop(content).catch(err => {
        console.error('[HeadlessAgentRunner] Loop error:', err);
        this.emitEvent({
          type: 'error',
          timestamp: Date.now(),
          data: { error: String(err) },
        });
        this._busy = false;
      });
    } else {
      // Inert mode: just store the message
      this.messageHistory.push({
        role: 'user',
        content: [{ type: 'text' as const, text: content }],
        timestamp,
      });
    }
  }

  /**
   * Queue a message for processing after the current loop completes.
   * If not busy, uses sendMessage() directly.
   */
  queueMessage(content: string): void {
    if (this._busy) {
      this._messageQueue.push({ message: content });
    } else {
      this.sendMessage(content);
    }
  }

  /**
   * Emit a runner event to all registered event callbacks.
   * Used by hub-runjs flo.notify_user() to trigger push notifications
   * via the event forwarding system.
   */
  emitRunnerEvent(event: RunnerEvent): void {
    this.emitEvent(event);
  }

  /**
   * Get the current state string
   */
  getState(): RunnerState {
    return this._state;
  }

  /**
   * Get message history
   */
  getMessageHistory(): Array<{ role?: 'user' | 'assistant'; type?: string; content: ContentBlock[]; timestamp: number; turnId?: string }> {
    return [...this.messageHistory];
  }

  /**
   * Get the terse log entries
   */
  getTerseLog(): TerseEntry[] {
    return [...this.terseLog];
  }

  /**
   * Add a UI-only info message to the conversation log.
   * These are visible in chat and admin log but NOT sent to the LLM.
   */
  addInfoMessage(text: string): void {
    this.messageHistory.push({
      type: 'announcement',
      content: [{ type: 'text' as const, text }],
      timestamp: Date.now(),
    });
  }

  /**
   * Get the state store for this agent
   */
  getStateStore(): HubAgentStateStore {
    return this.stateStore!;
  }

  /**
   * Get the storage store for this agent
   */
  getStorageStore(): HubAgentStorageStore {
    return this.storageStore;
  }

  /**
   * Get last known DOM state — prefers container's live state over cached domState
   */
  getDomState(): SerializedDomState | undefined {
    if (this.domContainer) {
      return this.domContainer.getState();
    }
    return this.domState;
  }

  /**
   * Set DOM state (from browser sync)
   */
  setDomState(state: SerializedDomState): void {
    this.domState = state;
    if (this.domContainer) {
      this.domContainer.restore(state);
    }
  }

  /**
   * Get the DOM container for hub-side operations
   */
  getDomContainer(): HubDomContainer | undefined {
    return this.domContainer;
  }

  /**
   * Register an event callback for RunnerEvents (state_change, message, error).
   * Returns an unsubscribe function.
   */
  onEvent(cb: (event: RunnerEvent) => void): () => void {
    this.eventCallbacks.push(cb);
    return () => {
      const idx = this.eventCallbacks.indexOf(cb);
      if (idx >= 0) this.eventCallbacks.splice(idx, 1);
    };
  }

  /**
   * Register a callback for AgentEvents from the agentic loop
   * (text_delta, tool_use_done, usage, turn_end, etc.).
   * Returns an unsubscribe function.
   */
  onAgentEvent(cb: (event: AgentEvent) => void): () => void {
    this.agentEventCallbacks.push(cb);
    return () => {
      const idx = this.agentEventCallbacks.indexOf(cb);
      if (idx >= 0) this.agentEventCallbacks.splice(idx, 1);
    };
  }

  /**
   * Serialize the current state back to a session
   */
  serialize(): SerializedSession {
    // Convert message history back to conversation format (include turnId)
    const conversation = this.messageHistory.map(msg => ({
      ...(msg.role ? { role: msg.role } : {}),
      ...(msg.type ? { type: msg.type } : {}),
      content: msg.content,
      ...(msg.turnId ? { turnId: msg.turnId } : {}),
    }));

    const result: SerializedSession = {
      version: this.session.version || 1,
      agentId: this.session.agentId,
      config: this.session.config,
      conversation,
      storage: this.session.storage,
      files: this.session.files,
      subagents: this.session.subagents,
      metadata: {
        createdAt: this.createdAt,
        serializedAt: Date.now(),
        totalTokens: this.totalTokens,
        totalCost: this.totalCost,
      },
    };

    // Include DOM state - prefer container's live state over cached domState
    if (this.domContainer) {
      (result as any).domState = this.domContainer.getState();
    } else if (this.domState) {
      (result as any).domState = this.domState;
    }

    // Sync terse log to storage
    if (this.terseLog.length > 0 || this.nextTurnId > 1) {
      if (!result.storage || typeof result.storage !== 'object') {
        result.storage = {};
      }
      (result.storage as Record<string, unknown>).__flo_terse = JSON.stringify({
        entries: this.terseLog,
        nextTurnId: this.nextTurnId,
      });
    }

    // Sync state store back to storage
    if (this.stateStore) {
      if (!result.storage || typeof result.storage !== 'object') {
        result.storage = {};
      }
      (result.storage as Record<string, unknown>).__flo_state = JSON.stringify(this.stateStore.serialize());
    }

    // Sync storage store back to storage
    if (this.storageStore) {
      if (!result.storage || typeof result.storage !== 'object') {
        result.storage = {};
      }
      const storageData = this.storageStore.serialize();
      for (const [key, value] of Object.entries(storageData)) {
        (result.storage as Record<string, unknown>)[key] = value;
      }
    }

    return result;
  }

  /**
   * Update usage metrics
   */
  updateUsage(tokens: number, cost: number): void {
    this.totalTokens += tokens;
    this.totalCost += cost;
  }

  /**
   * Set the runner deps after construction (used when restoring from disk).
   */
  setDeps(deps: RunnerDeps): void {
    this.deps = deps;
  }

  // ── Private methods ──────────────────────────────────────────────────

  /**
   * Run the agentic loop for a new user message.
   * This is async and runs in the background after sendMessage returns.
   */
  private async _runLoop(userMessage: string, messageType?: string): Promise<void> {
    if (!this.deps) return;
    this._busy = true;
    this._stopRequested = false;
    this._pauseRequested = false;

    // Generate turn ID for this turn
    const turnId = `t${this.nextTurnId++}`;

    // Build context messages using unified strategy
    const contextMode = this.session.config.contextMode ?? 'slim';
    const fullContextTurns = this.session.config.fullContextTurns ?? 3;

    const existingMessages = this.buildContextForLoop(contextMode, fullContextTurns);

    const loopDeps: LoopDeps = {
      sendApiRequest: this.deps.sendApiRequest,
      executeToolCall: async (name: string, input: Record<string, unknown>) => {
        // Check stop/pause before executing tool
        if (this._stopRequested) {
          return { content: 'Agent stopped', is_error: true };
        }
        if (this._pauseRequested) {
          return { content: 'Agent paused', is_error: true };
        }
        return this.deps!.executeToolCall(name, input);
      },
      emit: (event: AgentEvent) => {
        // Forward agent events to subscribers
        this.emitAgentEvent(event);

        // Track usage
        if (event.type === 'usage') {
          if (event.cost) {
            this.totalCost = event.cost.totalCost;
          }
          if (event.usage) {
            this.totalTokens = event.usage.input_tokens + event.usage.output_tokens;
          }
        }
      },
      adapter: this.deps.adapter,
    };

    // Augment config with hub tool definitions so the LLM knows about them
    // Deduplicate by name — browser tools take precedence over hub tools
    let loopConfig = this.session.config;
    if (this.deps.hubToolDefs && this.deps.hubToolDefs.length > 0) {
      const existingNames = new Set(this.session.config.tools.map(t => t.name));
      const newHubTools = (this.deps.hubToolDefs as typeof this.session.config.tools)
        .filter(t => !existingNames.has(t.name));
      if (newHubTools.length > 0) {
        loopConfig = { ...this.session.config, tools: [...this.session.config.tools, ...newHubTools] };
      }
    }

    try {
      const finalMessages = await runAgenticLoop(
        loopConfig,
        userMessage,
        loopDeps,
        existingMessages,
      );

      // The loop returns the full message array including existingMessages + new messages.
      // We need to identify which messages are new (from this turn) vs existing.
      const existingCount = existingMessages.length;
      const timestamp = Date.now();

      // Rebuild messageHistory: keep existing messages with their turnIds, add new ones with current turnId
      const newHistory: typeof this.messageHistory = [];

      // Add back existing messages from our stored history (preserving turnIds and system messages)
      // The existingMessages we sent to the loop were derived from messageHistory (minus system msgs),
      // so we keep our original messageHistory entries and only append NEW messages from the loop.
      for (const msg of this.messageHistory) {
        newHistory.push(msg);
      }

      // Append new messages from the loop (those beyond existingCount)
      const newMessages = finalMessages.slice(existingCount);
      for (let i = 0; i < newMessages.length; i++) {
        const msg = newMessages[i];
        newHistory.push({
          role: msg.role,
          content: msg.content,
          timestamp,
          turnId,
          ...(i === 0 && messageType ? { type: messageType } : {}),
        });
      }

      this.messageHistory = newHistory;

      // Extract terse summary from last assistant message
      const lastAssistant = newMessages.filter(m => m.role === 'assistant').pop();
      if (lastAssistant) {
        const terseSummary = extractTerseSummary({ role: 'assistant', content: lastAssistant.content } as Record<string, unknown>);
        if (terseSummary) {
          this.terseLog.push({ ts: timestamp, turnId, role: 'assistant', summary: terseSummary });
        }
      }
    } catch (err) {
      this.emitEvent({
        type: 'error',
        timestamp: Date.now(),
        data: { error: String(err) },
      });
    } finally {
      this._busy = false;

      // Save to disk after loop completes
      await this.persistToDisk();

      // Handle deferred pause/stop, or drain message queue
      if (this._stopRequested) {
        this._messageQueue = [];
        this.setState('stopped');
      } else if (this._pauseRequested) {
        this._messageQueue = [];
        this.setState('paused');
      } else if (this._messageQueue.length > 0) {
        const next = this._messageQueue.shift()!;
        this._runLoop(next.message, next.type).catch(err => {
          console.error('[HeadlessAgentRunner] Loop error:', err);
          this.emitEvent({ type: 'error', timestamp: Date.now(), data: { error: String(err) } });
          this._busy = false;
        });
      } else {
        // Emit loop_complete (not a state change) to signal agentic loop finished
        this.emitEvent({ type: 'loop_complete', timestamp: Date.now(), data: {} });
      }
    }
  }

  /**
   * Build context messages for the agentic loop using the unified context strategy.
   * In 'slim' mode: terse log + last K full turns.
   * In 'full' mode: all messages (current behavior).
   */
  private buildContextForLoop(contextMode: 'slim' | 'full', fullContextTurns: number): Message[] {
    // Filter announcements (no role) but pass all other fields through —
    // buildContextMessages needs turnId for turn selection, and toApiMessage
    // strips everything except API fields at the end.
    const nonSystemMessages = this.messageHistory
      .filter(msg => msg.role != null)
      .map(msg => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
        turnId: msg.turnId,
      }));

    // If no messages have turnIds (pre-migration conversation), fall back to full mode
    // to avoid sending zero context to the LLM
    const hasTurnIds = nonSystemMessages.some(m => m.turnId);
    const effectiveMode = (!hasTurnIds && this.terseLog.length === 0) ? 'full' : contextMode;

    const rawContextMessages = buildContextMessages(
      this.terseLog,
      nonSystemMessages as Array<Record<string, unknown>>,
      { contextMode: effectiveMode, maxTerseEntries: 50, fullContextTurns },
    );
    // Compress stale browse accessibility trees — only the latest tree is actionable
    const contextMessages = compressBrowseResults(rawContextMessages as Array<Record<string, unknown>>);

    // Allowlist: only API fields pass through. Same allowlist used by browser api-handler.
    return contextMessages.map(m => {
      const clean = toApiMessage(m);
      return {
        role: clean.role as 'user' | 'assistant',
        content: Array.isArray(clean.content)
          ? clean.content as ContentBlock[]
          : [{ type: 'text' as const, text: String(clean.content) }],
      };
    });
  }

  /**
   * Persist current state to disk via AgentStore if available.
   */
  private async persistToDisk(): Promise<void> {
    if (!this.deps?.agentStore || !this.deps.hubAgentId) return;
    try {
      await this.deps.agentStore.save(this.deps.hubAgentId, this.serialize(), {
        state: this._state,
        totalTokens: this.totalTokens,
        totalCost: this.totalCost,
        savedAt: Date.now(),
      });

      // Write context.json to files directory (matches browser behavior)
      if (this.deps.filesRoot) {
        try {
          await mkdir(this.deps.filesRoot, { recursive: true });
          const messages = this.messageHistory.map(m => ({
            ...(m.role ? { role: m.role } : {}),
            ...(m.type ? { type: m.type } : {}),
            content: m.content,
            ...(m.turnId ? { turnId: m.turnId } : {}),
          }));
          await writeFile(join(this.deps.filesRoot, 'context.json'), JSON.stringify(messages), 'utf-8');
        } catch (err) {
          console.warn('[HeadlessAgentRunner] Failed to write context.json:', err);
        }
      }
    } catch (err) {
      console.warn('[HeadlessAgentRunner] Failed to save after loop:', err);
    }
  }

  private setState(newState: RunnerState): void {
    const oldState = this._state;
    this._state = newState;

    this.emitEvent({
      type: 'state_change',
      timestamp: Date.now(),
      data: { from: oldState, to: newState },
    });
  }

  private emitEvent(event: RunnerEvent): void {
    for (const cb of this.eventCallbacks) {
      try {
        cb(event);
      } catch (err) {
        console.error('[HeadlessAgentRunner] Event callback error:', err);
      }
    }
  }

  private emitAgentEvent(event: AgentEvent): void {
    for (const cb of this.agentEventCallbacks) {
      try {
        cb(event);
      } catch (err) {
        console.error('[HeadlessAgentRunner] Agent event callback error:', err);
      }
    }
  }
}
