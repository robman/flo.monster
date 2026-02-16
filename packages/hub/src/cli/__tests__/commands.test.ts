/**
 * Tests for CLI command modules
 *
 * These tests focus on command parsing and validation logic,
 * not actual network operations (those are covered by client.test.ts)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import type { AdminToHub, HubToAdmin } from '@flo-monster/core';

// Import commands
import { agentsCommand } from '../commands/agents.js';
import { statsCommand } from '../commands/stats.js';
import { configCommand } from '../commands/config.js';
import { usageCommand } from '../commands/usage.js';
import { connectionsCommand } from '../commands/connections.js';

describe('CLI Commands', () => {
  let mockServer: WebSocketServer;
  let serverConnections: WebSocket[];
  const TEST_PORT = 38799;
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let processExitSpy: any;

  const defaultOptions = {
    host: '127.0.0.1',
    port: TEST_PORT,
    token: undefined,
    json: false,
  };

  beforeEach(async () => {
    serverConnections = [];
    mockServer = new WebSocketServer({ port: TEST_PORT });

    await new Promise((resolve) => {
      mockServer.once('listening', resolve);
    });

    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // process.exit mock that throws to abort execution
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((code): never => {
      throw new Error(`process.exit(${code})`);
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

    vi.restoreAllMocks();
  });

  // Helper to set up mock server with standard auth + response
  function setupMockServer(responseHandler: (msg: AdminToHub) => HubToAdmin | null) {
    mockServer.on('connection', (ws) => {
      serverConnections.push(ws);

      // Auto-authenticate
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'auth_result', success: true }));
      }, 5);

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as AdminToHub;

        // Skip auth messages
        if (msg.type === 'admin_auth') return;

        const response = responseHandler(msg);
        if (response) {
          ws.send(JSON.stringify(response));
        }
      });
    });
  }

  describe('agentsCommand', () => {
    it('should list agents in table format', async () => {
      setupMockServer((msg) => {
        if (msg.type === 'list_agents') {
          return {
            type: 'agents_list',
            agents: [
              {
                id: 'agent-1',
                name: 'Test Agent',
                state: 'running',
                createdAt: Date.now(),
                messageCount: 5,
                totalTokens: 1000,
                totalCost: 0.01,
              },
            ],
          } as HubToAdmin;
        }
        return null;
      });

      await agentsCommand(defaultOptions, ['list']);

      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('agent-1');
      expect(output).toContain('Test Agent');
    });

    it('should handle empty agent list', async () => {
      setupMockServer((msg) => {
        if (msg.type === 'list_agents') {
          return { type: 'agents_list', agents: [] };
        }
        return null;
      });

      await agentsCommand(defaultOptions, ['list']);

      expect(consoleSpy).toHaveBeenCalledWith('No agents found');
    });

    it('should output JSON when json flag is set', async () => {
      setupMockServer((msg) => {
        if (msg.type === 'list_agents') {
          return {
            type: 'agents_list',
            agents: [{ id: 'agent-1', name: 'Test', state: 'running', createdAt: Date.now(), messageCount: 0, totalTokens: 0, totalCost: 0 }],
          } as HubToAdmin;
        }
        return null;
      });

      await agentsCommand({ ...defaultOptions, json: true }, ['list']);

      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls[0][0];
      expect(output).toContain('"id"');
    });

    it('should inspect agent details', async () => {
      setupMockServer((msg) => {
        if (msg.type === 'inspect_agent') {
          return {
            type: 'agent_info',
            agent: {
              id: 'agent-1',
              name: 'Test Agent',
              state: 'running',
              createdAt: Date.now(),
              messageCount: 10,
              totalTokens: 5000,
              totalCost: 0.05,
            },
          };
        }
        if (msg.type === 'get_agent_schedules') {
          return { type: 'agent_schedules', schedules: [] } as HubToAdmin;
        }
        if (msg.type === 'get_agent_log') {
          return { type: 'agent_log', agentId: 'agent-1', messages: [] } as HubToAdmin;
        }
        return null;
      });

      await agentsCommand(defaultOptions, ['inspect', 'agent-1']);

      const output = consoleSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('Agent Details');
      expect(output).toContain('agent-1');
      expect(output).toContain('Test Agent');
    });

    it('should require agent ID for inspect', async () => {
      setupMockServer(() => null);

      await expect(agentsCommand(defaultOptions, ['inspect'])).rejects.toThrow('process.exit(1)');

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    });

    it('should handle pause command', async () => {
      setupMockServer((msg) => {
        if (msg.type === 'pause_agent') {
          return { type: 'ok', message: 'Agent paused' };
        }
        return null;
      });

      await agentsCommand(defaultOptions, ['pause', 'agent-1']);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('paused'));
    });

    it('should handle stop command', async () => {
      setupMockServer((msg) => {
        if (msg.type === 'stop_agent') {
          return { type: 'ok', message: 'Agent stopped' };
        }
        return null;
      });

      await agentsCommand(defaultOptions, ['stop', 'agent-1']);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('stopped'));
    });

    it('should handle kill command', async () => {
      setupMockServer((msg) => {
        if (msg.type === 'kill_agent') {
          return { type: 'ok', message: 'Agent killed' };
        }
        return null;
      });

      await agentsCommand(defaultOptions, ['kill', 'agent-1']);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('killed'));
    });

    it('should require agent ID for pause', async () => {
      setupMockServer(() => null);

      await expect(agentsCommand(defaultOptions, ['pause'])).rejects.toThrow('process.exit(1)');

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    });

    it('should require agent ID for stop', async () => {
      setupMockServer(() => null);

      await expect(agentsCommand(defaultOptions, ['stop'])).rejects.toThrow('process.exit(1)');

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    });

    it('should require agent ID for kill', async () => {
      setupMockServer(() => null);

      await expect(agentsCommand(defaultOptions, ['kill'])).rejects.toThrow('process.exit(1)');

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    });

    it('should report unknown subcommand', async () => {
      setupMockServer(() => null);

      await expect(agentsCommand(defaultOptions, ['unknown-cmd'])).rejects.toThrow('process.exit(1)');

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown subcommand'));
    });

    it('should handle agent not found', async () => {
      setupMockServer((msg) => {
        if (msg.type === 'inspect_agent') {
          return { type: 'agent_info', agent: null };
        }
        return null;
      });

      await expect(agentsCommand(defaultOptions, ['inspect', 'nonexistent'])).rejects.toThrow('process.exit(1)');

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not found'));
    });
  });

  describe('statsCommand', () => {
    it('should display server statistics', async () => {
      setupMockServer((msg) => {
        if (msg.type === 'get_stats') {
          return {
            type: 'stats',
            uptime: 3600000,
            connections: 5,
            agents: 3,
            totalRequests: 100,
          };
        }
        return null;
      });

      await statsCommand(defaultOptions, []);

      const output = consoleSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('Hub Server Statistics');
      expect(output).toContain('1h 0m'); // formatted uptime
      expect(output).toContain('5'); // connections
      expect(output).toContain('3'); // agents
    });

    it('should output JSON when flag set', async () => {
      setupMockServer((msg) => {
        if (msg.type === 'get_stats') {
          return {
            type: 'stats',
            uptime: 1000,
            connections: 1,
            agents: 1,
            totalRequests: 10,
          };
        }
        return null;
      });

      await statsCommand({ ...defaultOptions, json: true }, []);

      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls[0][0];
      expect(output).toContain('"uptime"');
    });
  });

  describe('configCommand', () => {
    it('should show config', async () => {
      setupMockServer((msg) => {
        if (msg.type === 'get_config') {
          return {
            type: 'config',
            config: {
              port: 8080,
              sandboxPath: '/tmp/sandbox',
            },
          };
        }
        return null;
      });

      await configCommand(defaultOptions, ['show']);

      expect(consoleSpy).toHaveBeenCalled();
    });

    it('should default to show subcommand', async () => {
      setupMockServer((msg) => {
        if (msg.type === 'get_config') {
          return {
            type: 'config',
            config: { port: 8080 },
          };
        }
        return null;
      });

      await configCommand(defaultOptions, []);

      expect(consoleSpy).toHaveBeenCalled();
    });

    it('should handle config reload', async () => {
      setupMockServer((msg) => {
        if (msg.type === 'reload_config') {
          return { type: 'config_reloaded', success: true };
        }
        return null;
      });

      await configCommand(defaultOptions, ['reload']);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('reloaded'));
    });

    it('should report reload failure', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      setupMockServer((msg) => {
        if (msg.type === 'reload_config') {
          return { type: 'config_reloaded', success: false, error: 'Failed to reload' };
        }
        return null;
      });

      await configCommand(defaultOptions, ['reload']);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed'));
    });

    it('should report unknown subcommand', async () => {
      setupMockServer(() => null);

      await expect(configCommand(defaultOptions, ['invalid'])).rejects.toThrow('process.exit(1)');

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown subcommand'));
    });
  });

  describe('usageCommand', () => {
    it('should show usage statistics', async () => {
      setupMockServer((msg) => {
        if (msg.type === 'get_usage') {
          return {
            type: 'usage',
            data: {
              scope: 'global',
              entries: [
                { id: 'entry-1', name: 'Test', tokens: 1000, cost: 0.01, requests: 10 },
              ],
            },
          };
        }
        return null;
      });

      await usageCommand(defaultOptions, []);

      const output = consoleSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('Usage Statistics');
      expect(output).toContain('global');
    });

    it('should handle --scope flag', async () => {
      let receivedScope: string | undefined;

      setupMockServer((msg) => {
        if (msg.type === 'get_usage') {
          receivedScope = (msg as { type: string; scope?: string }).scope;
          return {
            type: 'usage',
            data: {
              scope: receivedScope || 'global',
              entries: [],
            },
          } as HubToAdmin;
        }
        return null;
      });

      await usageCommand(defaultOptions, ['--scope', 'agent']);

      expect(receivedScope).toBe('agent');
    });

    it('should show totals', async () => {
      setupMockServer((msg) => {
        if (msg.type === 'get_usage') {
          return {
            type: 'usage',
            data: {
              scope: 'global',
              entries: [
                { id: 'e1', name: 'A', tokens: 500, cost: 0.005, requests: 5 },
                { id: 'e2', name: 'B', tokens: 500, cost: 0.005, requests: 5 },
              ],
            },
          };
        }
        return null;
      });

      await usageCommand(defaultOptions, []);

      const output = consoleSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('Total:');
      expect(output).toContain('1,000 tokens');
    });

    it('should handle empty usage data', async () => {
      setupMockServer((msg) => {
        if (msg.type === 'get_usage') {
          return {
            type: 'usage',
            data: { scope: 'global', entries: [] },
          };
        }
        return null;
      });

      await usageCommand(defaultOptions, []);

      expect(consoleSpy).toHaveBeenCalledWith('No usage data available');
    });
  });

  describe('connectionsCommand', () => {
    it('should list connections', async () => {
      setupMockServer((msg) => {
        if (msg.type === 'list_connections') {
          return {
            type: 'connections_list',
            connections: [
              {
                id: 'conn-1',
                remoteAddress: '127.0.0.1:54321',
                authenticated: true,
                connectedAt: Date.now(),
                subscribedAgents: ['agent-1'],
              },
            ],
          } as HubToAdmin;
        }
        return null;
      });

      await connectionsCommand(defaultOptions, ['list']);

      const output = consoleSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('conn-1');
      expect(output).toContain('127.0.0.1:54321');
    });

    it('should handle empty connections', async () => {
      setupMockServer((msg) => {
        if (msg.type === 'list_connections') {
          return { type: 'connections_list', connections: [] };
        }
        return null;
      });

      await connectionsCommand(defaultOptions, ['list']);

      expect(consoleSpy).toHaveBeenCalledWith('No connections found');
    });

    it('should disconnect a connection', async () => {
      setupMockServer((msg) => {
        if (msg.type === 'disconnect') {
          return { type: 'ok', message: 'Disconnected' };
        }
        return null;
      });

      await connectionsCommand(defaultOptions, ['disconnect', 'conn-1']);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Disconnected'));
    });

    it('should require connection ID for disconnect', async () => {
      setupMockServer(() => null);

      await expect(connectionsCommand(defaultOptions, ['disconnect'])).rejects.toThrow('process.exit(1)');

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    });

    it('should report unknown subcommand', async () => {
      setupMockServer(() => null);

      await expect(connectionsCommand(defaultOptions, ['invalid'])).rejects.toThrow('process.exit(1)');

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown subcommand'));
    });
  });
});
