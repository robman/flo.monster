/**
 * Lightweight proxy representing a remote hub agent.
 * Provides enough interface for agent cards and dashboard display.
 */

import type { HubAgentSummary } from '@flo-monster/core';
import type { HubClient } from './hub-client.js';

export type HubAgentProxyCallback = (event: { type: string; data?: unknown }) => void;

export class HubAgentProxy {
  readonly hubAgentId: string;
  readonly hubConnectionId: string;
  agentName: string;
  model: string;
  provider: string;
  state: string;
  totalCost: number;
  createdAt: number;
  lastActivity: number;

  private callbacks = new Set<HubAgentProxyCallback>();

  constructor(
    summary: HubAgentSummary,
    private hubClient: HubClient,
    hubConnectionId: string,
  ) {
    this.hubAgentId = summary.hubAgentId;
    this.hubConnectionId = hubConnectionId;
    this.agentName = summary.agentName;
    this.model = summary.model;
    this.provider = summary.provider;
    this.state = summary.state;
    this.totalCost = summary.totalCost;
    this.createdAt = summary.createdAt;
    this.lastActivity = summary.lastActivity;
  }

  /**
   * Send an action to the hub agent (pause/resume/stop/kill)
   */
  async sendAction(action: 'pause' | 'resume' | 'stop' | 'kill'): Promise<void> {
    const conn = this.hubClient.getConnection(this.hubConnectionId);
    if (!conn?.connected) {
      throw new Error('Hub not connected');
    }
    this.hubClient.sendAgentAction(this.hubConnectionId, this.hubAgentId, action);
  }

  /**
   * Subscribe to events from this agent
   */
  subscribe(): void {
    this.hubClient.sendSubscribeAgent(this.hubConnectionId, this.hubAgentId);
  }

  /**
   * Unsubscribe from events
   */
  unsubscribe(): void {
    this.hubClient.sendUnsubscribeAgent(this.hubConnectionId, this.hubAgentId);
  }

  /**
   * Request to restore this agent's session locally
   */
  async restore(): Promise<unknown> {
    return this.hubClient.restoreAgent(this.hubConnectionId, this.hubAgentId);
  }

  /**
   * Update state from a hub event
   */
  updateState(newState: string): void {
    const oldState = this.state;
    this.state = newState;
    this.notifyCallbacks({ type: 'state_change', data: { from: oldState, to: newState } });
  }

  /**
   * Register callback for proxy events
   */
  onEvent(cb: HubAgentProxyCallback): () => void {
    this.callbacks.add(cb);
    return () => { this.callbacks.delete(cb); };
  }

  private notifyCallbacks(event: { type: string; data?: unknown }): void {
    for (const cb of this.callbacks) {
      try { cb(event); } catch { /* ignore */ }
    }
  }
}
