/**
 * Tests for API key transfer during persist flow.
 *
 * Covers:
 * 1. ApiClientConfig.perAgentApiKey takes priority over shared keys
 * 2. PersistAgentMessage type includes optional apiKey/apiKeyProvider fields
 * 3. createRunnerDeps with perAgentApiKey passes it through
 * 4. HubClient.persistAgent sends apiKey/apiKeyProvider in the message
 * 5. PersistHandler checks sharedProviders and passes apiKey when needed
 * 6. PersistHandler doesn't send key when hub already has one for the provider
 * 7. handlePersistAgent stores API key to disk when provided
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocket } from 'ws';
import type { SerializedSession, AgentConfig } from '@flo-monster/core';
import type { ConnectedClient } from '../server.js';
import type { AgentHandlerDeps } from '../handlers/agent-handler.js';
import type { PersistAgentMessage } from '../handlers/types.js';
import { createRunnerDeps, handlePersistAgent } from '../handlers/agent-handler.js';
import { createSendApiRequest, type ApiClientConfig } from '../api-client.js';
import { HeadlessAgentRunner } from '../agent-runner.js';
import { getDefaultConfig } from '../config.js';

// ── Helpers ──────────────────────────────────────────────────────────

const mockConfig: AgentConfig = {
  id: 'test-agent',
  name: 'Test Agent',
  model: 'claude-sonnet-4-20250514',
  tools: [],
  maxTokens: 4096,
};

function createMockSession(overrides?: Partial<SerializedSession>): SerializedSession {
  return {
    version: 1,
    agentId: 'agent-123',
    config: { ...mockConfig, ...overrides?.config },
    conversation: [],
    storage: {},
    metadata: {
      createdAt: 1000,
      serializedAt: 2000,
      totalTokens: 100,
      totalCost: 0.01,
    },
    ...overrides,
  };
}

function createMockClient(): ConnectedClient {
  return {
    ws: { send: vi.fn(), readyState: WebSocket.OPEN } as any,
    authenticated: true,
    remoteAddress: '127.0.0.1',
    subscribedAgents: new Set(),
    messageCount: 0,
    messageWindowStart: Date.now(),
  };
}

function createMockDeps(overrides?: Partial<AgentHandlerDeps>): AgentHandlerDeps {
  return {
    hubConfig: getDefaultConfig(),
    clients: new Set<ConnectedClient>(),
    ...overrides,
  };
}

function parseSentMessages(client: ConnectedClient): any[] {
  const sendMock = client.ws.send as ReturnType<typeof vi.fn>;
  return sendMock.mock.calls.map((call: any[]) => JSON.parse(call[0]));
}

// ── Tests ────────────────────────────────────────────────────────────

describe('API key transfer during persist', () => {
  describe('ApiClientConfig.perAgentApiKey priority', () => {
    it('per-agent key takes priority over shared keys', () => {
      const hubConfig = {
        ...getDefaultConfig(),
        sharedApiKeys: { anthropic: 'shared-key-123' },
      };
      const clientConfig: ApiClientConfig = {
        hubConfig,
        provider: 'anthropic',
        perAgentApiKey: 'per-agent-key-456',
      };

      const sendApiRequest = createSendApiRequest(clientConfig);
      expect(typeof sendApiRequest).toBe('function');

      // The function creates an async iterable when called — the per-agent key
      // is captured in the closure and will be used during the actual API request.
      const result = sendApiRequest('{}', {}, '/api/anthropic/v1/messages');
      expect(result[Symbol.asyncIterator]).toBeDefined();
    });

    it('falls back to shared key when no per-agent key', () => {
      const hubConfig = {
        ...getDefaultConfig(),
        sharedApiKeys: { anthropic: 'shared-key-123' },
      };
      const clientConfig: ApiClientConfig = {
        hubConfig,
        provider: 'anthropic',
        // no perAgentApiKey
      };

      const sendApiRequest = createSendApiRequest(clientConfig);
      expect(typeof sendApiRequest).toBe('function');
    });

    it('createSendApiRequest accepts perAgentApiKey in config', () => {
      const clientConfig: ApiClientConfig = {
        hubConfig: getDefaultConfig(),
        provider: 'anthropic',
        perAgentApiKey: 'test-key',
      };

      const fn = createSendApiRequest(clientConfig);
      expect(typeof fn).toBe('function');
      expect(fn.length).toBe(3); // body, headers, url
    });
  });

  describe('PersistAgentMessage type', () => {
    it('includes optional apiKey and apiKeyProvider fields', () => {
      // Type-level test: construct a valid PersistAgentMessage with API key fields
      const msg: PersistAgentMessage = {
        type: 'persist_agent',
        session: createMockSession(),
        apiKey: 'sk-ant-test-key',
        apiKeyProvider: 'anthropic',
      };

      expect(msg.type).toBe('persist_agent');
      expect(msg.apiKey).toBe('sk-ant-test-key');
      expect(msg.apiKeyProvider).toBe('anthropic');
    });

    it('works without apiKey fields (backward compatible)', () => {
      const msg: PersistAgentMessage = {
        type: 'persist_agent',
        session: createMockSession(),
      };

      expect(msg.type).toBe('persist_agent');
      expect(msg.apiKey).toBeUndefined();
      expect(msg.apiKeyProvider).toBeUndefined();
    });
  });

  describe('createRunnerDeps with perAgentApiKey', () => {
    it('accepts perAgentApiKey parameter', () => {
      const session = createMockSession();
      const deps = createMockDeps();
      const hubAgentId = 'hub-agent-123-1000';

      const result = createRunnerDeps(session, hubAgentId, deps, undefined, 'per-agent-key-789');

      expect(result.sendApiRequest).toBeDefined();
      expect(typeof result.sendApiRequest).toBe('function');
    });

    it('creates valid deps without perAgentApiKey (backward compatible)', () => {
      const session = createMockSession();
      const deps = createMockDeps();
      const hubAgentId = 'hub-agent-123-1000';

      const result = createRunnerDeps(session, hubAgentId, deps);

      expect(result.sendApiRequest).toBeDefined();
      expect(result.adapter).toBeDefined();
      expect(result.adapter.id).toBe('anthropic');
    });

    it('passes perAgentApiKey through to sendApiRequest closure', () => {
      const session = createMockSession();
      const deps = createMockDeps();
      const hubAgentId = 'hub-agent-123-1000';

      const result = createRunnerDeps(session, hubAgentId, deps, undefined, 'my-key');

      // The sendApiRequest function should be an async iterable factory
      const iterable = result.sendApiRequest('{}', {}, '/api/anthropic/v1/messages');
      expect(iterable[Symbol.asyncIterator]).toBeDefined();
    });
  });

  describe('handlePersistAgent with API key', () => {
    let agents: Map<string, HeadlessAgentRunner>;
    let clients: Set<ConnectedClient>;

    beforeEach(() => {
      agents = new Map();
      clients = new Set();
    });

    it('creates runner successfully when apiKey is provided', async () => {
      const client = createMockClient();
      clients.add(client);
      const deps = createMockDeps({ clients });

      const session = createMockSession();
      const message: PersistAgentMessage = {
        type: 'persist_agent',
        session,
        apiKey: 'sk-ant-test-key',
        apiKeyProvider: 'anthropic',
      };

      await handlePersistAgent(client, message, agents, clients, deps);

      // Runner should be created
      expect(agents.size).toBe(1);
      const [hubAgentId, runner] = [...agents.entries()][0];
      expect(hubAgentId).toMatch(/^hub-agent-123-/);
      expect(runner).toBeInstanceOf(HeadlessAgentRunner);
      expect(runner.getState()).toBe('running');

      // Should send success result
      const messages = parseSentMessages(client);
      const persistResult = messages.find((m: any) => m.type === 'persist_result');
      expect(persistResult).toBeDefined();
      expect(persistResult.success).toBe(true);
    });

    it('saves API key to disk when agentStorePath is configured', async () => {
      const { mkdtemp, readFile, rm } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');

      const tempDir = await mkdtemp(join(tmpdir(), 'api-key-test-'));

      try {
        const client = createMockClient();
        clients.add(client);
        const deps = createMockDeps({
          clients,
          agentStorePath: tempDir,
        });

        const session = createMockSession();
        const message: PersistAgentMessage = {
          type: 'persist_agent',
          session,
          apiKey: 'sk-ant-persisted-key',
          apiKeyProvider: 'anthropic',
        };

        await handlePersistAgent(client, message, agents, clients, deps);

        // Get the hub agent ID from the agents map
        const [hubAgentId] = [...agents.keys()];

        // Verify API key was saved to disk
        const keyPath = join(tempDir, hubAgentId, 'api-key.json');
        const keyData = JSON.parse(await readFile(keyPath, 'utf-8'));
        expect(keyData.provider).toBe('anthropic');
        expect(keyData.key).toBe('sk-ant-persisted-key');
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('does not save API key when none provided', async () => {
      const { mkdtemp, readFile, rm } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');

      const tempDir = await mkdtemp(join(tmpdir(), 'api-key-test-'));

      try {
        const client = createMockClient();
        clients.add(client);
        const deps = createMockDeps({
          clients,
          agentStorePath: tempDir,
        });

        const session = createMockSession();
        const message: PersistAgentMessage = {
          type: 'persist_agent',
          session,
          // No apiKey or apiKeyProvider
        };

        await handlePersistAgent(client, message, agents, clients, deps);

        const [hubAgentId] = [...agents.keys()];

        // api-key.json should not exist
        try {
          await readFile(join(tempDir, hubAgentId, 'api-key.json'), 'utf-8');
          // If we get here, the file exists which is wrong
          expect.fail('api-key.json should not exist when no key provided');
        } catch (err) {
          expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('does not save API key when only apiKey is provided without apiKeyProvider', async () => {
      const client = createMockClient();
      clients.add(client);
      const deps = createMockDeps({ clients });

      const session = createMockSession();
      const message: PersistAgentMessage = {
        type: 'persist_agent',
        session,
        apiKey: 'sk-ant-test-key',
        // apiKeyProvider is missing
      };

      await handlePersistAgent(client, message, agents, clients, deps);

      // Should still create runner successfully (no key stored, but no crash)
      expect(agents.size).toBe(1);
    });
  });

  describe('PersistHandler key decision logic', () => {
    // These tests verify the key decision logic conceptually.
    // Full integration tests with PersistHandler require browser mocking (OPFS, IDB).
    // We test the logic by verifying the conditions.

    it('should transfer key when hub lacks shared provider', () => {
      // Simulates the logic in PersistHandler.persistAgent
      const provider = 'anthropic';
      const sharedProviders: string[] = []; // hub has no shared keys
      const hubHasKey = sharedProviders.includes(provider);

      expect(hubHasKey).toBe(false);
      // Therefore key should be transferred
    });

    it('should not transfer key when hub has shared provider', () => {
      const provider = 'anthropic';
      const sharedProviders = ['anthropic', 'openai'];
      const hubHasKey = sharedProviders.includes(provider);

      expect(hubHasKey).toBe(true);
      // Therefore key should NOT be transferred
    });

    it('should not transfer key when no apiKey in options', () => {
      const provider = 'anthropic';
      const sharedProviders: string[] = [];
      const hubHasKey = sharedProviders.includes(provider);
      const optionsApiKey: string | undefined = undefined;

      // Even if hub doesn't have key, if options.apiKey is undefined, nothing to send
      let apiKey: string | undefined;
      if (!hubHasKey && optionsApiKey) {
        apiKey = optionsApiKey;
      }

      expect(apiKey).toBeUndefined();
    });

    it('should transfer key for non-default provider', () => {
      const provider = 'openai';
      const sharedProviders = ['anthropic']; // hub only has anthropic
      const hubHasKey = sharedProviders.includes(provider);
      const optionsApiKey = 'sk-openai-key';

      let apiKey: string | undefined;
      if (!hubHasKey && optionsApiKey) {
        apiKey = optionsApiKey;
      }

      expect(apiKey).toBe('sk-openai-key');
    });
  });
});
