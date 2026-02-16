/**
 * Tests for WebSocket hub server
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHubServer, type HubServer, type ErrorMessage, type ToolResultMessage } from '../server.js';
import { getDefaultConfig, type HubConfig } from '../config.js';

describe('hub server', () => {
  let server: HubServer;
  let config: HubConfig;
  let sandboxDir: string;
  const TEST_PORT = 18765;

  beforeEach(async () => {
    // Create a sandbox directory for bash cwd validation
    sandboxDir = join(tmpdir(), `hub-server-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(sandboxDir, { recursive: true });

    config = {
      ...getDefaultConfig(),
      port: TEST_PORT,
      host: '127.0.0.1',
      localhostBypassAuth: true,
      sandboxPath: sandboxDir,
    };
    server = createHubServer(config);

    // Wait for server to start (HTTP server emits 'listening', not WebSocket server)
    await new Promise((resolve) => {
      const targetServer = server.httpServer ?? server.httpsServer;
      if (targetServer) {
        targetServer.once('listening', resolve);
      } else {
        // Fallback for WebSocket-only mode (shouldn't happen in current impl)
        server.wss.once('listening', resolve);
      }
    });
  });

  afterEach(async () => {
    await server.close();
    await rm(sandboxDir, { recursive: true, force: true });
  });

  function createClient(): Promise<{ ws: WebSocket; messages: HubMessage[]; closedPromise: Promise<void> }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
      const messages: HubMessage[] = [];

      // Create close promise early to capture close events
      const closedPromise = new Promise<void>((closeResolve) => {
        ws.once('close', () => closeResolve());
      });

      ws.on('message', (data) => {
        messages.push(JSON.parse(data.toString()) as HubMessage);
      });

      ws.once('open', () => resolve({ ws, messages, closedPromise }));
      ws.once('error', reject);
    });
  }

  function waitForMessage<T extends { type: string }>(
    messages: HubMessage[],
    type?: string,
    timeout = 2000
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const start = Date.now();

      const check = (): void => {
        // Find message of the expected type
        for (let i = 0; i < messages.length; i++) {
          if (!type || messages[i].type === type) {
            const msg = messages.splice(i, 1)[0];
            resolve(msg as T);
            return;
          }
        }

        if (Date.now() - start > timeout) {
          reject(new Error(`Timeout waiting for message type: ${type ?? 'any'}`));
          return;
        }

        setTimeout(check, 10);
      };

      check();
    });
  }

  type HubMessage = { type: string; [key: string]: unknown };
  type AuthResultMessage = { type: 'auth_result'; success: boolean; hubId: string; hubName: string; error?: string };
  type AnnounceToolsMessage = { type: 'announce_tools'; tools: Array<{ name: string; description: string; input_schema: unknown }> };

  describe('connection', () => {
    it('should accept WebSocket connections', async () => {
      const { ws } = await createClient();
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });

    it('should send auth_result for localhost with bypass enabled', async () => {
      const { ws, messages } = await createClient();
      const authResult = await waitForMessage<AuthResultMessage>(messages, 'auth_result');

      expect(authResult.type).toBe('auth_result');
      expect(authResult.success).toBe(true);
      expect(authResult.hubName).toBe(config.name);

      ws.close();
    });

    it('should include tool definitions in announce_tools', async () => {
      const { ws, messages } = await createClient();
      await waitForMessage<AuthResultMessage>(messages, 'auth_result');
      const announceTools = await waitForMessage<AnnounceToolsMessage>(messages, 'announce_tools');

      const bashTool = announceTools.tools.find((t) => t.name === 'bash');
      const fsTool = announceTools.tools.find((t) => t.name === 'filesystem');

      expect(bashTool).toBeDefined();
      expect(bashTool?.description).toBeDefined();
      expect(fsTool).toBeDefined();
      expect(fsTool?.description).toBeDefined();

      ws.close();
    });

    it('should track connected clients', async () => {
      const { ws: ws1, messages: messages1 } = await createClient();
      await waitForMessage<AuthResultMessage>(messages1, 'auth_result');
      expect(server.clients.size).toBe(1);

      const { ws: ws2, messages: messages2 } = await createClient();
      await waitForMessage<AuthResultMessage>(messages2, 'auth_result');
      expect(server.clients.size).toBe(2);

      ws1.close();

      // Wait for close to be processed
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(server.clients.size).toBe(1);

      ws2.close();
    });
  });

  describe('authentication', () => {
    it('should require auth when localhost bypass is disabled', async () => {
      await server.close();

      config = {
        ...config,
        localhostBypassAuth: false,
        authToken: 'test-token',
      };
      server = createHubServer(config);

      await new Promise((resolve) => {
        const targetServer = server.httpServer ?? server.httpsServer;
        if (targetServer) {
          targetServer.once('listening', resolve);
        } else {
          server.wss.once('listening', resolve);
        }
      });

      const { ws, messages } = await createClient();

      // Send a tool call without authenticating
      ws.send(JSON.stringify({
        type: 'tool_request',
        id: '1',
        name: 'bash',
        input: { command: 'echo test' },
      }));

      const response = await waitForMessage<ErrorMessage>(messages, 'error');
      expect(response.type).toBe('error');
      expect(response.message).toContain('Not authenticated');

      ws.close();
    });

    it('should accept valid auth token', async () => {
      await server.close();

      config = {
        ...config,
        localhostBypassAuth: false,
        authToken: 'valid-token',
      };
      server = createHubServer(config);

      await new Promise((resolve) => {
        const targetServer = server.httpServer ?? server.httpsServer;
        if (targetServer) {
          targetServer.once('listening', resolve);
        } else {
          server.wss.once('listening', resolve);
        }
      });

      const { ws, messages } = await createClient();

      // Send auth message
      ws.send(JSON.stringify({
        type: 'auth',
        token: 'valid-token',
      }));

      const response = await waitForMessage<AuthResultMessage>(messages, 'auth_result');
      expect(response.type).toBe('auth_result');
      expect(response.success).toBe(true);

      ws.close();
    });

    it('should reject unauthenticated browser_tool_result', async () => {
      await server.close();

      config = {
        ...config,
        localhostBypassAuth: false,
        authToken: 'test-token',
      };
      server = createHubServer(config);

      await new Promise((resolve) => {
        const targetServer = server.httpServer ?? server.httpsServer;
        if (targetServer) {
          targetServer.once('listening', resolve);
        } else {
          server.wss.once('listening', resolve);
        }
      });

      const { ws, messages } = await createClient();

      // Send browser_tool_result without authenticating
      ws.send(JSON.stringify({
        type: 'browser_tool_result',
        id: 'btr-123',
        result: { content: 'malicious result' },
      }));

      const response = await waitForMessage<ErrorMessage>(messages, 'error');
      expect(response.type).toBe('error');
      expect(response.message).toContain('Not authenticated');

      ws.close();
    });

    it('should reject unauthenticated skill_approval_response', async () => {
      await server.close();

      config = {
        ...config,
        localhostBypassAuth: false,
        authToken: 'test-token',
      };
      server = createHubServer(config);

      await new Promise((resolve) => {
        const targetServer = server.httpServer ?? server.httpsServer;
        if (targetServer) {
          targetServer.once('listening', resolve);
        } else {
          server.wss.once('listening', resolve);
        }
      });

      const { ws, messages } = await createClient();

      // Send skill_approval_response without authenticating
      ws.send(JSON.stringify({
        type: 'skill_approval_response',
        id: 'approval-123',
        approved: true,
      }));

      const response = await waitForMessage<ErrorMessage>(messages, 'error');
      expect(response.type).toBe('error');
      expect(response.message).toContain('Not authenticated');

      ws.close();
    });

    it('should reject invalid auth token', async () => {
      await server.close();

      config = {
        ...config,
        localhostBypassAuth: false,
        authToken: 'valid-token',
      };
      server = createHubServer(config);

      await new Promise((resolve) => {
        const targetServer = server.httpServer ?? server.httpsServer;
        if (targetServer) {
          targetServer.once('listening', resolve);
        } else {
          server.wss.once('listening', resolve);
        }
      });

      const { ws, messages, closedPromise } = await createClient();

      // Send auth message with wrong token
      ws.send(JSON.stringify({
        type: 'auth',
        token: 'wrong-token',
      }));

      const response = await waitForMessage<AuthResultMessage>(messages, 'auth_result');
      expect(response.type).toBe('auth_result');
      expect(response.success).toBe(false);
      expect(response.error).toContain('Authentication failed');

      // Wait for close (the close handler was already registered in createClient)
      await closedPromise;
    });
  });

  describe('tool execution', () => {
    it('should execute bash tool', async () => {
      const { ws, messages } = await createClient();
      await waitForMessage<AuthResultMessage>(messages, 'auth_result');

      ws.send(JSON.stringify({
        type: 'tool_request',
        id: 'call-1',
        name: 'bash',
        input: { command: 'echo hello from hub' },
      }));

      const response = await waitForMessage<ToolResultMessage>(messages, 'tool_result');

      expect(response.type).toBe('tool_result');
      expect(response.id).toBe('call-1');
      expect(response.result.content.trim()).toBe('hello from hub');
      expect(response.result.is_error).toBeUndefined();

      ws.close();
    });

    it('should return error for unknown tool', async () => {
      const { ws, messages } = await createClient();
      await waitForMessage<AuthResultMessage>(messages, 'auth_result');

      ws.send(JSON.stringify({
        type: 'tool_request',
        id: 'call-2',
        name: 'nonexistent',
        input: {},
      }));

      const response = await waitForMessage<ToolResultMessage>(messages, 'tool_result');

      expect(response.type).toBe('tool_result');
      expect(response.id).toBe('call-2');
      expect(response.result.is_error).toBe(true);
      expect(response.result.content).toContain('Unknown tool');

      ws.close();
    });

    it('should handle invalid message format', async () => {
      const { ws, messages } = await createClient();
      await waitForMessage<AuthResultMessage>(messages, 'auth_result');

      ws.send('not valid json');

      const response = await waitForMessage<ErrorMessage>(messages, 'error');

      expect(response.type).toBe('error');
      expect(response.message).toContain('Invalid message format');

      ws.close();
    });

    it('should handle unknown message type', async () => {
      const { ws, messages } = await createClient();
      await waitForMessage<AuthResultMessage>(messages, 'auth_result');

      ws.send(JSON.stringify({
        type: 'unknown_type',
        id: 'msg-1',
      }));

      const response = await waitForMessage<ErrorMessage>(messages, 'error');

      expect(response.type).toBe('error');
      expect(response.id).toBe('msg-1');
      expect(response.message).toContain('Unknown message type');

      ws.close();
    });
  });

  describe('TLS configuration', () => {
    it('should start without TLS when tls config is not provided', async () => {
      // The default test server already runs without TLS
      // Verify it's accessible via ws:// (not wss://)
      const { ws, messages } = await createClient();
      const authResult = await waitForMessage<AuthResultMessage>(messages, 'auth_result');

      expect(authResult.type).toBe('auth_result');
      expect(authResult.success).toBe(true);
      expect(server.httpsServer).toBeUndefined();

      ws.close();
    });

    it('should throw error when TLS cert file does not exist', () => {
      const tlsConfig = {
        ...getDefaultConfig(),
        port: TEST_PORT + 200,
        host: '127.0.0.1',
        tls: {
          certFile: '/nonexistent/cert.pem',
          keyFile: '/nonexistent/key.pem',
        },
      };

      expect(() => createHubServer(tlsConfig)).toThrow();
    });

    it('should throw error when TLS key file does not exist', async () => {
      // Create a temporary cert file to test key file error
      const fs = await import('node:fs');
      const os = await import('node:os');
      const path = await import('node:path');

      const tmpDir = os.tmpdir();
      const certFile = path.join(tmpDir, `test-cert-${Date.now()}.pem`);

      // Write a dummy cert file
      fs.writeFileSync(certFile, 'dummy cert content');

      try {
        const tlsConfig = {
          ...getDefaultConfig(),
          port: TEST_PORT + 201,
          host: '127.0.0.1',
          tls: {
            certFile: certFile,
            keyFile: '/nonexistent/key.pem',
          },
        };

        expect(() => createHubServer(tlsConfig)).toThrow();
      } finally {
        // Clean up
        fs.unlinkSync(certFile);
      }
    });
  });

  describe('server lifecycle', () => {
    it('should close all connections on shutdown', async () => {
      // Create a dedicated server for this test to avoid race conditions
      const lifecyclePort = TEST_PORT + 100;
      const lifecycleServer = createHubServer({
        ...getDefaultConfig(),
        port: lifecyclePort,
        host: '127.0.0.1',
        localhostBypassAuth: true,
      });

      await new Promise((resolve) => {
        const targetServer = lifecycleServer.httpServer ?? lifecycleServer.httpsServer;
        if (targetServer) {
          targetServer.once('listening', resolve);
        } else {
          lifecycleServer.wss.once('listening', resolve);
        }
      });

      // Create client and set up all handlers before connect completes
      const { ws, closedPromise, messageReceived } = await new Promise<{
        ws: WebSocket;
        closedPromise: Promise<void>;
        messageReceived: Promise<void>;
      }>((resolve, reject) => {
        const client = new WebSocket(`ws://127.0.0.1:${lifecyclePort}`);

        const closedPromise = new Promise<void>((closeResolve) => {
          client.once('close', () => closeResolve());
        });

        const messageReceived = new Promise<void>((msgResolve) => {
          client.once('message', () => msgResolve());
        });

        client.once('open', () => resolve({ ws: client, closedPromise, messageReceived }));
        client.once('error', reject);
      });

      // Wait for welcome message to ensure connection is established
      await messageReceived;

      // Now close the server
      await lifecycleServer.close();

      // Wait for the client to be closed
      await closedPromise;

      expect(ws.readyState).toBe(WebSocket.CLOSED);
    });
  });
});
