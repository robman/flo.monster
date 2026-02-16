/**
 * Routes browser-only tool calls from hub agents to connected browsers.
 * When a hub agent needs to call a tool that only works in the browser
 * (dom, runjs, storage, etc.), this router sends the request to a
 * subscribed browser client and waits for the result.
 */

import { randomUUID } from 'node:crypto';
import type { ConnectedClient } from './server.js';
import { sendWsMessage } from './utils/ws-utils.js';
import type { ToolResult } from './tools/index.js';

interface PendingToolRequest {
  resolve: (result: ToolResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class BrowserToolRouter {
  private pendingRequests = new Map<string, PendingToolRequest>();
  private lastActiveClients = new Map<string, ConnectedClient>();

  constructor(private clients: Set<ConnectedClient>) {}

  /**
   * Check if any browser is subscribed to this agent
   */
  isAvailable(hubAgentId: string): boolean {
    for (const client of this.clients) {
      if (client.authenticated && client.subscribedAgents.has(hubAgentId)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Record which browser client most recently interacted with an agent.
   * Used to prefer that client for subsequent tool routing.
   */
  setLastActiveClient(hubAgentId: string, client: ConnectedClient): void {
    this.lastActiveClients.set(hubAgentId, client);
  }

  /**
   * Get the last active client for an agent, if it's still valid.
   * A client is valid when it's still in the clients set, authenticated,
   * and subscribed to the agent. Invalid entries are cleaned up.
   */
  getLastActiveClient(hubAgentId: string): ConnectedClient | undefined {
    const client = this.lastActiveClients.get(hubAgentId);
    if (!client) return undefined;

    if (
      this.clients.has(client) &&
      client.authenticated &&
      client.subscribedAgents.has(hubAgentId)
    ) {
      return client;
    }

    // Client is no longer valid — clean up
    this.lastActiveClients.delete(hubAgentId);
    return undefined;
  }

  /**
   * Remove all last-active entries for a disconnected client.
   */
  removeClient(client: ConnectedClient): void {
    for (const [agentId, c] of this.lastActiveClients) {
      if (c === client) {
        this.lastActiveClients.delete(agentId);
      }
    }
  }

  /**
   * Route a tool call to a connected browser.
   * Resolves with ToolResult (never rejects -- returns error result on timeout/no browser).
   */
  async routeToBrowser(
    hubAgentId: string,
    toolName: string,
    input: Record<string, unknown>,
    timeoutMs = 30000,
  ): Promise<ToolResult> {
    // Prefer the last active client for this agent, fall back to any subscriber
    let targetClient: ConnectedClient | undefined = this.getLastActiveClient(hubAgentId);
    if (!targetClient) {
      for (const client of this.clients) {
        if (client.authenticated && client.subscribedAgents.has(hubAgentId)) {
          targetClient = client;
          break;
        }
      }
    }

    if (!targetClient) {
      return {
        content: `No browser connected for agent "${hubAgentId}". Tool "${toolName}" requires a connected browser with the agent's iframe.`,
        is_error: true,
      };
    }

    const id = randomUUID();

    return new Promise<ToolResult>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        resolve({
          content: `Browser tool request timed out after ${timeoutMs}ms for tool "${toolName}"`,
          is_error: true,
        });
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject: () => {}, timeout });

      sendWsMessage(targetClient!.ws, {
        type: 'browser_tool_request',
        id,
        hubAgentId,
        toolName,
        input,
      });
    });
  }

  /**
   * Handle a browser_tool_result message from a connected browser.
   */
  handleResult(id: string, result: { content: string; is_error?: boolean }): void {
    const pending = this.pendingRequests.get(id);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(id);
      pending.resolve(result);
    }
  }

  /**
   * Get number of pending requests (for testing)
   */
  get pendingCount(): number {
    return this.pendingRequests.size;
  }
}
