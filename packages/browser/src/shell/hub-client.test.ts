import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HubClient, isLocalOrPrivateIP } from './hub-client.js';
import type { HubConnection } from './hub-client.js';
import type { HubToShell, ShellToHub } from '@flo-monster/core';

// Mock WebSocket
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  url: string;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;

  sentMessages: ShellToHub[] = [];

  constructor(url: string) {
    this.url = url;
    // Simulate async connection
    setTimeout(() => {
      if (this.readyState === MockWebSocket.CONNECTING) {
        this.readyState = MockWebSocket.OPEN;
        this.onopen?.();
      }
    }, 0);
  }

  send(data: string): void {
    this.sentMessages.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  // Test helper: simulate receiving a message
  simulateMessage(msg: HubToShell): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  // Test helper: simulate error
  simulateError(): void {
    this.onerror?.({});
  }
}

// Store created WebSocket instances for testing
let mockWebSockets: MockWebSocket[] = [];

vi.stubGlobal('WebSocket', class extends MockWebSocket {
  constructor(url: string) {
    super(url);
    mockWebSockets.push(this);
  }
});

describe('isLocalOrPrivateIP', () => {
  // Localhost variants
  it('returns true for localhost', () => {
    expect(isLocalOrPrivateIP('localhost')).toBe(true);
  });
  it('returns true for 127.0.0.1', () => {
    expect(isLocalOrPrivateIP('127.0.0.1')).toBe(true);
  });
  it('returns true for ::1', () => {
    expect(isLocalOrPrivateIP('::1')).toBe(true);
  });
  it('returns true for [::1]', () => {
    expect(isLocalOrPrivateIP('[::1]')).toBe(true);
  });

  // Loopback range
  it('returns true for 127.0.0.0/8 range', () => {
    expect(isLocalOrPrivateIP('127.255.255.255')).toBe(true);
    expect(isLocalOrPrivateIP('127.0.0.2')).toBe(true);
  });

  // RFC 1918 private ranges
  it('returns true for 10.0.0.0/8', () => {
    expect(isLocalOrPrivateIP('10.0.0.1')).toBe(true);
    expect(isLocalOrPrivateIP('10.255.255.255')).toBe(true);
  });
  it('returns true for 172.16.0.0/12', () => {
    expect(isLocalOrPrivateIP('172.16.0.1')).toBe(true);
    expect(isLocalOrPrivateIP('172.31.255.255')).toBe(true);
  });
  it('returns false for 172.15.x and 172.32.x (boundary)', () => {
    expect(isLocalOrPrivateIP('172.15.255.255')).toBe(false);
    expect(isLocalOrPrivateIP('172.32.0.0')).toBe(false);
  });
  it('returns true for 192.168.0.0/16', () => {
    expect(isLocalOrPrivateIP('192.168.1.100')).toBe(true);
    expect(isLocalOrPrivateIP('192.168.0.1')).toBe(true);
  });

  // Link-local
  it('returns true for 169.254.0.0/16 (link-local)', () => {
    expect(isLocalOrPrivateIP('169.254.1.1')).toBe(true);
  });

  // IPv6 ULA
  it('returns true for fc00::/7 (IPv6 ULA)', () => {
    expect(isLocalOrPrivateIP('fc00::1')).toBe(true);
    expect(isLocalOrPrivateIP('fd12:3456::1')).toBe(true);
  });

  // IPv6 link-local
  it('returns true for fe80::/10 (IPv6 link-local)', () => {
    expect(isLocalOrPrivateIP('fe80::1')).toBe(true);
  });

  // Bracket stripping for IPv6
  it('strips brackets for IPv6', () => {
    expect(isLocalOrPrivateIP('[fe80::1]')).toBe(true);
    expect(isLocalOrPrivateIP('[fd00::1]')).toBe(true);
  });

  // Public IPs - should be rejected
  it('returns false for public IPs', () => {
    expect(isLocalOrPrivateIP('8.8.8.8')).toBe(false);
    expect(isLocalOrPrivateIP('100.0.0.1')).toBe(false);
    expect(isLocalOrPrivateIP('1.2.3.4')).toBe(false);
  });

  // Public hostnames
  it('returns false for public hostnames', () => {
    expect(isLocalOrPrivateIP('example.com')).toBe(false);
    expect(isLocalOrPrivateIP('hub.flo.monster')).toBe(false);
  });
});

