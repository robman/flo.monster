/**
 * Tests for BrowserToolRouter: routing browser-only tool calls
 * from hub agents to connected browser clients.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { BrowserToolRouter } from '../browser-tool-router.js';
import type { ConnectedClient } from '../server.js';

// Mock sendWsMessage so we can inspect what's sent
vi.mock('../utils/ws-utils.js', () => ({
  sendWsMessage: vi.fn(),
}));

import { sendWsMessage } from '../utils/ws-utils.js';

const mockedSendWsMessage = vi.mocked(sendWsMessage);

// ── Helpers ──────────────────────────────────────────────────────────

function createMockClient(overrides?: Partial<ConnectedClient>): ConnectedClient {
  return {
    id: 'test-client-id',
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

describe('BrowserToolRouter', () => {
  let clients: Set<ConnectedClient>;
  let router: BrowserToolRouter;

  beforeEach(() => {
    clients = new Set();
    router = new BrowserToolRouter(clients);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isAvailable', () => {
    it('returns false when no clients', () => {
      expect(router.isAvailable('hub-agent-1')).toBe(false);
    });

    it('returns false when client is not subscribed to agent', () => {
      const client = createMockClient();
      clients.add(client);
      expect(router.isAvailable('hub-agent-1')).toBe(false);
    });

    it('returns false when client is not authenticated', () => {
      const client = createMockClient({ authenticated: false });
      client.subscribedAgents.add('hub-agent-1');
      clients.add(client);
      expect(router.isAvailable('hub-agent-1')).toBe(false);
    });

    it('returns true when authenticated client is subscribed', () => {
      const client = createMockClient();
      client.subscribedAgents.add('hub-agent-1');
      clients.add(client);
      expect(router.isAvailable('hub-agent-1')).toBe(true);
    });

    it('returns true when one of multiple clients is subscribed', () => {
      const client1 = createMockClient();
      clients.add(client1);

      const client2 = createMockClient();
      client2.subscribedAgents.add('hub-agent-1');
      clients.add(client2);

      expect(router.isAvailable('hub-agent-1')).toBe(true);
    });
  });

  describe('setLastActiveClient / getLastActiveClient', () => {
    it('basic round-trip: set then get returns the client', () => {
      const client = createMockClient();
      client.subscribedAgents.add('hub-agent-1');
      clients.add(client);

      router.setLastActiveClient('hub-agent-1', client);
      expect(router.getLastActiveClient('hub-agent-1')).toBe(client);
    });

    it('returns undefined for unknown agent', () => {
      expect(router.getLastActiveClient('hub-agent-unknown')).toBeUndefined();
    });

    it('returns undefined when client removed from clients Set', () => {
      const client = createMockClient();
      client.subscribedAgents.add('hub-agent-1');
      clients.add(client);

      router.setLastActiveClient('hub-agent-1', client);
      clients.delete(client);

      expect(router.getLastActiveClient('hub-agent-1')).toBeUndefined();
      // Entry should be cleaned up — second get also returns undefined
      expect(router.getLastActiveClient('hub-agent-1')).toBeUndefined();
    });

    it('returns undefined when client is no longer authenticated', () => {
      const client = createMockClient();
      client.subscribedAgents.add('hub-agent-1');
      clients.add(client);

      router.setLastActiveClient('hub-agent-1', client);
      client.authenticated = false;

      expect(router.getLastActiveClient('hub-agent-1')).toBeUndefined();
      // Entry should be cleaned up
      expect(router.getLastActiveClient('hub-agent-1')).toBeUndefined();
    });

    it('returns undefined when client is no longer subscribed to agent', () => {
      const client = createMockClient();
      client.subscribedAgents.add('hub-agent-1');
      clients.add(client);

      router.setLastActiveClient('hub-agent-1', client);
      client.subscribedAgents.delete('hub-agent-1');

      expect(router.getLastActiveClient('hub-agent-1')).toBeUndefined();
      // Entry should be cleaned up
      expect(router.getLastActiveClient('hub-agent-1')).toBeUndefined();
    });
  });

  describe('removeClient', () => {
    it('removes all entries for a disconnected client', () => {
      const client = createMockClient();
      client.subscribedAgents.add('hub-agent-1');
      client.subscribedAgents.add('hub-agent-2');
      clients.add(client);

      router.setLastActiveClient('hub-agent-1', client);
      router.setLastActiveClient('hub-agent-2', client);

      router.removeClient(client);

      expect(router.getLastActiveClient('hub-agent-1')).toBeUndefined();
      expect(router.getLastActiveClient('hub-agent-2')).toBeUndefined();
    });

    it('does not affect entries for other clients', () => {
      const client1 = createMockClient();
      client1.subscribedAgents.add('hub-agent-1');
      clients.add(client1);

      const client2 = createMockClient();
      client2.subscribedAgents.add('hub-agent-2');
      clients.add(client2);

      router.setLastActiveClient('hub-agent-1', client1);
      router.setLastActiveClient('hub-agent-2', client2);

      router.removeClient(client1);

      expect(router.getLastActiveClient('hub-agent-1')).toBeUndefined();
      expect(router.getLastActiveClient('hub-agent-2')).toBe(client2);
    });
  });

  describe('routeToBrowser', () => {
    it('returns error when no browser connected', async () => {
      const result = await router.routeToBrowser('hub-agent-1', 'dom', { action: 'create' });

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('No browser connected');
      expect(result.content).toContain('hub-agent-1');
      expect(result.content).toContain('dom');
    });

    it('returns error when client not subscribed to agent', async () => {
      const client = createMockClient();
      clients.add(client);

      const result = await router.routeToBrowser('hub-agent-1', 'dom', { action: 'create' });

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('No browser connected');
    });

    it('sends message to correct client', async () => {
      const client = createMockClient();
      client.subscribedAgents.add('hub-agent-1');
      clients.add(client);

      // Start the routing but don't await — it will be pending until we resolve it
      const resultPromise = router.routeToBrowser('hub-agent-1', 'dom', { action: 'create', html: '<p>test</p>' });

      // Verify the message was sent via sendWsMessage
      expect(mockedSendWsMessage).toHaveBeenCalledTimes(1);
      const [ws, msg] = mockedSendWsMessage.mock.calls[0];
      expect(ws).toBe(client.ws);
      expect(msg).toMatchObject({
        type: 'browser_tool_request',
        hubAgentId: 'hub-agent-1',
        toolName: 'dom',
        input: { action: 'create', html: '<p>test</p>' },
      });
      expect((msg as any).id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

      // Resolve the pending request
      const requestId = (msg as any).id;
      router.handleResult(requestId, { content: 'DOM updated' });

      const result = await resultPromise;
      expect(result.content).toBe('DOM updated');
      expect(result.is_error).toBeUndefined();
    });

    it('sends to first subscribed authenticated client', async () => {
      const client1 = createMockClient();
      clients.add(client1);

      const client2 = createMockClient();
      client2.subscribedAgents.add('hub-agent-1');
      clients.add(client2);

      const client3 = createMockClient();
      client3.subscribedAgents.add('hub-agent-1');
      clients.add(client3);

      const resultPromise = router.routeToBrowser('hub-agent-1', 'runjs', { code: '1+1' });

      // Should send to client2 (first subscribed one)
      expect(mockedSendWsMessage).toHaveBeenCalledTimes(1);
      const [ws] = mockedSendWsMessage.mock.calls[0];
      expect(ws).toBe(client2.ws);

      // Resolve
      const requestId = (mockedSendWsMessage.mock.calls[0][1] as any).id;
      router.handleResult(requestId, { content: '2' });
      await resultPromise;
    });

    it('returns timeout error when browser does not respond', async () => {
      const client = createMockClient();
      client.subscribedAgents.add('hub-agent-1');
      clients.add(client);

      // Use a very short timeout
      const result = await router.routeToBrowser('hub-agent-1', 'dom', { action: 'query' }, 50);

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('timed out');
      expect(result.content).toContain('dom');
    });

    it('handles error results from browser', async () => {
      const client = createMockClient();
      client.subscribedAgents.add('hub-agent-1');
      clients.add(client);

      const resultPromise = router.routeToBrowser('hub-agent-1', 'runjs', { code: 'throw new Error("oops")' });

      const requestId = (mockedSendWsMessage.mock.calls[0][1] as any).id;
      router.handleResult(requestId, { content: 'Error: oops', is_error: true });

      const result = await resultPromise;
      expect(result.is_error).toBe(true);
      expect(result.content).toBe('Error: oops');
    });

    it('prefers last active client over other subscribers', async () => {
      const client1 = createMockClient();
      client1.subscribedAgents.add('hub-agent-1');
      clients.add(client1);

      const client2 = createMockClient();
      client2.subscribedAgents.add('hub-agent-1');
      clients.add(client2);

      router.setLastActiveClient('hub-agent-1', client2);

      const resultPromise = router.routeToBrowser('hub-agent-1', 'dom', { action: 'create' });

      expect(mockedSendWsMessage).toHaveBeenCalledTimes(1);
      const [ws] = mockedSendWsMessage.mock.calls[0];
      expect(ws).toBe(client2.ws);

      // Resolve
      const requestId = (mockedSendWsMessage.mock.calls[0][1] as any).id;
      router.handleResult(requestId, { content: 'ok' });
      await resultPromise;
    });

    it('falls back to any subscriber when last active client is gone', async () => {
      const client1 = createMockClient();
      client1.subscribedAgents.add('hub-agent-1');
      clients.add(client1);

      const client2 = createMockClient();
      client2.subscribedAgents.add('hub-agent-1');
      clients.add(client2);

      // Set client2 as last active, then remove it from the clients set
      router.setLastActiveClient('hub-agent-1', client2);
      clients.delete(client2);

      const resultPromise = router.routeToBrowser('hub-agent-1', 'dom', { action: 'query' });

      expect(mockedSendWsMessage).toHaveBeenCalledTimes(1);
      const [ws] = mockedSendWsMessage.mock.calls[0];
      // Should fall back to client1 since client2 is no longer in clients set
      expect(ws).toBe(client1.ws);

      // Resolve
      const requestId = (mockedSendWsMessage.mock.calls[0][1] as any).id;
      router.handleResult(requestId, { content: 'found' });
      await resultPromise;
    });
  });

  describe('handleResult', () => {
    it('resolves pending request', async () => {
      const client = createMockClient();
      client.subscribedAgents.add('hub-agent-1');
      clients.add(client);

      const resultPromise = router.routeToBrowser('hub-agent-1', 'storage', { action: 'get', key: 'foo' });

      const requestId = (mockedSendWsMessage.mock.calls[0][1] as any).id;
      router.handleResult(requestId, { content: 'bar' });

      const result = await resultPromise;
      expect(result.content).toBe('bar');
    });

    it('ignores unknown IDs', () => {
      // Should not throw
      router.handleResult('unknown-id-123', { content: 'test' });
      expect(router.pendingCount).toBe(0);
    });

    it('clears timeout when result arrives', async () => {
      const client = createMockClient();
      client.subscribedAgents.add('hub-agent-1');
      clients.add(client);

      const resultPromise = router.routeToBrowser('hub-agent-1', 'dom', { action: 'query' }, 60000);

      expect(router.pendingCount).toBe(1);

      const requestId = (mockedSendWsMessage.mock.calls[0][1] as any).id;
      router.handleResult(requestId, { content: 'found element' });

      const result = await resultPromise;
      expect(result.content).toBe('found element');
      expect(router.pendingCount).toBe(0);
    });
  });

  describe('request ID format', () => {
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    it('generates request IDs in UUID v4 format', async () => {
      const client = createMockClient();
      client.subscribedAgents.add('hub-agent-1');
      clients.add(client);

      const resultPromise = router.routeToBrowser('hub-agent-1', 'dom', { action: 'create' });

      expect(mockedSendWsMessage).toHaveBeenCalledTimes(1);
      const requestId = (mockedSendWsMessage.mock.calls[0][1] as any).id;
      expect(requestId).toMatch(UUID_REGEX);

      // Resolve so promise doesn't hang
      router.handleResult(requestId, { content: 'ok' });
      await resultPromise;
    });

    it('generates unique IDs across multiple calls', async () => {
      const client = createMockClient();
      client.subscribedAgents.add('hub-agent-1');
      clients.add(client);

      const ids = new Set<string>();
      const promises: Promise<any>[] = [];

      for (let i = 0; i < 20; i++) {
        promises.push(router.routeToBrowser('hub-agent-1', 'dom', { action: 'create' }, 60000));
      }

      expect(mockedSendWsMessage).toHaveBeenCalledTimes(20);
      for (let i = 0; i < 20; i++) {
        const id = (mockedSendWsMessage.mock.calls[i][1] as any).id;
        ids.add(id);
      }

      // All 20 IDs should be unique
      expect(ids.size).toBe(20);

      // Resolve all
      for (let i = 0; i < 20; i++) {
        const id = (mockedSendWsMessage.mock.calls[i][1] as any).id;
        router.handleResult(id, { content: 'ok' });
      }
      await Promise.all(promises);
    });
  });

  describe('pendingCount', () => {
    it('starts at 0', () => {
      expect(router.pendingCount).toBe(0);
    });

    it('increments when request is made', async () => {
      const client = createMockClient();
      client.subscribedAgents.add('hub-agent-1');
      clients.add(client);

      // Start a request but don't resolve it yet
      const p1 = router.routeToBrowser('hub-agent-1', 'dom', { action: 'create' }, 60000);
      expect(router.pendingCount).toBe(1);

      const p2 = router.routeToBrowser('hub-agent-1', 'runjs', { code: '1+1' }, 60000);
      expect(router.pendingCount).toBe(2);

      // Resolve both
      const id1 = (mockedSendWsMessage.mock.calls[0][1] as any).id;
      const id2 = (mockedSendWsMessage.mock.calls[1][1] as any).id;
      router.handleResult(id1, { content: 'ok' });
      router.handleResult(id2, { content: 'ok' });

      await Promise.all([p1, p2]);
      expect(router.pendingCount).toBe(0);
    });

    it('decrements on timeout', async () => {
      const client = createMockClient();
      client.subscribedAgents.add('hub-agent-1');
      clients.add(client);

      await router.routeToBrowser('hub-agent-1', 'dom', { action: 'create' }, 10);
      expect(router.pendingCount).toBe(0);
    });
  });
});
