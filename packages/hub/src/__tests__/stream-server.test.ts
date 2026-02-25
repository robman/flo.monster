/**
 * Tests for StreamServer — dedicated WSS for viewport frame streaming.
 * WebSocket is fully mocked — no real server is started.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamServer, type StreamServerConfig } from '../stream-server.js';

// --- Mocks ---

// Mock ws module
const mockWssListeners = new Map<string, ((...args: any[]) => void)[]>();
const mockWss = {
  on: vi.fn((event: string, handler: (...args: any[]) => void) => {
    if (!mockWssListeners.has(event)) mockWssListeners.set(event, []);
    mockWssListeners.get(event)!.push(handler);
  }),
  close: vi.fn((cb?: () => void) => { if (cb) cb(); }),
};

vi.mock('ws', () => ({
  WebSocketServer: vi.fn(() => mockWss),
  WebSocket: { OPEN: 1 },
}));

// Mock http/https
let lastListenPort = 0;
const mockHttpServer = {
  listen: vi.fn((port: number, _host: string, cb?: () => void) => {
    // Simulate OS-assigned port when port is 0, otherwise use the requested port
    lastListenPort = port === 0 ? 44321 : port;
    if (cb) cb();
  }),
  close: vi.fn((cb?: () => void) => { if (cb) cb(); }),
  on: vi.fn(),
  address: vi.fn(() => ({ port: lastListenPort, family: 'IPv4', address: '127.0.0.1' })),
};

vi.mock('node:http', () => ({
  createServer: vi.fn(() => mockHttpServer),
}));

vi.mock('node:https', () => ({
  createServer: vi.fn(() => mockHttpServer),
}));

// Mock ScreencastManager
function createMockScreencastManager() {
  return {
    startScreencast: vi.fn(async () => ({ width: 1419, height: 813 })),
    stopScreencast: vi.fn(async () => {}),
    handleAck: vi.fn(),
    stopAllForClient: vi.fn(async () => {}),
  } as any;
}

// --- Helpers ---

function makeConfig(overrides: Partial<StreamServerConfig> = {}): StreamServerConfig {
  return {
    host: '127.0.0.1',
    maxConnections: 5,
    tokenTTLSeconds: 30,
    ...overrides,
  };
}

// Helper to create mock client WebSocket
function createMockClientWs() {
  const listeners = new Map<string, ((...args: any[]) => void)[]>();
  return {
    readyState: 1, // WebSocket.OPEN
    binaryType: 'nodebuffer',
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(handler);
    }),
    _listeners: listeners,
  };
}

// --- Tests ---

describe('StreamServer', () => {
  let screencastManager: ReturnType<typeof createMockScreencastManager>;
  let server: StreamServer;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockWssListeners.clear();
    lastListenPort = 0;

    screencastManager = createMockScreencastManager();
    server = new StreamServer(makeConfig(), screencastManager);
  });

  afterEach(async () => {
    await server.close();
    vi.useRealTimers();
  });

  describe('start', () => {
    it('should create HTTP server and WSS on port 0 (OS-assigned)', async () => {
      const port = await server.start();
      expect(mockHttpServer.listen).toHaveBeenCalledWith(0, '127.0.0.1', expect.any(Function));
      expect(port).toBe(44321);
      expect(server.port).toBe(44321);
    });

    it('should listen on fixed port when configured', async () => {
      const fixedPort = 19876;
      const fixedServer = new StreamServer(makeConfig({ port: fixedPort }), screencastManager);

      const actualPort = await fixedServer.start();
      expect(mockHttpServer.listen).toHaveBeenCalledWith(fixedPort, '127.0.0.1', expect.any(Function));
      expect(actualPort).toBe(fixedPort);
      expect(fixedServer.port).toBe(fixedPort);
      await fixedServer.close();
    });

    it('should use OS-assigned port when port is not configured', async () => {
      // makeConfig() does not set port, so it defaults to undefined → 0
      const noPortServer = new StreamServer(makeConfig(), screencastManager);

      const actualPort = await noPortServer.start();
      expect(mockHttpServer.listen).toHaveBeenCalledWith(0, '127.0.0.1', expect.any(Function));
      expect(actualPort).toBeGreaterThan(0);
      expect(noPortServer.port).toBe(actualPort);
      await noPortServer.close();
    });
  });

  describe('generateToken', () => {
    it('should generate unique tokens', async () => {
      await server.start();
      const token1 = server.generateToken('agent-1', 'client-1');
      const token2 = server.generateToken('agent-1', 'client-2');
      expect(token1).not.toBe(token2);
      expect(token1).toHaveLength(64); // 32 bytes hex
    });
  });

  describe('token expiry', () => {
    it('should expire tokens after TTL', async () => {
      const shortTTL = new StreamServer(makeConfig({ tokenTTLSeconds: 5 }), screencastManager);
      await shortTTL.start();

      const token = shortTTL.generateToken('agent-1', 'client-1');

      // Advance past TTL + cleanup interval
      vi.advanceTimersByTime(15_000);

      // Create mock WebSocket to test auth
      const mockWs = createMockClientWs();

      // Simulate connection and auth attempt
      const connectionHandler = mockWssListeners.get('connection');
      if (connectionHandler) {
        for (const handler of connectionHandler) {
          handler(mockWs);
        }
      }

      // Get the message handler
      const messageHandler = mockWs._listeners.get('message')?.[0];
      if (messageHandler) {
        messageHandler(Buffer.from(JSON.stringify({ type: 'stream_auth', token })));
      }

      // Should have sent failure
      expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining('"success":false'));
    });
  });

  describe('connectionCount', () => {
    it('should start at 0', () => {
      expect(server.connectionCount).toBe(0);
    });
  });

  describe('close', () => {
    it('should close WSS and HTTP server', async () => {
      await server.start();
      await server.close();

      expect(mockWss.close).toHaveBeenCalled();
      expect(mockHttpServer.close).toHaveBeenCalled();
    });

    it('should be safe to call multiple times', async () => {
      await server.start();
      await server.close();
      await server.close(); // Should not throw
    });
  });

  describe('input event handling', () => {
    it('should invoke onInputEvent for valid input messages', async () => {
      await server.start();
      const handler = vi.fn();
      server.setInputEventHandler(handler);

      // Generate a valid token
      const token = server.generateToken('agent-1', 'client-1');

      // Simulate connection
      const mockWs = createMockClientWs();
      const connectionHandler = mockWssListeners.get('connection');
      if (connectionHandler) {
        for (const h of connectionHandler) h(mockWs);
      }

      // Authenticate
      const messageHandler = mockWs._listeners.get('message')?.[0];
      if (messageHandler) {
        messageHandler(Buffer.from(JSON.stringify({ type: 'stream_auth', token })));
      }

      // Wait for auth to complete
      await vi.advanceTimersByTimeAsync(100);

      // Send input event
      if (messageHandler) {
        messageHandler(Buffer.from(JSON.stringify({
          type: 'input_event',
          event: { kind: 'click', x: 100, y: 200 },
        })));
      }

      expect(handler).toHaveBeenCalledWith('client-1', 'agent-1', { kind: 'click', x: 100, y: 200 });
    });

    it('should ignore malformed input messages', async () => {
      await server.start();
      const handler = vi.fn();
      server.setInputEventHandler(handler);

      const token = server.generateToken('agent-1', 'client-1');

      const mockWs = createMockClientWs();
      const connectionHandler = mockWssListeners.get('connection');
      if (connectionHandler) {
        for (const h of connectionHandler) h(mockWs);
      }

      const messageHandler = mockWs._listeners.get('message')?.[0];
      if (messageHandler) {
        messageHandler(Buffer.from(JSON.stringify({ type: 'stream_auth', token })));
      }

      await vi.advanceTimersByTimeAsync(100);

      // Send malformed message (no event.kind)
      if (messageHandler) {
        messageHandler(Buffer.from(JSON.stringify({
          type: 'input_event',
          event: { noKind: true },
        })));
      }

      expect(handler).not.toHaveBeenCalled();
    });

    it('should ignore unparseable messages', async () => {
      await server.start();
      const handler = vi.fn();
      server.setInputEventHandler(handler);

      const token = server.generateToken('agent-1', 'client-1');

      const mockWs = createMockClientWs();
      const connectionHandler = mockWssListeners.get('connection');
      if (connectionHandler) {
        for (const h of connectionHandler) h(mockWs);
      }

      const messageHandler = mockWs._listeners.get('message')?.[0];
      if (messageHandler) {
        messageHandler(Buffer.from(JSON.stringify({ type: 'stream_auth', token })));
      }

      await vi.advanceTimersByTimeAsync(100);

      // Send invalid JSON
      if (messageHandler) {
        messageHandler(Buffer.from('not valid json'));
      }

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('getAgentIdForClient', () => {
    it('should return agentId for connected client', async () => {
      await server.start();

      const token = server.generateToken('agent-1', 'client-1');

      const mockWs = createMockClientWs();
      const connectionHandler = mockWssListeners.get('connection');
      if (connectionHandler) {
        for (const h of connectionHandler) h(mockWs);
      }

      const messageHandler = mockWs._listeners.get('message')?.[0];
      if (messageHandler) {
        messageHandler(Buffer.from(JSON.stringify({ type: 'stream_auth', token })));
      }

      await vi.advanceTimersByTimeAsync(100);

      expect(server.getAgentIdForClient('client-1')).toBe('agent-1');
    });

    it('should return undefined for unknown client', async () => {
      await server.start();
      expect(server.getAgentIdForClient('unknown')).toBeUndefined();
    });
  });
});
