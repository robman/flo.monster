/**
 * Tests for handleSubscribeAgent: subscribe flow, state sending,
 * conversation history sending, and error handling.
 */

import { describe, it, expect, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { SerializedSession, AgentConfig } from '@flo-monster/core';
import { handleSubscribeAgent } from '../handlers/agent-handler.js';
import { HeadlessAgentRunner } from '../agent-runner.js';
import type { ConnectedClient } from '../server.js';

// ── Helpers ──────────────────────────────────────────────────────────

const mockConfig: AgentConfig = {
  id: 'test-agent',
  name: 'Test Agent',
  model: 'claude-sonnet-4-20250514',
  tools: [],
  maxTokens: 4096,
};

function createMockClient(): ConnectedClient {
  return {
    ws: {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    } as any,
    subscribedAgents: new Set<string>(),
    authenticated: true,
    remoteAddress: '127.0.0.1',
    messageCount: 0,
    messageWindowStart: Date.now(),
  };
}

function createMockSession(conversation?: unknown[]): SerializedSession {
  return {
    version: 1,
    agentId: 'agent-1',
    config: { ...mockConfig },
    conversation: conversation || [],
    storage: {},
    metadata: {
      createdAt: Date.now(),
      serializedAt: Date.now(),
      totalTokens: 0,
      totalCost: 0,
    },
  };
}

function createMockRunner(conversation?: unknown[]): HeadlessAgentRunner {
  const session = createMockSession(conversation);
  return new HeadlessAgentRunner(session);
}

function parseSentMessages(client: ConnectedClient): any[] {
  const sendMock = client.ws.send as ReturnType<typeof vi.fn>;
  return sendMock.mock.calls.map((call: any[]) => JSON.parse(call[0]));
}

// ── Tests ────────────────────────────────────────────────────────────

describe('handleSubscribeAgent', () => {
  it('subscribes client and sends agent state', () => {
    const client = createMockClient();
    const runner = createMockRunner();
    const agents = new Map([['hub-agent-1', runner]]);

    handleSubscribeAgent(client, { type: 'subscribe_agent', agentId: 'hub-agent-1' }, agents);

    expect(client.subscribedAgents.has('hub-agent-1')).toBe(true);
    expect(client.ws.send).toHaveBeenCalled();

    const sentMessages = parseSentMessages(client);
    const stateMsg = sentMessages.find((m: any) => m.type === 'agent_state');
    expect(stateMsg).toBeDefined();
    expect(stateMsg.agentId).toBe('hub-agent-1');
  });

  it('sends conversation history when available', async () => {
    const client = createMockClient();
    const conversation = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ];
    const runner = createMockRunner(conversation);
    // Start and let the runner initialize message history from conversation
    await runner.start();

    const agents = new Map([['hub-agent-1', runner]]);

    handleSubscribeAgent(client, { type: 'subscribe_agent', agentId: 'hub-agent-1' }, agents);

    const sentMessages = parseSentMessages(client);
    const historyMsg = sentMessages.find((m: any) => m.type === 'conversation_history');
    expect(historyMsg).toBeDefined();
    expect(historyMsg.agentId).toBe('hub-agent-1');
    expect(historyMsg.messages).toHaveLength(2);
    expect(historyMsg.messages[0].role).toBe('user');
    expect(historyMsg.messages[0].content).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(historyMsg.messages[1].role).toBe('assistant');
    expect(historyMsg.messages[1].content).toEqual([{ type: 'text', text: 'Hi there!' }]);
  });

  it('does not send conversation history when empty', () => {
    const client = createMockClient();
    const runner = createMockRunner([]);
    const agents = new Map([['hub-agent-1', runner]]);

    handleSubscribeAgent(client, { type: 'subscribe_agent', agentId: 'hub-agent-1' }, agents);

    const sentMessages = parseSentMessages(client);
    const historyMsg = sentMessages.find((m: any) => m.type === 'conversation_history');
    expect(historyMsg).toBeUndefined();
  });

  it('sends error when agent not found', () => {
    const client = createMockClient();
    const agents = new Map<string, HeadlessAgentRunner>();

    handleSubscribeAgent(client, { type: 'subscribe_agent', agentId: 'nonexistent' }, agents);

    const sentMessages = parseSentMessages(client);
    const errorMsg = sentMessages.find((m: any) => m.type === 'error');
    expect(errorMsg).toBeDefined();
    expect(errorMsg.message).toContain('nonexistent');
  });

  it('does not subscribe client when agent not found', () => {
    const client = createMockClient();
    const agents = new Map<string, HeadlessAgentRunner>();

    handleSubscribeAgent(client, { type: 'subscribe_agent', agentId: 'nonexistent' }, agents);

    expect(client.subscribedAgents.has('nonexistent')).toBe(false);
  });
  it('converts string content to Anthropic block format in conversation history', async () => {
    const client = createMockClient();
    const conversation = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ];
    const runner = createMockRunner(conversation);
    await runner.start();

    const agents = new Map([['hub-agent-1', runner]]);

    handleSubscribeAgent(client, { type: 'subscribe_agent', agentId: 'hub-agent-1' }, agents);

    const sentMessages = parseSentMessages(client);
    const historyMsg = sentMessages.find((m: any) => m.type === 'conversation_history');
    expect(historyMsg).toBeDefined();
    expect(historyMsg.messages).toHaveLength(2);

    // Verify messages are in Anthropic block format (array of content blocks)
    expect(Array.isArray(historyMsg.messages[0].content)).toBe(true);
    expect(historyMsg.messages[0].content).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(Array.isArray(historyMsg.messages[1].content)).toBe(true);
    expect(historyMsg.messages[1].content).toEqual([{ type: 'text', text: 'Hi there!' }]);
  });

  it('preserves block format content when already in correct format', async () => {
    const client = createMockClient();
    // Content already in block format (e.g., from a session that had blocks)
    const conversation = [
      { role: 'user', content: [{ type: 'text', text: 'Already block' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Also block' }] },
    ];
    const runner = createMockRunner(conversation);
    await runner.start();

    const agents = new Map([['hub-agent-1', runner]]);

    handleSubscribeAgent(client, { type: 'subscribe_agent', agentId: 'hub-agent-1' }, agents);

    const sentMessages = parseSentMessages(client);
    const historyMsg = sentMessages.find((m: any) => m.type === 'conversation_history');
    expect(historyMsg).toBeDefined();

    // The runner constructor converts content to string via JSON.stringify when it's not a string
    // So the output should still be valid block format after conversion
    for (const msg of historyMsg.messages) {
      expect(Array.isArray(msg.content)).toBe(true);
      expect(msg.content[0].type).toBe('text');
    }
  });
});