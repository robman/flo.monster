/**
 * Integration tests for multi-browser support:
 * - User actions track last-active client
 * - Tool results do NOT change last-active
 * - End-to-end: user moves between browsers, tool routing follows
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocket } from 'ws';
import type { ConnectedClient } from '../server.js';
import type { AgentConfig, SerializedSession } from '@flo-monster/core';
import { BrowserToolRouter } from '../browser-tool-router.js';
import { HeadlessAgentRunner } from '../agent-runner.js';
import { handleMessage } from '../handlers/message-handler.js';
import { getDefaultConfig } from '../config.js';

// Mock sendWsMessage to prevent real WebSocket calls
vi.mock('../utils/ws-utils.js', () => ({
  sendWsMessage: vi.fn(),
  parseWsMessage: vi.fn(),
}));

// ── Helpers ──────────────────────────────────────────────────────────

const mockConfig: AgentConfig = {
  id: 'test-agent',
  name: 'Test Agent',
  model: 'claude-sonnet-4-20250514',
  tools: [],
  maxTokens: 4096,
};

function createMockSession(): SerializedSession {
  return {
    version: 1,
    agentId: 'agent-123',
    config: mockConfig,
    conversation: [],
    storage: {},
    metadata: {
      createdAt: 1000,
      serializedAt: 2000,
      totalTokens: 100,
      totalCost: 0.01,
    },
  };
}

function createMockClient(overrides?: Partial<ConnectedClient>): ConnectedClient {
  return {
    ws: { send: vi.fn(), readyState: WebSocket.OPEN } as any,
    authenticated: true,
    remoteAddress: '127.0.0.1',
    subscribedAgents: new Set(),
    messageCount: 0,
    messageWindowStart: Date.now(),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Multi-browser support', () => {
  let clients: Set<ConnectedClient>;
  let agents: Map<string, HeadlessAgentRunner>;
  let browserToolRouter: BrowserToolRouter;
  const hubAgentId = 'hub-test-agent-1000';
  const hubConfig = getDefaultConfig();

  beforeEach(async () => {
    clients = new Set();
    agents = new Map();
    browserToolRouter = new BrowserToolRouter(clients);
    vi.clearAllMocks();

    // Create a running agent
    const runner = new HeadlessAgentRunner(createMockSession());
    await runner.start();
    agents.set(hubAgentId, runner);
  });

  describe('last-active tracking via handleMessage', () => {
    it('send_message records last active client', async () => {
      const clientA = createMockClient();
      clientA.subscribedAgents.add(hubAgentId);
      clients.add(clientA);

      const clientB = createMockClient();
      clientB.subscribedAgents.add(hubAgentId);
      clients.add(clientB);

      // clientB sends a message
      await handleMessage(
        clientB,
        { type: 'send_message', agentId: hubAgentId, content: 'Hello' } as any,
        hubConfig,
        agents,
        clients,
        undefined, // hookExecutor
        undefined, // skillManager
        undefined, // agentStore
        browserToolRouter,
      );

      expect(browserToolRouter.getLastActiveClient(hubAgentId)).toBe(clientB);
    });

    it('agent_action records last active client', async () => {
      const clientA = createMockClient();
      clientA.subscribedAgents.add(hubAgentId);
      clients.add(clientA);

      const clientB = createMockClient();
      clientB.subscribedAgents.add(hubAgentId);
      clients.add(clientB);

      // clientA sends an action
      await handleMessage(
        clientA,
        { type: 'agent_action', agentId: hubAgentId, action: 'pause' } as any,
        hubConfig,
        agents,
        clients,
        undefined,
        undefined,
        undefined,
        browserToolRouter,
      );

      expect(browserToolRouter.getLastActiveClient(hubAgentId)).toBe(clientA);
    });

    it('browser_tool_result does NOT change last active', async () => {
      const clientA = createMockClient();
      clientA.subscribedAgents.add(hubAgentId);
      clients.add(clientA);

      const clientB = createMockClient();
      clientB.subscribedAgents.add(hubAgentId);
      clients.add(clientB);

      // Set clientA as last active
      browserToolRouter.setLastActiveClient(hubAgentId, clientA);

      // clientB sends a browser_tool_result
      await handleMessage(
        clientB,
        { type: 'browser_tool_result', id: 'btr-1-1000', result: { content: 'ok' } } as any,
        hubConfig,
        agents,
        clients,
        undefined,
        undefined,
        undefined,
        browserToolRouter,
      );

      // Last active should still be clientA
      expect(browserToolRouter.getLastActiveClient(hubAgentId)).toBe(clientA);
    });
  });

  describe('end-to-end: user moves between browsers', () => {
    it('tool routing follows the active browser', async () => {
      const clientA = createMockClient();
      clientA.subscribedAgents.add(hubAgentId);
      clients.add(clientA);

      const clientB = createMockClient();
      clientB.subscribedAgents.add(hubAgentId);
      clients.add(clientB);

      // User acts from Browser A
      await handleMessage(
        clientA,
        { type: 'send_message', agentId: hubAgentId, content: 'Hello from A' } as any,
        hubConfig,
        agents,
        clients,
        undefined,
        undefined,
        undefined,
        browserToolRouter,
      );

      // Tool routing should prefer clientA
      expect(browserToolRouter.getLastActiveClient(hubAgentId)).toBe(clientA);

      // User moves to Browser B and acts
      await handleMessage(
        clientB,
        { type: 'send_message', agentId: hubAgentId, content: 'Hello from B' } as any,
        hubConfig,
        agents,
        clients,
        undefined,
        undefined,
        undefined,
        browserToolRouter,
      );

      // Tool routing should now prefer clientB
      expect(browserToolRouter.getLastActiveClient(hubAgentId)).toBe(clientB);
    });
  });
});
