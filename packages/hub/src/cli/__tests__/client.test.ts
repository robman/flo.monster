/**
 * Tests for admin CLI client
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { AdminClient, AdminClientError, createAdminClient } from '../client.js';
import type { HubToAdmin, AdminToHub } from '@flo-monster/core';

describe('AdminClient', () => {
  let mockServer: WebSocketServer;
  let serverConnections: WebSocket[];
  const TEST_PORT = 38766;

  beforeEach(async () => {
    serverConnections = [];
    mockServer = new WebSocketServer({ port: TEST_PORT });

    await new Promise((resolve) => {
      mockServer.once('listening', resolve);
    });
  });

  afterEach(async () => {
    for (const conn of serverConnections) {
      conn.close();
    }
    serverConnections = [];

    await new Promise<void>((resolve, reject) => {
      mockServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  describe('connection', () => {
    it('should connect to server', async () => {
      mockServer.on('connection', (ws) => {
        serverConnections.push(ws);
      });

      const client = new AdminClient({
        host: '127.0.0.1',
        port: TEST_PORT,
      });

      await client.connect();
      expect(client.connected).toBe(true);

      client.close();
    });

    it('should timeout on connection failure', async () => {
      const client = new AdminClient({
        host: '127.0.0.1',
        port: TEST_PORT + 1000, // Wrong port
        timeout: 500,
      });

      await expect(client.connect()).rejects.toThrow();
    });

    it('should report not connected after close', async () => {
      mockServer.on('connection', (ws) => {
        serverConnections.push(ws);
      });

      const client = new AdminClient({
        host: '127.0.0.1',
        port: TEST_PORT,
      });

      await client.connect();
      client.close();

      expect(client.connected).toBe(false);
    });
  });

  describe('authentication', () => {
    it('should authenticate with token', async () => {
      mockServer.on('connection', (ws) => {
        serverConnections.push(ws);
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString()) as AdminToHub;
          if (msg.type === 'admin_auth') {
            const response: HubToAdmin = {
              type: 'auth_result',
              success: msg.token === 'valid-token',
              error: msg.token !== 'valid-token' ? 'Invalid token' : undefined,
            };
            ws.send(JSON.stringify(response));
          }
        });
      });

      const client = new AdminClient({
        host: '127.0.0.1',
        port: TEST_PORT,
        token: 'valid-token',
      });

      await client.connect();
      await client.authenticate();

      client.close();
    });

    it('should fail authentication with invalid token', async () => {
      mockServer.on('connection', (ws) => {
        serverConnections.push(ws);
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString()) as AdminToHub;
          if (msg.type === 'admin_auth') {
            const response: HubToAdmin = {
              type: 'auth_result',
              success: false,
              error: 'Invalid token',
            };
            ws.send(JSON.stringify(response));
          }
        });
      });

      const client = new AdminClient({
        host: '127.0.0.1',
        port: TEST_PORT,
        token: 'wrong-token',
      });

      await client.connect();
      await expect(client.authenticate()).rejects.toThrow('Invalid token');

      client.close();
    });

    it('should auto-authenticate on localhost without token', async () => {
      mockServer.on('connection', (ws) => {
        serverConnections.push(ws);
        // Auto-send auth result for localhost after a small delay
        // to ensure the client's listener is set up
        setTimeout(() => {
          const response: HubToAdmin = {
            type: 'auth_result',
            success: true,
          };
          ws.send(JSON.stringify(response));
        }, 10);
      });

      const client = new AdminClient({
        host: '127.0.0.1',
        port: TEST_PORT,
      });

      await client.connect();
      await client.authenticate();

      client.close();
    });
  });

  describe('request/response', () => {
    it('should send request and receive response', async () => {
      mockServer.on('connection', (ws) => {
        serverConnections.push(ws);
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString()) as AdminToHub;
          if (msg.type === 'list_agents') {
            const response: HubToAdmin = {
              type: 'agents_list',
              agents: [],
            };
            ws.send(JSON.stringify(response));
          }
        });
      });

      const client = new AdminClient({
        host: '127.0.0.1',
        port: TEST_PORT,
      });

      await client.connect();

      const response = await client.request(
        { type: 'list_agents' },
        'agents_list',
      );

      expect(response.type).toBe('agents_list');
      expect(response.agents).toEqual([]);

      client.close();
    });

    it('should timeout waiting for response', async () => {
      mockServer.on('connection', (ws) => {
        serverConnections.push(ws);
        // Don't respond to simulate timeout
      });

      const client = new AdminClient({
        host: '127.0.0.1',
        port: TEST_PORT,
      });

      await client.connect();

      await expect(
        client.waitForMessage('agents_list', 500),
      ).rejects.toThrow('Timeout');

      client.close();
    });

    it('should handle error responses', async () => {
      mockServer.on('connection', (ws) => {
        serverConnections.push(ws);
        ws.on('message', () => {
          const response: HubToAdmin = {
            type: 'error',
            message: 'Something went wrong',
          };
          ws.send(JSON.stringify(response));
        });
      });

      const client = new AdminClient({
        host: '127.0.0.1',
        port: TEST_PORT,
      });

      await client.connect();

      await expect(
        client.request({ type: 'list_agents' }, 'agents_list'),
      ).rejects.toThrow('Something went wrong');

      client.close();
    });
  });

  describe('message streaming', () => {
    it('should receive streamed messages', async () => {
      mockServer.on('connection', (ws) => {
        serverConnections.push(ws);
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString()) as AdminToHub;
          if (msg.type === 'subscribe_logs') {
            // Send ok, then stream logs
            ws.send(JSON.stringify({ type: 'ok', message: 'Subscribed' }));
            setTimeout(() => {
              ws.send(JSON.stringify({
                type: 'log_entry',
                timestamp: Date.now(),
                level: 'info',
                message: 'Log 1',
              }));
            }, 10);
            setTimeout(() => {
              ws.send(JSON.stringify({
                type: 'log_entry',
                timestamp: Date.now(),
                level: 'info',
                message: 'Log 2',
              }));
            }, 20);
          }
        });
      });

      const client = new AdminClient({
        host: '127.0.0.1',
        port: TEST_PORT,
      });

      await client.connect();

      const receivedLogs: HubToAdmin[] = [];
      const unsubscribe = client.onMessage((msg) => {
        if (msg.type === 'log_entry') {
          receivedLogs.push(msg);
        }
      });

      await client.send({ type: 'subscribe_logs' });
      await client.waitForMessage('ok');

      // Wait for logs
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(receivedLogs.length).toBe(2);
      unsubscribe();
      client.close();
    });

    it('should unsubscribe from messages', async () => {
      mockServer.on('connection', (ws) => {
        serverConnections.push(ws);
        setTimeout(() => {
          ws.send(JSON.stringify({ type: 'ok' }));
        }, 10);
      });

      const client = new AdminClient({
        host: '127.0.0.1',
        port: TEST_PORT,
      });

      await client.connect();

      let callCount = 0;
      const unsubscribe = client.onMessage(() => {
        callCount++;
      });

      // Wait for first message
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(callCount).toBe(1);

      // Unsubscribe
      unsubscribe();

      client.close();
    });
  });

  describe('createAdminClient factory', () => {
    it('should create connected and authenticated client', async () => {
      mockServer.on('connection', (ws) => {
        serverConnections.push(ws);
        // Auto-authenticate after a small delay
        setTimeout(() => {
          ws.send(JSON.stringify({ type: 'auth_result', success: true }));
        }, 10);
      });

      const client = await createAdminClient({
        host: '127.0.0.1',
        port: TEST_PORT,
      });

      expect(client.connected).toBe(true);
      client.close();
    });
  });

  describe('AdminClientError', () => {
    it('should create error with message', () => {
      const err = new AdminClientError('Test error');
      expect(err.message).toBe('Test error');
      expect(err.name).toBe('AdminClientError');
    });

    it('should create error with code', () => {
      const err = new AdminClientError('Test error', 'ERR_CODE');
      expect(err.code).toBe('ERR_CODE');
    });
  });
});