describe('HubClient', () => {
  let client: HubClient;

  beforeEach(() => {
    client = new HubClient();
    mockWebSockets = [];
  });

  afterEach(() => {
    // Cleanup: stop reconnection timers first, then disconnect
    client.stopAllReconnections();
    for (const conn of client.getConnections()) {
      client.disconnect(conn.id);
    }
    vi.clearAllMocks();
  });

  describe('connect', () => {
    it('creates WebSocket connection with correct URL', async () => {
      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub', 'test-token');

      // Wait for WebSocket to be created
      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));

      const ws = mockWebSockets[0];
      expect(ws.url).toBe('ws://localhost:3002');

      // Simulate successful auth
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Test Hub',
      });

      const conn = await connectPromise;
      expect(conn.connected).toBe(true);
      expect(conn.name).toBe('Test Hub');
    });

    it('sends auth message when token provided', async () => {
      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub', 'my-secret-token');

      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));

      const ws = mockWebSockets[0];

      // Wait for auth message to be sent
      await vi.waitFor(() => expect(ws.sentMessages.length).toBe(1));

      expect(ws.sentMessages[0]).toEqual({ type: 'auth', token: 'my-secret-token' });

      // Complete connection
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Test Hub',
      });

      await connectPromise;
    });

    it('rejects on auth failure', async () => {
      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub', 'bad-token');

      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));

      const ws = mockWebSockets[0];

      ws.simulateMessage({
        type: 'auth_result',
        success: false,
        hubId: '',
        hubName: '',
        error: 'Invalid token',
      });

      await expect(connectPromise).rejects.toThrow('Invalid token');
    });

    it('rejects on WebSocket error', async () => {
      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub');

      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));

      const ws = mockWebSockets[0];
      ws.simulateError();

      await expect(connectPromise).rejects.toThrow('WebSocket error');
    });
  });

  describe('disconnect', () => {
    it('closes WebSocket connection', async () => {
      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub');

      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));

      const ws = mockWebSockets[0];
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Test Hub',
      });

      const conn = await connectPromise;
      expect(client.getConnections().length).toBe(1);

      client.disconnect(conn.id);
      expect(client.getConnections().length).toBe(0);
      expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    });
  });

  describe('getConnections', () => {
    it('returns empty array initially', () => {
      expect(client.getConnections()).toEqual([]);
    });

    it('returns active connections', async () => {
      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub');

      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));

      mockWebSockets[0].simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Test Hub',
      });

      await connectPromise;

      const connections = client.getConnections();
      expect(connections.length).toBe(1);
      expect(connections[0].name).toBe('Test Hub');
      expect(connections[0].connected).toBe(true);
    });
  });

  describe('executeTool', () => {
    it('sends correct tool_request message', async () => {
      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub');

      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));

      const ws = mockWebSockets[0];
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Test Hub',
      });

      const conn = await connectPromise;

      // Execute tool (don't await yet)
      const toolPromise = client.executeTool(conn.id, 'bash', { command: 'ls -la' });

      // Wait for the tool request to be sent
      await vi.waitFor(() => {
        const toolReqs = ws.sentMessages.filter(m => m.type === 'tool_request');
        return toolReqs.length > 0;
      });

      const toolRequest = ws.sentMessages.find(m => m.type === 'tool_request') as Extract<ShellToHub, { type: 'tool_request' }>;
      expect(toolRequest.name).toBe('bash');
      expect(toolRequest.input).toEqual({ command: 'ls -la' });

      // Simulate response (result is a ToolResult object with content field)
      ws.simulateMessage({
        type: 'tool_result',
        id: toolRequest.id,
        result: { content: 'file1.txt\nfile2.txt' },
      });

      const result = await toolPromise;
      expect(result.result).toBe('file1.txt\nfile2.txt');
      expect(result.is_error).toBeUndefined();
    });

    it('handles tool error response', async () => {
      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub');

      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));

      const ws = mockWebSockets[0];
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Test Hub',
      });

      const conn = await connectPromise;

      const toolPromise = client.executeTool(conn.id, 'bash', { command: 'invalid' });

      await vi.waitFor(() => {
        const toolReqs = ws.sentMessages.filter(m => m.type === 'tool_request');
        return toolReqs.length > 0;
      });

      const toolRequest = ws.sentMessages.find(m => m.type === 'tool_request') as Extract<ShellToHub, { type: 'tool_request' }>;

      // Simulate error response (result is a ToolResult object)
      ws.simulateMessage({
        type: 'tool_result',
        id: toolRequest.id,
        result: { content: 'Command failed', is_error: true },
      });

      const result = await toolPromise;
      expect(result.is_error).toBe(true);
    });

    it('includes agentId in tool_request when provided', async () => {
      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub');

      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));

      const ws = mockWebSockets[0];
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Test Hub',
      });

      const conn = await connectPromise;

      const toolPromise = client.executeTool(conn.id, 'browse', { action: 'navigate', url: 'https://example.com' }, 'my-agent-123');

      await vi.waitFor(() => {
        const toolReqs = ws.sentMessages.filter(m => m.type === 'tool_request');
        return toolReqs.length > 0;
      });

      const toolRequest = ws.sentMessages.find(m => m.type === 'tool_request') as Extract<ShellToHub, { type: 'tool_request' }>;
      expect(toolRequest.name).toBe('browse');
      expect(toolRequest.agentId).toBe('my-agent-123');

      // Simulate response
      ws.simulateMessage({
        type: 'tool_result',
        id: toolRequest.id,
        result: { content: 'navigated' },
      });

      await toolPromise;
    });

    it('omits agentId from tool_request when not provided', async () => {
      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub');

      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));

      const ws = mockWebSockets[0];
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Test Hub',
      });

      const conn = await connectPromise;

      const toolPromise = client.executeTool(conn.id, 'bash', { command: 'ls' });

      await vi.waitFor(() => {
        const toolReqs = ws.sentMessages.filter(m => m.type === 'tool_request');
        return toolReqs.length > 0;
      });

      const toolRequest = ws.sentMessages.find(m => m.type === 'tool_request') as Extract<ShellToHub, { type: 'tool_request' }>;
      expect(toolRequest.agentId).toBeUndefined();

      ws.simulateMessage({
        type: 'tool_result',
        id: toolRequest.id,
        result: { content: 'ok' },
      });

      await toolPromise;
    });

    it('throws when hub not connected', async () => {
      await expect(client.executeTool('nonexistent', 'bash', {})).rejects.toThrow('Hub not connected');
    });
  });

  describe('fetch', () => {
    it('sends correct fetch_request message', async () => {
      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub');

      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));

      const ws = mockWebSockets[0];
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Test Hub',
      });

      const conn = await connectPromise;

      const fetchPromise = client.fetch(conn.id, 'https://example.com/api', { method: 'POST' });

      await vi.waitFor(() => {
        const fetchReqs = ws.sentMessages.filter(m => m.type === 'fetch_request');
        return fetchReqs.length > 0;
      });

      const fetchRequest = ws.sentMessages.find(m => m.type === 'fetch_request') as Extract<ShellToHub, { type: 'fetch_request' }>;
      expect(fetchRequest.url).toBe('https://example.com/api');
      expect(fetchRequest.options?.method).toBe('POST');

      ws.simulateMessage({
        type: 'fetch_result',
        id: fetchRequest.id,
        status: 200,
        body: '{"ok": true}',
      });

      const result = await fetchPromise;
      expect(result.status).toBe(200);
      expect(result.body).toBe('{"ok": true}');
    });
  });

  describe('onConnect/onDisconnect callbacks', () => {
    it('fires onConnect callback when connection established', async () => {
      const onConnect = vi.fn();
      client.onConnect(onConnect);

      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub');

      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));

      mockWebSockets[0].simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Test Hub',
      });

      await connectPromise;

      expect(onConnect).toHaveBeenCalledTimes(1);
      expect(onConnect).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Test Hub',
        connected: true,
      }));
    });

    it('fires onDisconnect callback when connection lost', async () => {
      const onDisconnect = vi.fn();
      client.onDisconnect(onDisconnect);

      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub');

      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));

      const ws = mockWebSockets[0];
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Test Hub',
      });

      const conn = await connectPromise;

      // Simulate disconnect
      ws.close();

      expect(onDisconnect).toHaveBeenCalledTimes(1);
      expect(onDisconnect).toHaveBeenCalledWith(conn.id);
    });

    it('allows unsubscribing from callbacks', async () => {
      const onConnect = vi.fn();
      const unsubscribe = client.onConnect(onConnect);

      unsubscribe();

      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub');

      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));

      mockWebSockets[0].simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Test Hub',
      });

      await connectPromise;

      expect(onConnect).not.toHaveBeenCalled();
    });
  });

  describe('tool announcements', () => {
    it('updates connection tools on announce_tools message', async () => {
      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub');

      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));

      const ws = mockWebSockets[0];
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Test Hub',
      });

      const conn = await connectPromise;
      expect(conn.tools).toEqual([]);

      ws.simulateMessage({
        type: 'announce_tools',
        tools: [
          { name: 'bash', description: 'Run bash commands', input_schema: { type: 'object', properties: {} } },
          { name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: {} } },
        ],
      });

      // Tools should be updated on the connection
      const updatedConn = client.getConnection(conn.id);
      expect(updatedConn?.tools.length).toBe(2);
      expect(updatedConn?.tools[0].name).toBe('bash');
    });

    it('findToolHub returns correct hub ID', async () => {
      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub');

      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));

      const ws = mockWebSockets[0];
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Test Hub',
      });

      const conn = await connectPromise;

      ws.simulateMessage({
        type: 'announce_tools',
        tools: [
          { name: 'bash', description: 'Run bash commands', input_schema: { type: 'object', properties: {} } },
        ],
      });

      expect(client.findToolHub('bash')).toBe(conn.id);
      expect(client.findToolHub('unknown')).toBeUndefined();
    });
  });

  describe('persistAgent', () => {
    it('sends persist_agent message with session data', async () => {
      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub');

      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));

      const ws = mockWebSockets[0];
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Test Hub',
      });

      const conn = await connectPromise;

      const mockSession = {
        version: 2,
        agentId: 'agent-123',
        config: { id: 'agent-123', name: 'Test', model: 'claude-sonnet-4-20250514', tools: [] },
        conversation: [],
        storage: {},
        metadata: { createdAt: 1000, serializedAt: 2000, totalTokens: 100, totalCost: 0.01 },
      };

      const persistPromise = client.persistAgent(conn.id, mockSession, ['key-hash-1']);

      await vi.waitFor(() => {
        const persistReqs = ws.sentMessages.filter(m => m.type === 'persist_agent');
        return persistReqs.length > 0;
      });

      const persistRequest = ws.sentMessages.find(m => m.type === 'persist_agent') as Extract<ShellToHub, { type: 'persist_agent' }>;
      expect(persistRequest.session).toEqual(mockSession);
      expect(persistRequest.keyHashes).toEqual(['key-hash-1']);

      ws.simulateMessage({
        type: 'persist_result',
        hubAgentId: 'hub-agent-123',
        success: true,
      });

      const result = await persistPromise;
      expect(result.success).toBe(true);
      expect(result.hubAgentId).toBe('hub-agent-123');
    });

    it('handles persist failure', async () => {
      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub');

      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));

      const ws = mockWebSockets[0];
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Test Hub',
      });

      const conn = await connectPromise;

      const persistPromise = client.persistAgent(conn.id, { agentId: 'test' });

      await vi.waitFor(() => {
        const persistReqs = ws.sentMessages.filter(m => m.type === 'persist_agent');
        return persistReqs.length > 0;
      });

      ws.simulateMessage({
        type: 'persist_result',
        hubAgentId: '',
        success: false,
        error: 'Session validation failed',
      });

      const result = await persistPromise;
      expect(result.success).toBe(false);
      expect(result.error).toBe('Session validation failed');
    });

    it('throws when hub not connected', async () => {
      await expect(client.persistAgent('nonexistent', {})).rejects.toThrow('Hub not connected');
    });
  });

  describe('restoreAgent', () => {
    it('sends restore_agent message and waits for response', async () => {
      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub');

      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));

      const ws = mockWebSockets[0];
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Test Hub',
      });

      const conn = await connectPromise;

      const mockSession = {
        version: 2,
        agentId: 'agent-123',
        conversation: [{ role: 'user', content: 'Hello' }],
      };

      const restorePromise = client.restoreAgent(conn.id, 'hub-agent-123');

      await vi.waitFor(() => {
        const restoreReqs = ws.sentMessages.filter(m => m.type === 'restore_agent');
        return restoreReqs.length > 0;
      });

      const restoreRequest = ws.sentMessages.find(m => m.type === 'restore_agent') as Extract<ShellToHub, { type: 'restore_agent' }>;
      expect(restoreRequest.agentId).toBe('hub-agent-123');

      ws.simulateMessage({
        type: 'restore_session',
        session: mockSession,
      });

      const result = await restorePromise;
      expect(result).toEqual(mockSession);
    });

    it('returns null for non-existent agent', async () => {
      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub');

      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));

      const ws = mockWebSockets[0];
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Test Hub',
      });

      const conn = await connectPromise;

      const restorePromise = client.restoreAgent(conn.id, 'nonexistent-agent');

      await vi.waitFor(() => {
        const restoreReqs = ws.sentMessages.filter(m => m.type === 'restore_agent');
        return restoreReqs.length > 0;
      });

      ws.simulateMessage({
        type: 'restore_session',
        session: null,
      });

      const result = await restorePromise;
      expect(result).toBeNull();
    });

    it('throws when hub not connected', async () => {
      await expect(client.restoreAgent('nonexistent', 'agent-123')).rejects.toThrow('Hub not connected');
    });
  });

  describe('sharedProviders and httpApiUrl', () => {
    it('stores sharedProviders and httpApiUrl from auth_result', async () => {
      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub', 'test-token');

      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));

      const ws = mockWebSockets[0];
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Test Hub',
        sharedProviders: ['anthropic', 'openai'],
        httpApiUrl: 'http://localhost:8765',
      });

      const conn = await connectPromise;
      expect(conn.sharedProviders).toEqual(['anthropic', 'openai']);
      expect(conn.httpApiUrl).toBe('http://localhost:8765');
    });

    it('handles auth_result without sharedProviders and httpApiUrl', async () => {
      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub', 'test-token');

      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));

      const ws = mockWebSockets[0];
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Test Hub',
      });

      const conn = await connectPromise;
      expect(conn.sharedProviders).toBeUndefined();
      expect(conn.httpApiUrl).toBeUndefined();
    });
  });

  describe('getConnectionsWithSharedProvider', () => {
    it('returns empty array when no connections', () => {
      expect(client.getConnectionsWithSharedProvider('anthropic')).toEqual([]);
    });

    it('returns connections with matching shared provider', async () => {
      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub', 'test-token');

      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));

      const ws = mockWebSockets[0];
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Test Hub',
        sharedProviders: ['anthropic', 'openai'],
        httpApiUrl: 'http://localhost:8765',
      });

      await connectPromise;

      const anthropicConns = client.getConnectionsWithSharedProvider('anthropic');
      expect(anthropicConns.length).toBe(1);
      expect(anthropicConns[0].name).toBe('Test Hub');

      const openaiConns = client.getConnectionsWithSharedProvider('openai');
      expect(openaiConns.length).toBe(1);
    });

    it('returns empty array for non-matching provider', async () => {
      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub', 'test-token');

      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));

      const ws = mockWebSockets[0];
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Test Hub',
        sharedProviders: ['anthropic'],
        httpApiUrl: 'http://localhost:8765',
      });

      await connectPromise;

      const googleConns = client.getConnectionsWithSharedProvider('google');
      expect(googleConns.length).toBe(0);
    });

    it('excludes disconnected connections', async () => {
      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub', 'test-token');

      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));

      const ws = mockWebSockets[0];
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Test Hub',
        sharedProviders: ['anthropic'],
        httpApiUrl: 'http://localhost:8765',
      });

      const conn = await connectPromise;

      // Verify connected
      expect(client.getConnectionsWithSharedProvider('anthropic').length).toBe(1);

      // Disconnect
      client.disconnect(conn.id);

      // Should now be empty
      expect(client.getConnectionsWithSharedProvider('anthropic').length).toBe(0);
    });
  });

  describe('browser tool requests', () => {
    it('calls registered handler on browser_tool_request', async () => {
      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub');
      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));
      const ws = mockWebSockets[0];
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Test Hub',
      });
      await connectPromise;

      const handler = vi.fn().mockResolvedValue({ content: '<p>created</p>' });
      client.onBrowserToolRequest(handler);

      ws.simulateMessage({
        type: 'browser_tool_request',
        id: 'btr-1',
        hubAgentId: 'hub-agent-123',
        toolName: 'dom',
        input: { action: 'create', html: '<p>test</p>' },
      } as any);

      await vi.waitFor(() => expect(handler).toHaveBeenCalled());
      expect(handler).toHaveBeenCalledWith('hub-agent-123', 'dom', { action: 'create', html: '<p>test</p>' });

      // Wait for result to be sent back
      await vi.waitFor(() => {
        expect(ws.sentMessages.filter((m: any) => m.type === 'browser_tool_result').length).toBeGreaterThan(0);
      });

      const result = ws.sentMessages.find((m: any) => m.type === 'browser_tool_result') as any;
      expect(result.id).toBe('btr-1');
      expect(result.result).toEqual({ content: '<p>created</p>' });
    });

    it('returns error when no handler registered', async () => {
      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub');
      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));
      const ws = mockWebSockets[0];
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Test Hub',
      });
      await connectPromise;

      // No handler registered
      ws.simulateMessage({
        type: 'browser_tool_request',
        id: 'btr-2',
        hubAgentId: 'hub-agent-123',
        toolName: 'runjs',
        input: { code: 'console.log("test")' },
      } as any);

      await vi.waitFor(() => {
        expect(ws.sentMessages.filter((m: any) => m.type === 'browser_tool_result').length).toBeGreaterThan(0);
      });

      const result = ws.sentMessages.find((m: any) => m.type === 'browser_tool_result') as any;
      expect(result.id).toBe('btr-2');
      expect(result.result.is_error).toBe(true);
      expect(result.result.content).toContain('No browser tool handler');
    });

    it('returns error when handler throws', async () => {
      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub');
      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));
      const ws = mockWebSockets[0];
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Test Hub',
      });
      await connectPromise;

      const handler = vi.fn().mockRejectedValue(new Error('Iframe not found'));
      client.onBrowserToolRequest(handler);

      ws.simulateMessage({
        type: 'browser_tool_request',
        id: 'btr-3',
        hubAgentId: 'hub-agent-123',
        toolName: 'dom',
        input: { action: 'query', selector: '#app' },
      } as any);

      await vi.waitFor(() => {
        expect(ws.sentMessages.filter((m: any) => m.type === 'browser_tool_result').length).toBeGreaterThan(0);
      });

      const result = ws.sentMessages.find((m: any) => m.type === 'browser_tool_result') as any;
      expect(result.id).toBe('btr-3');
      expect(result.result.is_error).toBe(true);
      expect(result.result.content).toContain('Iframe not found');
    });

    it('allows unsubscribing handler', async () => {
      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub');
      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));
      const ws = mockWebSockets[0];
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Test Hub',
      });
      await connectPromise;

      const handler = vi.fn().mockResolvedValue({ content: 'ok' });
      const unsub = client.onBrowserToolRequest(handler);
      unsub();

      ws.simulateMessage({
        type: 'browser_tool_request',
        id: 'btr-4',
        hubAgentId: 'hub-agent-123',
        toolName: 'storage',
        input: { action: 'get', key: 'test' },
      } as any);

      // Should send error since handler was unsubscribed
      await vi.waitFor(() => {
        expect(ws.sentMessages.filter((m: any) => m.type === 'browser_tool_result').length).toBeGreaterThan(0);
      });

      const result = ws.sentMessages.find((m: any) => m.type === 'browser_tool_result') as any;
      expect(result.result.is_error).toBe(true);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('DOM state callbacks', () => {
    it('calls onDomStateRestore callback on restore_dom_state message', async () => {
      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub');
      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));
      const ws = mockWebSockets[0];
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Test Hub',
      });
      await connectPromise;

      const handler = vi.fn();
      client.onDomStateRestore(handler);

      const domState = {
        viewportHtml: '<p>Hello</p>',
        listeners: [],
        capturedAt: 1000,
      };

      ws.simulateMessage({
        type: 'restore_dom_state',
        hubAgentId: 'hub-agent-1',
        domState,
      } as any);

      expect(handler).toHaveBeenCalledWith('hub-agent-1', domState);
    });

    it('allows unsubscribing from DOM state callbacks', async () => {
      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub');
      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));
      const ws = mockWebSockets[0];
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Test Hub',
      });
      await connectPromise;

      const handler = vi.fn();
      const unsub = client.onDomStateRestore(handler);
      unsub();

      ws.simulateMessage({
        type: 'restore_dom_state',
        hubAgentId: 'hub-agent-1',
        domState: { viewportHtml: '', listeners: [], capturedAt: 0 },
      } as any);

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('context change callbacks', () => {
    it('calls onContextChange callback on context_change message', async () => {
      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub');
      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));
      const ws = mockWebSockets[0];
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Test Hub',
      });
      await connectPromise;

      const handler = vi.fn();
      client.onContextChange(handler);

      ws.simulateMessage({
        type: 'context_change',
        hubAgentId: 'hub-agent-1',
        change: 'browser_connected',
        availableTools: ['bash', 'dom', 'runjs'],
      } as any);

      expect(handler).toHaveBeenCalledWith('hub-agent-1', 'browser_connected', ['bash', 'dom', 'runjs']);
    });

    it('calls onContextChange for browser_disconnected', async () => {
      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub');
      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));
      const ws = mockWebSockets[0];
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Test Hub',
      });
      await connectPromise;

      const handler = vi.fn();
      client.onContextChange(handler);

      ws.simulateMessage({
        type: 'context_change',
        hubAgentId: 'hub-agent-1',
        change: 'browser_disconnected',
        availableTools: ['bash', 'filesystem'],
      } as any);

      expect(handler).toHaveBeenCalledWith('hub-agent-1', 'browser_disconnected', ['bash', 'filesystem']);
    });
  });

  describe('wss:// enforcement for non-localhost', () => {
    it('throws for ws:// to non-localhost hostname', async () => {
      await expect(client.connect('ws://example.com:3002', 'Remote Hub'))
        .rejects.toThrow('Non-localhost hub connections require wss://');
    });

    it('allows wss:// to non-localhost hostname', async () => {
      const connectPromise = client.connect('wss://example.com:3002', 'Remote Hub');

      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));

      const ws = mockWebSockets[0];
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Remote Hub',
      });

      const conn = await connectPromise;
      expect(conn.connected).toBe(true);
    });

    it('allows ws:// to localhost', async () => {
      const connectPromise = client.connect('ws://localhost:3002', 'Local Hub');

      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));

      const ws = mockWebSockets[0];
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Local Hub',
      });

      const conn = await connectPromise;
      expect(conn.connected).toBe(true);
    });

    it('allows ws:// to 127.0.0.1', async () => {
      const connectPromise = client.connect('ws://127.0.0.1:3002', 'Local Hub');

      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));

      const ws = mockWebSockets[0];
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Local Hub',
      });

      const conn = await connectPromise;
      expect(conn.connected).toBe(true);
    });

    it('allows ws:// to ::1 (IPv6 localhost)', async () => {
      const connectPromise = client.connect('ws://[::1]:3002', 'Local Hub');

      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));

      const ws = mockWebSockets[0];
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Local Hub',
      });

      const conn = await connectPromise;
      expect(conn.connected).toBe(true);
    });

    it('allows ws:// for RFC 1918 private IPs', async () => {
      // Test 192.168.x.x
      const p1 = client.connect('ws://192.168.1.100:8765', 'LAN Hub');
      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));
      mockWebSockets[0].simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'LAN Hub',
      });
      const conn1 = await p1;
      expect(conn1.connected).toBe(true);
      client.disconnect(conn1.id);
      mockWebSockets = [];

      // Test 10.x.x.x
      const p2 = client.connect('ws://10.0.0.1:8765', 'LAN Hub');
      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));
      mockWebSockets[0].simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-2',
        hubName: 'LAN Hub',
      });
      const conn2 = await p2;
      expect(conn2.connected).toBe(true);
      client.disconnect(conn2.id);
      mockWebSockets = [];

      // Test 172.16.x.x
      const p3 = client.connect('ws://172.16.0.1:8765', 'LAN Hub');
      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));
      mockWebSockets[0].simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-3',
        hubName: 'LAN Hub',
      });
      const conn3 = await p3;
      expect(conn3.connected).toBe(true);
    });

    it('still rejects ws:// for public IPs', async () => {
      await expect(client.connect('ws://8.8.8.8:8765', 'Public Hub'))
        .rejects.toThrow('Non-localhost hub connections require wss://');
    });
  });

  describe('sendDomStateUpdate', () => {
    it('sends dom_state_update message to hub', async () => {
      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub');
      await vi.waitFor(() => expect(mockWebSockets.length).toBe(1));
      const ws = mockWebSockets[0];
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Test Hub',
      });
      const conn = await connectPromise;

      const domState = {
        viewportHtml: '<div>Updated</div>',
        listeners: [],
        capturedAt: 2000,
      };

      client.sendDomStateUpdate(conn.id, 'hub-agent-1', domState);

      const updateMsg = ws.sentMessages.find((m: any) => m.type === 'dom_state_update');
      expect(updateMsg).toBeDefined();
      expect((updateMsg as any).hubAgentId).toBe('hub-agent-1');
      expect((updateMsg as any).domState).toEqual(domState);
    });

    it('ignores send when not connected', () => {
      // Should not throw
      client.sendDomStateUpdate('nonexistent', 'hub-agent-1', { viewportHtml: '', listeners: [], capturedAt: 0 });
    });
  });

  describe('streamApiProxy', () => {
    async function connectToHub(): Promise<{ conn: HubConnection; ws: MockWebSocket }> {
      const prevWsCount = mockWebSockets.length;
      const connectPromise = client.connect('ws://localhost:3002', 'Test Hub', 'test-token');
      await vi.waitFor(() => expect(mockWebSockets.length).toBeGreaterThan(prevWsCount));
      const ws = mockWebSockets[mockWebSockets.length - 1];
      ws.simulateMessage({
        type: 'auth_result',
        success: true,
        hubId: 'hub-1',
        hubName: 'Test Hub',
        sharedProviders: ['anthropic'],
      });
      const conn = await connectPromise;
      return { conn, ws };
    }

    it('sends correct api_proxy_request message', async () => {
      const { conn, ws } = await connectToHub();

      const onChunk = vi.fn();
      const onEnd = vi.fn();
      const onError = vi.fn();

      client.streamApiProxy(conn.id, 'anthropic', '/v1/messages', { model: 'claude-sonnet-4-20250514' }, {
        onChunk,
        onEnd,
        onError,
      });

      const proxyReq = ws.sentMessages.find(m => m.type === 'api_proxy_request') as Extract<ShellToHub, { type: 'api_proxy_request' }>;
      expect(proxyReq).toBeDefined();
      expect(proxyReq.provider).toBe('anthropic');
      expect(proxyReq.path).toBe('/v1/messages');
      expect(proxyReq.payload).toEqual({ model: 'claude-sonnet-4-20250514' });
      expect(proxyReq.id).toBeDefined();
    });

    it('routes api_stream_chunk to onChunk callback', async () => {
      const { conn, ws } = await connectToHub();

      const onChunk = vi.fn();
      const onEnd = vi.fn();
      const onError = vi.fn();

      client.streamApiProxy(conn.id, 'anthropic', '/v1/messages', {}, {
        onChunk,
        onEnd,
        onError,
      });

      const proxyReq = ws.sentMessages.find(m => m.type === 'api_proxy_request') as Extract<ShellToHub, { type: 'api_proxy_request' }>;

      ws.simulateMessage({ type: 'api_stream_chunk', id: proxyReq.id, chunk: 'Hello' });
      ws.simulateMessage({ type: 'api_stream_chunk', id: proxyReq.id, chunk: ' world' });

      expect(onChunk).toHaveBeenCalledTimes(2);
      expect(onChunk).toHaveBeenNthCalledWith(1, 'Hello');
      expect(onChunk).toHaveBeenNthCalledWith(2, ' world');
    });

    it('routes api_stream_end to onEnd callback', async () => {
      const { conn, ws } = await connectToHub();

      const onChunk = vi.fn();
      const onEnd = vi.fn();
      const onError = vi.fn();

      client.streamApiProxy(conn.id, 'anthropic', '/v1/messages', {}, {
        onChunk,
        onEnd,
        onError,
      });

      const proxyReq = ws.sentMessages.find(m => m.type === 'api_proxy_request') as Extract<ShellToHub, { type: 'api_proxy_request' }>;

      ws.simulateMessage({ type: 'api_stream_end', id: proxyReq.id });

      expect(onEnd).toHaveBeenCalledTimes(1);
    });

    it('routes api_error to onError callback', async () => {
      const { conn, ws } = await connectToHub();

      const onChunk = vi.fn();
      const onEnd = vi.fn();
      const onError = vi.fn();

      client.streamApiProxy(conn.id, 'anthropic', '/v1/messages', {}, {
        onChunk,
        onEnd,
        onError,
      });

      const proxyReq = ws.sentMessages.find(m => m.type === 'api_proxy_request') as Extract<ShellToHub, { type: 'api_proxy_request' }>;

      ws.simulateMessage({ type: 'api_error', id: proxyReq.id, error: 'Rate limit exceeded' });

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith('Rate limit exceeded');
    });

    it('calls onError immediately when hub not connected', () => {
      const onChunk = vi.fn();
      const onEnd = vi.fn();
      const onError = vi.fn();

      client.streamApiProxy('nonexistent-hub', 'anthropic', '/v1/messages', {}, {
        onChunk,
        onEnd,
        onError,
      });

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith('Hub not connected: nonexistent-hub');
    });

    it('cancel function cleans up pending request', async () => {
      const { conn, ws } = await connectToHub();

      const onChunk = vi.fn();
      const onEnd = vi.fn();
      const onError = vi.fn();

      const cancel = client.streamApiProxy(conn.id, 'anthropic', '/v1/messages', {}, {
        onChunk,
        onEnd,
        onError,
      });

      const proxyReq = ws.sentMessages.find(m => m.type === 'api_proxy_request') as Extract<ShellToHub, { type: 'api_proxy_request' }>;

      // Cancel the stream
      cancel();

      // Simulate chunks arriving after cancel — should be ignored
      ws.simulateMessage({ type: 'api_stream_chunk', id: proxyReq.id, chunk: 'late data' });
      ws.simulateMessage({ type: 'api_stream_end', id: proxyReq.id });

      expect(onChunk).not.toHaveBeenCalled();
      expect(onEnd).not.toHaveBeenCalled();
    });

    it('cleans up streams on disconnect', async () => {
      const { conn, ws } = await connectToHub();

      const onChunk = vi.fn();
      const onEnd = vi.fn();
      const onError = vi.fn();

      client.streamApiProxy(conn.id, 'anthropic', '/v1/messages', {}, {
        onChunk,
        onEnd,
        onError,
      });

      // Close the WebSocket to simulate disconnect
      ws.close();

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith('Hub disconnected');
    });
  });
});
