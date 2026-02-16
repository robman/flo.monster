/**
 * Tests for admin server observability features:
 * - Enriched agent info (model, provider, busy, lastActivity)
 * - Enriched agent list (model, provider)
 * - get_agent_schedules (filtered by agentId or all)
 * - get_agent_log (message history with limit)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createAdminServer, type AdminServer } from '../admin/server.js';
import type { HubServer } from '../server.js';
import type { HubConfig } from '../config.js';
import type { AdminToHub, HubToAdmin } from '@flo-monster/core';

/** Send a message and wait for a response of the given type */
function sendAndWait(
  ws: WebSocket,
  msg: AdminToHub,
  expectedType: string,
  timeout = 2000,
): Promise<HubToAdmin> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for ${expectedType}`)),
      timeout,
    );
    const handler = (data: unknown): void => {
      const parsed = JSON.parse(
        (data as Buffer).toString(),
      ) as HubToAdmin;
      if (parsed.type === expectedType) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(parsed);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify(msg));
  });
}

/** Send a message and wait for an error response */
function sendAndWaitError(
  ws: WebSocket,
  msg: AdminToHub,
  timeout = 2000,
): Promise<HubToAdmin & { type: 'error'; message: string }> {
  return sendAndWait(ws, msg, 'error', timeout) as Promise<
    HubToAdmin & { type: 'error'; message: string }
  >;
}

/**
 * Connect a WebSocket client and wait for auto-auth.
 * Sets up the message listener BEFORE the connection opens so the
 * auth_result message is never missed.
 */
function connectAndAuth(port: number, timeout = 5000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timeout waiting for WebSocket open + auth')),
      timeout,
    );
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);

    // Listen for messages immediately (before open fires)
    ws.on('message', function authHandler(data: unknown) {
      const msg = JSON.parse((data as Buffer).toString());
      if (msg.type === 'auth_result' && msg.success) {
        clearTimeout(timer);
        ws.off('message', authHandler);
        resolve(ws);
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Create a mock HeadlessAgentRunner */
function createMockRunner(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const configOverrides = (overrides.config as Record<string, unknown>) || {};
  const messages = (overrides.messages as Array<{ role: string; content: any[]; timestamp: number }>) || [
    { role: 'user', content: [{ type: 'text', text: 'Hello' }], timestamp: 1000 },
    { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }], timestamp: 2000 },
  ];

  return {
    config: {
      id: 'agent-1',
      name: 'Test Agent',
      model: 'claude-sonnet-4-5-20250929',
      provider: 'anthropic',
      tools: [],
      maxTokens: 4096,
      ...configOverrides,
    },
    getState: () => (overrides.state as string) || 'running',
    busy: overrides.busy ?? false,
    getMessageHistory: () => messages,
    serialize: () => ({
      agentId: configOverrides.id || 'agent-1',
      config: {
        name: configOverrides.name || 'Test Agent',
        model: configOverrides.model || 'claude-sonnet-4-5-20250929',
      },
      metadata: {
        createdAt: (overrides.createdAt as number) || 1000,
        totalTokens: (overrides.totalTokens as number) || 500,
        totalCost: (overrides.totalCost as number) || 0.01,
      },
      conversation: [],
    }),
    pause: vi.fn(),
    stop: vi.fn(),
    kill: vi.fn(),
  };
}

/** Create a mock Scheduler */
function createMockScheduler(
  schedules: Array<{
    id: string;
    hubAgentId: string;
    type: string;
    cronExpression?: string;
    message: string;
    enabled: boolean;
    runCount: number;
    createdAt: number;
    lastRunAt?: number;
  }> = [],
): { getSchedules: (agentId: string) => typeof schedules; serialize: () => typeof schedules } {
  return {
    getSchedules: (agentId: string) =>
      schedules.filter((s) => s.hubAgentId === agentId),
    serialize: () => schedules,
  };
}

/** Create a mock HubServer and admin server */
function createTestAdminServer(
  adminPort: number,
  agents: Map<string, unknown>,
  scheduler?: ReturnType<typeof createMockScheduler>,
  configOverrides?: Partial<HubConfig>,
): AdminServer {
  const hubServer = {
    wss: { close: vi.fn() },
    clients: new Set(),
    agents,
    agentStore: { delete: vi.fn() },
    scheduler,
  } as unknown as HubServer;

  const config: HubConfig = {
    port: 8765,
    host: '127.0.0.1',
    name: 'test-hub',
    adminPort,
    localhostBypassAuth: true,
    sandboxPath: '/tmp/sandbox',
    tools: {
      bash: { enabled: true, mode: 'restricted' as const },
      filesystem: { enabled: true, allowedPaths: ['/tmp'] },
    },
    fetchProxy: {
      enabled: false,
      allowedPatterns: [],
      blockedPatterns: [],
    },
    ...configOverrides,
  };

  return createAdminServer(config, hubServer, Date.now());
}

describe('Admin Server Observability', () => {
  let adminServer: AdminServer;
  let ws: WebSocket;
  const adminPort = 18900 + Math.floor(Math.random() * 100);

  afterAll(async () => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    if (adminServer) await adminServer.close();
  });

  describe('enriched agent info and schedules', () => {
    beforeAll(async () => {
      const agents = new Map<string, unknown>();
      agents.set(
        'hub-agent-1',
        createMockRunner({
          busy: true,
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'Hello' }], timestamp: 1000 },
            { role: 'assistant', content: [{ type: 'text', text: 'Hi!' }], timestamp: 2000 },
            { role: 'user', content: [{ type: 'text', text: 'Bye' }], timestamp: 3000 },
          ],
        }),
      );
      agents.set(
        'hub-agent-2',
        createMockRunner({
          config: {
            id: 'agent-2',
            name: 'Agent 2',
            model: 'gpt-4',
            provider: undefined,
            tools: [],
            maxTokens: 4096,
          },
          state: 'paused',
          busy: false,
          messages: [],
        }),
      );

      const scheduler = createMockScheduler([
        {
          id: 'sched-1',
          hubAgentId: 'hub-agent-1',
          type: 'cron',
          cronExpression: '*/5 * * * *',
          message: 'check updates',
          enabled: true,
          runCount: 5,
          createdAt: 1000,
          lastRunAt: 2000,
        },
      ]);

      adminServer = createTestAdminServer(adminPort, agents, scheduler);

      // Wait for WebSocket server to be listening
      await new Promise<void>((resolve) => {
        adminServer.wss.once('listening', resolve);
      });

      ws = await connectAndAuth(adminPort);
    });

    // ── inspect_agent (enriched) ──

    it('inspect_agent returns model, provider, busy, lastActivity', async () => {
      const response = await sendAndWait(
        ws,
        { type: 'inspect_agent', agentId: 'hub-agent-1' },
        'agent_info',
      );
      expect(response.type).toBe('agent_info');
      const agent = (response as HubToAdmin & { type: 'agent_info' }).agent;
      expect(agent).toBeTruthy();
      expect(agent!.model).toBe('claude-sonnet-4-5-20250929');
      expect(agent!.provider).toBe('anthropic');
      expect(agent!.busy).toBe(true);
      expect(agent!.lastActivity).toBe(3000);
      expect(agent!.messageCount).toBe(3);
    });

    it('inspect_agent without provider returns undefined provider', async () => {
      const response = await sendAndWait(
        ws,
        { type: 'inspect_agent', agentId: 'hub-agent-2' },
        'agent_info',
      );
      const agent = (response as HubToAdmin & { type: 'agent_info' }).agent;
      expect(agent).toBeTruthy();
      expect(agent!.provider).toBeUndefined();
      expect(agent!.busy).toBe(false);
      expect(agent!.model).toBe('gpt-4');
    });

    it('inspect_agent with no messages has undefined lastActivity', async () => {
      const response = await sendAndWait(
        ws,
        { type: 'inspect_agent', agentId: 'hub-agent-2' },
        'agent_info',
      );
      const agent = (response as HubToAdmin & { type: 'agent_info' }).agent;
      expect(agent).toBeTruthy();
      expect(agent!.lastActivity).toBeUndefined();
    });

    it('inspect_agent for unknown agent returns null', async () => {
      const response = await sendAndWait(
        ws,
        { type: 'inspect_agent', agentId: 'nonexistent' },
        'agent_info',
      );
      const agent = (response as HubToAdmin & { type: 'agent_info' }).agent;
      expect(agent).toBeNull();
    });

    // ── list_agents (enriched) ──

    it('list_agents includes model and provider', async () => {
      const response = await sendAndWait(
        ws,
        { type: 'list_agents' },
        'agents_list',
      );
      const agents = (response as HubToAdmin & { type: 'agents_list' }).agents;
      expect(agents).toHaveLength(2);

      const agent1 = agents.find((a) => a.id === 'hub-agent-1');
      expect(agent1).toBeTruthy();
      expect(agent1!.model).toBe('claude-sonnet-4-5-20250929');
      expect(agent1!.provider).toBe('anthropic');

      const agent2 = agents.find((a) => a.id === 'hub-agent-2');
      expect(agent2).toBeTruthy();
      expect(agent2!.model).toBe('gpt-4');
      expect(agent2!.provider).toBeUndefined();
    });

    it('list_agents includes state and messageCount', async () => {
      const response = await sendAndWait(
        ws,
        { type: 'list_agents' },
        'agents_list',
      );
      const agents = (response as HubToAdmin & { type: 'agents_list' }).agents;

      const agent1 = agents.find((a) => a.id === 'hub-agent-1');
      expect(agent1!.state).toBe('running');
      expect(agent1!.messageCount).toBe(3);

      const agent2 = agents.find((a) => a.id === 'hub-agent-2');
      expect(agent2!.state).toBe('paused');
      expect(agent2!.messageCount).toBe(0);
    });

    // ── get_agent_schedules ──

    it('get_agent_schedules returns schedules for specific agent', async () => {
      const response = await sendAndWait(
        ws,
        { type: 'get_agent_schedules', agentId: 'hub-agent-1' },
        'agent_schedules',
      );
      const schedules = (
        response as HubToAdmin & { type: 'agent_schedules' }
      ).schedules;
      expect(schedules).toHaveLength(1);
      expect(schedules[0].id).toBe('sched-1');
      expect(schedules[0].hubAgentId).toBe('hub-agent-1');
      expect(schedules[0].cronExpression).toBe('*/5 * * * *');
      expect(schedules[0].runCount).toBe(5);
      expect(schedules[0].enabled).toBe(true);
    });

    it('get_agent_schedules without agentId returns all schedules', async () => {
      const response = await sendAndWait(
        ws,
        { type: 'get_agent_schedules' } as AdminToHub,
        'agent_schedules',
      );
      const schedules = (
        response as HubToAdmin & { type: 'agent_schedules' }
      ).schedules;
      expect(schedules).toHaveLength(1);
      expect(schedules[0].id).toBe('sched-1');
    });

    it('get_agent_schedules for agent with no schedules returns empty', async () => {
      const response = await sendAndWait(
        ws,
        { type: 'get_agent_schedules', agentId: 'hub-agent-2' },
        'agent_schedules',
      );
      const schedules = (
        response as HubToAdmin & { type: 'agent_schedules' }
      ).schedules;
      expect(schedules).toHaveLength(0);
    });

    // ── get_agent_log ──

    it('get_agent_log returns message history', async () => {
      const response = await sendAndWait(
        ws,
        { type: 'get_agent_log', agentId: 'hub-agent-1' },
        'agent_log',
      );
      expect(response.type).toBe('agent_log');
      const resp = response as HubToAdmin & { type: 'agent_log' };
      expect(resp.agentId).toBe('hub-agent-1');
      expect(resp.messages).toHaveLength(3);
      expect(resp.messages[0].role).toBe('user');
      expect(resp.messages[0].content).toEqual([{ type: 'text', text: 'Hello' }]);
      expect(resp.messages[0].timestamp).toBe(1000);
    });

    it('get_agent_log respects limit param (returns last N messages)', async () => {
      const response = await sendAndWait(
        ws,
        { type: 'get_agent_log', agentId: 'hub-agent-1', limit: 2 },
        'agent_log',
      );
      const resp = response as HubToAdmin & { type: 'agent_log' };
      expect(resp.messages).toHaveLength(2);
      // Should be the last 2 messages (slice(-2))
      expect(resp.messages[0].content).toEqual([{ type: 'text', text: 'Hi!' }]);
      expect(resp.messages[1].content).toEqual([{ type: 'text', text: 'Bye' }]);
    });

    it('get_agent_log with limit 0 returns all messages', async () => {
      const response = await sendAndWait(
        ws,
        { type: 'get_agent_log', agentId: 'hub-agent-1', limit: 0 },
        'agent_log',
      );
      const resp = response as HubToAdmin & { type: 'agent_log' };
      expect(resp.messages).toHaveLength(3);
    });

    it('get_agent_log with no limit defaults to returning messages (default 50)', async () => {
      const response = await sendAndWait(
        ws,
        { type: 'get_agent_log', agentId: 'hub-agent-1' },
        'agent_log',
      );
      const resp = response as HubToAdmin & { type: 'agent_log' };
      // Our mock has only 3 messages, which is less than default limit of 50
      expect(resp.messages).toHaveLength(3);
    });

    it('get_agent_log for unknown agent returns error', async () => {
      const response = await sendAndWaitError(ws, {
        type: 'get_agent_log',
        agentId: 'nonexistent',
      });
      expect(response.type).toBe('error');
      expect(response.message).toContain('nonexistent');
    });

    it('get_agent_log for agent with no messages returns empty array', async () => {
      const response = await sendAndWait(
        ws,
        { type: 'get_agent_log', agentId: 'hub-agent-2' },
        'agent_log',
      );
      const resp = response as HubToAdmin & { type: 'agent_log' };
      expect(resp.messages).toHaveLength(0);
    });
  });

  describe('no scheduler configured', () => {
    let noSchedServer: AdminServer;
    let noSchedWs: WebSocket;
    const noSchedPort = 18800 + Math.floor(Math.random() * 100);

    beforeAll(async () => {
      const agents = new Map<string, unknown>();
      agents.set('hub-agent-1', createMockRunner());

      noSchedServer = createTestAdminServer(noSchedPort, agents);

      // Wait for WebSocket server to be listening
      await new Promise<void>((resolve) => {
        noSchedServer.wss.once('listening', resolve);
      });

      noSchedWs = await connectAndAuth(noSchedPort);
    });

    afterAll(async () => {
      if (noSchedWs && noSchedWs.readyState === WebSocket.OPEN)
        noSchedWs.close();
      if (noSchedServer) await noSchedServer.close();
    });

    it('get_agent_schedules returns empty when no scheduler exists', async () => {
      const response = await sendAndWait(
        noSchedWs,
        { type: 'get_agent_schedules', agentId: 'hub-agent-1' },
        'agent_schedules',
      );
      const schedules = (
        response as HubToAdmin & { type: 'agent_schedules' }
      ).schedules;
      expect(schedules).toHaveLength(0);
    });
  });
});

describe('Admin Auth Security', () => {
  describe('timing-safe comparison and rate limiting', () => {
    let server: AdminServer;
    const port = 18700 + Math.floor(Math.random() * 100);
    const adminToken = 'super-secret-admin-token-12345';

    beforeAll(async () => {
      server = createTestAdminServer(
        port,
        new Map(),
        undefined,
        { adminToken, localhostBypassAuth: false },
      );
      await new Promise<void>((resolve) => {
        server.wss.once('listening', resolve);
      });
    });

    afterAll(async () => {
      if (server) await server.close();
    });

    it('authenticates with correct token', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      try {
        await new Promise<void>((resolve, reject) => {
          ws.on('open', resolve);
          ws.on('error', reject);
        });

        const response = await sendAndWait(
          ws,
          { type: 'admin_auth', token: adminToken },
          'auth_result',
        );
        expect(response.type).toBe('auth_result');
        expect((response as any).success).toBe(true);
      } finally {
        if (ws.readyState === WebSocket.OPEN) ws.close();
      }
    });

    it('rejects incorrect token', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      try {
        await new Promise<void>((resolve, reject) => {
          ws.on('open', resolve);
          ws.on('error', reject);
        });

        const response = await sendAndWait(
          ws,
          { type: 'admin_auth', token: 'wrong-token' },
          'auth_result',
        );
        expect(response.type).toBe('auth_result');
        expect((response as any).success).toBe(false);
        expect((response as any).error).toBe('Invalid admin token');
      } finally {
        if (ws.readyState === WebSocket.OPEN) ws.close();
      }
    });

    it('rate limits after 5 failed attempts', async () => {
      // Make 5 failed attempts (some may already have been recorded from the previous test)
      for (let i = 0; i < 5; i++) {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        await new Promise<void>((resolve, reject) => {
          ws.on('open', resolve);
          ws.on('error', reject);
        });
        const resp = await sendAndWait(
          ws,
          { type: 'admin_auth', token: 'bad-token-' + i },
          'auth_result',
        );
        // Some may still succeed with auth_result (just not authenticated)
        expect(resp.type).toBe('auth_result');
        // Wait for close
        await new Promise<void>((resolve) => {
          ws.on('close', () => resolve());
          if (ws.readyState !== WebSocket.OPEN) resolve();
        });
      }

      // The 6th attempt should be rate limited
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });

      const response = await sendAndWait(
        ws,
        { type: 'admin_auth', token: 'bad-token-final' },
        'auth_result',
      );
      expect(response.type).toBe('auth_result');
      expect((response as any).success).toBe(false);
      expect((response as any).error).toContain('Too many failed attempts');

      await new Promise<void>((resolve) => {
        ws.on('close', () => resolve());
        if (ws.readyState !== WebSocket.OPEN) resolve();
      });
    });
  });
});
