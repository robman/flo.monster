/**
 * Tests for admin WebSocket server
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHubServer, type HubServer } from '../../server.js';
import { createAdminServer, type AdminServer } from '../server.js';
import { getDefaultConfig, type HubConfig } from '../../config.js';
import type { HubToAdmin, AdminToHub } from '@flo-monster/core';

describe('admin server', () => {
  let hubServer: HubServer;
  let adminServer: AdminServer;
  let config: HubConfig;
  let sandboxDir: string;
  const HUB_PORT = 28765;
  const ADMIN_PORT = 28766;
  const startTime = Date.now();

  beforeEach(async () => {
    sandboxDir = join(tmpdir(), `admin-server-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(sandboxDir, { recursive: true });

    config = {
      ...getDefaultConfig(),
      port: HUB_PORT,
      adminPort: ADMIN_PORT,
      host: '127.0.0.1',
      localhostBypassAuth: true,
      sandboxPath: sandboxDir,
      adminToken: 'test-admin-token',
    };

    hubServer = createHubServer(config);
    await new Promise((resolve) => {
      hubServer.wss.once('listening', resolve);
    });

    adminServer = createAdminServer(config, hubServer, startTime);
    await new Promise((resolve) => {
      adminServer.wss.once('listening', resolve);
    });
  });

  afterEach(async () => {
    await adminServer.close();
    await hubServer.close();
    await rm(sandboxDir, { recursive: true, force: true });
  });

  function createAdminClient(): Promise<{ ws: WebSocket; messages: HubToAdmin[] }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${ADMIN_PORT}`);
      const messages: HubToAdmin[] = [];

      ws.on('message', (data) => {
        messages.push(JSON.parse(data.toString()) as HubToAdmin);
      });

      ws.once('open', () => resolve({ ws, messages }));
      ws.once('error', reject);
    });
  }

  function waitForMessage<T>(
    messages: HubToAdmin[],
    type?: string,
    timeout = 2000,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const start = Date.now();

      const check = (): void => {
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

  describe('authentication', () => {
    it('should require authentication with adminToken configured', async () => {
      const { ws, messages } = await createAdminClient();

      // Send a request without authenticating
      ws.send(JSON.stringify({ type: 'list_agents' }));

      const response = await waitForMessage<{ type: 'error'; message: string }>(messages, 'error');
      expect(response.type).toBe('error');
      expect(response.message).toContain('Not authenticated');

      ws.close();
    });

    it('should accept valid admin token', async () => {
      const { ws, messages } = await createAdminClient();

      ws.send(JSON.stringify({ type: 'admin_auth', token: 'test-admin-token' }));

      const response = await waitForMessage<{ type: 'auth_result'; success: boolean }>(messages, 'auth_result');
      expect(response.success).toBe(true);

      ws.close();
    });

    it('should reject invalid admin token', async () => {
      const { ws, messages } = await createAdminClient();

      ws.send(JSON.stringify({ type: 'admin_auth', token: 'wrong-token' }));

      const response = await waitForMessage<{ type: 'auth_result'; success: boolean; error?: string }>(messages, 'auth_result');
      expect(response.success).toBe(false);
      expect(response.error).toContain('Invalid');

      ws.close();
    });

    it('should auto-authenticate localhost when no adminToken configured', async () => {
      // Close existing servers and create new ones without adminToken
      await adminServer.close();
      await hubServer.close();

      const noTokenConfig = {
        ...config,
        adminToken: undefined,
      };

      hubServer = createHubServer(noTokenConfig);
      await new Promise((resolve) => {
        hubServer.wss.once('listening', resolve);
      });

      adminServer = createAdminServer(noTokenConfig, hubServer, startTime);
      await new Promise((resolve) => {
        adminServer.wss.once('listening', resolve);
      });

      const { ws, messages } = await createAdminClient();

      // Should get auth_result automatically
      const response = await waitForMessage<{ type: 'auth_result'; success: boolean }>(messages, 'auth_result');
      expect(response.success).toBe(true);

      ws.close();
    });
  });

  describe('agent management', () => {
    async function authenticatedClient(): Promise<{ ws: WebSocket; messages: HubToAdmin[] }> {
      const { ws, messages } = await createAdminClient();
      ws.send(JSON.stringify({ type: 'admin_auth', token: 'test-admin-token' }));
      await waitForMessage(messages, 'auth_result');
      return { ws, messages };
    }

    it('should list agents (empty)', async () => {
      const { ws, messages } = await authenticatedClient();

      ws.send(JSON.stringify({ type: 'list_agents' }));

      const response = await waitForMessage<{ type: 'agents_list'; agents: unknown[] }>(messages, 'agents_list');
      expect(response.agents).toEqual([]);

      ws.close();
    });

    it('should return null for non-existent agent', async () => {
      const { ws, messages } = await authenticatedClient();

      ws.send(JSON.stringify({ type: 'inspect_agent', agentId: 'non-existent' }));

      const response = await waitForMessage<{ type: 'agent_info'; agent: null }>(messages, 'agent_info');
      expect(response.agent).toBeNull();

      ws.close();
    });

    it('should return error when pausing non-existent agent', async () => {
      const { ws, messages } = await authenticatedClient();

      ws.send(JSON.stringify({ type: 'pause_agent', agentId: 'non-existent' }));

      const response = await waitForMessage<{ type: 'error'; message: string }>(messages, 'error');
      expect(response.message).toContain('not found');

      ws.close();
    });
  });

  describe('connection management', () => {
    async function authenticatedClient(): Promise<{ ws: WebSocket; messages: HubToAdmin[] }> {
      const { ws, messages } = await createAdminClient();
      ws.send(JSON.stringify({ type: 'admin_auth', token: 'test-admin-token' }));
      await waitForMessage(messages, 'auth_result');
      return { ws, messages };
    }

    it('should list connections', async () => {
      const { ws, messages } = await authenticatedClient();

      ws.send(JSON.stringify({ type: 'list_connections' }));

      const response = await waitForMessage<{ type: 'connections_list'; connections: unknown[] }>(messages, 'connections_list');
      expect(Array.isArray(response.connections)).toBe(true);

      ws.close();
    });
  });

  describe('configuration', () => {
    async function authenticatedClient(): Promise<{ ws: WebSocket; messages: HubToAdmin[] }> {
      const { ws, messages } = await createAdminClient();
      ws.send(JSON.stringify({ type: 'admin_auth', token: 'test-admin-token' }));
      await waitForMessage(messages, 'auth_result');
      return { ws, messages };
    }

    it('should get config', async () => {
      const { ws, messages } = await authenticatedClient();

      ws.send(JSON.stringify({ type: 'get_config' }));

      const response = await waitForMessage<{ type: 'config'; config: Record<string, unknown> }>(messages, 'config');
      expect(response.config.port).toBe(HUB_PORT);
      expect(response.config.adminPort).toBe(ADMIN_PORT);
      // Sensitive fields should not be included
      expect(response.config.authToken).toBeUndefined();
      expect(response.config.adminToken).toBeUndefined();

      ws.close();
    });

    it('should report config reload not supported', async () => {
      const { ws, messages } = await authenticatedClient();

      ws.send(JSON.stringify({ type: 'reload_config' }));

      const response = await waitForMessage<{ type: 'config_reloaded'; success: boolean; error?: string }>(messages, 'config_reloaded');
      expect(response.success).toBe(false);
      expect(response.error).toContain('not supported');

      ws.close();
    });
  });

  describe('statistics', () => {
    async function authenticatedClient(): Promise<{ ws: WebSocket; messages: HubToAdmin[] }> {
      const { ws, messages } = await createAdminClient();
      ws.send(JSON.stringify({ type: 'admin_auth', token: 'test-admin-token' }));
      await waitForMessage(messages, 'auth_result');
      return { ws, messages };
    }

    it('should get stats', async () => {
      const { ws, messages } = await authenticatedClient();

      ws.send(JSON.stringify({ type: 'get_stats' }));

      const response = await waitForMessage<{ type: 'stats'; uptime: number; connections: number; agents: number; totalRequests: number }>(messages, 'stats');
      expect(response.uptime).toBeGreaterThanOrEqual(0);
      expect(typeof response.connections).toBe('number');
      expect(typeof response.agents).toBe('number');
      expect(response.totalRequests).toBeGreaterThan(0); // At least the auth request

      ws.close();
    });

    it('should get usage', async () => {
      const { ws, messages } = await authenticatedClient();

      ws.send(JSON.stringify({ type: 'get_usage' }));

      const response = await waitForMessage<{ type: 'usage'; data: { scope: string; entries: unknown[] } }>(messages, 'usage');
      expect(response.data.scope).toBe('global');
      expect(Array.isArray(response.data.entries)).toBe(true);

      ws.close();
    });
  });

  describe('log streaming', () => {
    async function authenticatedClient(): Promise<{ ws: WebSocket; messages: HubToAdmin[] }> {
      const { ws, messages } = await createAdminClient();
      ws.send(JSON.stringify({ type: 'admin_auth', token: 'test-admin-token' }));
      await waitForMessage(messages, 'auth_result');
      return { ws, messages };
    }

    it('should subscribe to logs', async () => {
      const { ws, messages } = await authenticatedClient();

      ws.send(JSON.stringify({ type: 'subscribe_logs' }));

      const response = await waitForMessage<{ type: 'ok'; message?: string }>(messages, 'ok');
      expect(response.message).toContain('Subscribed');

      ws.close();
    });

    it('should unsubscribe from logs', async () => {
      const { ws, messages } = await authenticatedClient();

      ws.send(JSON.stringify({ type: 'subscribe_logs' }));
      await waitForMessage(messages, 'ok');

      ws.send(JSON.stringify({ type: 'unsubscribe_logs' }));
      const response = await waitForMessage<{ type: 'ok'; message?: string }>(messages, 'ok');
      expect(response.message).toContain('Unsubscribed');

      ws.close();
    });

    it('should broadcast logs to subscribed clients', async () => {
      const { ws, messages } = await authenticatedClient();

      ws.send(JSON.stringify({ type: 'subscribe_logs' }));
      await waitForMessage(messages, 'ok');

      // Broadcast a log
      adminServer.broadcastLog('info', 'Test log message', 'test');

      const logEntry = await waitForMessage<{ type: 'log_entry'; level: string; message: string; source?: string }>(messages, 'log_entry');
      expect(logEntry.level).toBe('info');
      expect(logEntry.message).toBe('Test log message');
      expect(logEntry.source).toBe('test');

      ws.close();
    });
  });

  describe('auth token management', () => {
    async function authenticatedClient(): Promise<{ ws: WebSocket; messages: HubToAdmin[] }> {
      const { ws, messages } = await createAdminClient();
      ws.send(JSON.stringify({ type: 'admin_auth', token: 'test-admin-token' }));
      await waitForMessage(messages, 'auth_result');
      return { ws, messages };
    }

    it('should show token', async () => {
      const { ws, messages } = await authenticatedClient();

      ws.send(JSON.stringify({ type: 'show_token' }));

      const response = await waitForMessage<{ type: 'token'; token: string }>(messages, 'token');
      expect(response.token).toBeDefined();

      ws.close();
    });

    it('should report rotate_token not supported', async () => {
      const { ws, messages } = await authenticatedClient();

      ws.send(JSON.stringify({ type: 'rotate_token' }));

      const response = await waitForMessage<{ type: 'error'; message: string }>(messages, 'error');
      expect(response.message).toContain('not supported');

      ws.close();
    });
  });

  describe('nuke operations', () => {
    async function authenticatedClient(): Promise<{ ws: WebSocket; messages: HubToAdmin[] }> {
      const { ws, messages } = await createAdminClient();
      ws.send(JSON.stringify({ type: 'admin_auth', token: 'test-admin-token' }));
      await waitForMessage(messages, 'auth_result');
      return { ws, messages };
    }

    it('should nuke agents', async () => {
      const { ws, messages } = await authenticatedClient();

      ws.send(JSON.stringify({ type: 'nuke', target: 'agents' }));

      const response = await waitForMessage<{ type: 'ok'; message?: string }>(messages, 'ok');
      expect(response.message).toContain('agents');

      ws.close();
    });

    it('should nuke clients', async () => {
      const { ws, messages } = await authenticatedClient();

      ws.send(JSON.stringify({ type: 'nuke', target: 'clients' }));

      const response = await waitForMessage<{ type: 'ok'; message?: string }>(messages, 'ok');
      expect(response.message).toContain('clients');

      ws.close();
    });

    it('should nuke all', async () => {
      const { ws, messages } = await authenticatedClient();

      ws.send(JSON.stringify({ type: 'nuke', target: 'all' }));

      const response = await waitForMessage<{ type: 'ok'; message?: string }>(messages, 'ok');
      expect(response.message).toContain('agents');
      expect(response.message).toContain('clients');

      ws.close();
    });
  });

  describe('error handling', () => {
    async function authenticatedClient(): Promise<{ ws: WebSocket; messages: HubToAdmin[] }> {
      const { ws, messages } = await createAdminClient();
      ws.send(JSON.stringify({ type: 'admin_auth', token: 'test-admin-token' }));
      await waitForMessage(messages, 'auth_result');
      return { ws, messages };
    }

    it('should handle invalid message format', async () => {
      const { ws, messages } = await authenticatedClient();

      ws.send('not valid json');

      const response = await waitForMessage<{ type: 'error'; message: string }>(messages, 'error');
      expect(response.message).toContain('Invalid');

      ws.close();
    });

    it('should handle unknown message type', async () => {
      const { ws, messages } = await authenticatedClient();

      ws.send(JSON.stringify({ type: 'unknown_type' }));

      const response = await waitForMessage<{ type: 'error'; message: string }>(messages, 'error');
      expect(response.message).toContain('Unknown');

      ws.close();
    });
  });
});
