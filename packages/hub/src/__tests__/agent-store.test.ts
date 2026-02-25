/**
 * Tests for filesystem-based agent persistence
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { AgentStore } from '../agent-store.js';
import type { AgentStoreState } from '../agent-store.js';
import type { SerializedSession } from '@flo-monster/core';

const TEST_DIR = join(tmpdir(), `flo-agent-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

function createMockSession(agentId = 'test-agent'): SerializedSession {
  return {
    version: 2,
    agentId,
    config: {
      id: agentId,
      name: 'Test Agent',
      model: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
      tools: [],
      maxTokens: 4096,
    },
    conversation: [],
    storage: {},
    metadata: {
      createdAt: Date.now(),
      serializedAt: Date.now(),
      totalTokens: 100,
      totalCost: 0.01,
    },
  } as unknown as SerializedSession;
}

function createMockState(overrides: Partial<AgentStoreState> = {}): AgentStoreState {
  return {
    state: 'paused',
    totalTokens: 100,
    totalCost: 0.01,
    savedAt: Date.now(),
    ...overrides,
  };
}

describe('AgentStore', () => {
  let store: AgentStore;
  let storeDir: string;

  beforeEach(async () => {
    storeDir = join(TEST_DIR, `store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    store = new AgentStore(storeDir);
  });

  afterEach(async () => {
    await rm(storeDir, { recursive: true, force: true });
  });

  // Clean up the top-level test dir after all tests
  afterEach(async () => {
    // Attempt cleanup of TEST_DIR only if empty or at end
    try {
      const entries = await readdir(TEST_DIR);
      if (entries.length === 0) {
        await rm(TEST_DIR, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  });

  describe('init()', () => {
    it('should create the store directory', async () => {
      expect(existsSync(storeDir)).toBe(false);
      await store.init();
      expect(existsSync(storeDir)).toBe(true);
    });

    it('should not error if directory already exists', async () => {
      await mkdir(storeDir, { recursive: true });
      await expect(store.init()).resolves.toBeUndefined();
    });
  });

  describe('save() + load() round-trip', () => {
    it('should save and load session and state', async () => {
      await store.init();
      const session = createMockSession('agent-1');
      const state = createMockState();

      await store.save('agent-1', session, state);
      const loaded = await store.load('agent-1');

      expect(loaded).not.toBeNull();
      expect(loaded!.session).toEqual(session);
      expect(loaded!.state).toEqual(state);
    });

    it('should preserve all session fields through round-trip', async () => {
      await store.init();
      const session = createMockSession('round-trip-test');
      (session as any).config.name = 'Custom Name';
      (session as any).config.model = 'claude-opus-4-20250514';
      const state = createMockState({ totalTokens: 5000, totalCost: 1.23 });

      await store.save('round-trip-test', session, state);
      const loaded = await store.load('round-trip-test');

      expect(loaded).not.toBeNull();
      expect((loaded!.session as any).config.name).toBe('Custom Name');
      expect((loaded!.session as any).config.model).toBe('claude-opus-4-20250514');
      expect(loaded!.state.totalTokens).toBe(5000);
      expect(loaded!.state.totalCost).toBe(1.23);
    });
  });

  describe('save() with invalid ID', () => {
    it('should throw on ID containing path separator /', async () => {
      await store.init();
      await expect(
        store.save('../escape', createMockSession(), createMockState()),
      ).rejects.toThrow('Invalid hub agent ID');
    });

    it('should throw on ID containing backslash', async () => {
      await store.init();
      await expect(
        store.save('test\\agent', createMockSession(), createMockState()),
      ).rejects.toThrow('Invalid hub agent ID');
    });

    it('should throw on ID containing dots (path traversal)', async () => {
      await store.init();
      await expect(
        store.save('..', createMockSession(), createMockState()),
      ).rejects.toThrow('Invalid hub agent ID');
    });

    it('should throw on ID containing spaces', async () => {
      await store.init();
      await expect(
        store.save('agent name', createMockSession(), createMockState()),
      ).rejects.toThrow('Invalid hub agent ID');
    });

    it('should throw on empty ID', async () => {
      await store.init();
      await expect(
        store.save('', createMockSession(), createMockState()),
      ).rejects.toThrow('Invalid hub agent ID');
    });

    it('should accept valid IDs with alphanumeric, hyphens, and underscores', async () => {
      await store.init();
      await expect(
        store.save('valid-agent_123', createMockSession(), createMockState()),
      ).resolves.toBeUndefined();
    });
  });

  describe('save() overwrites', () => {
    it('should overwrite existing data when saving with same ID', async () => {
      await store.init();
      const session1 = createMockSession('overwrite-test');
      (session1 as any).config.name = 'First';
      const state1 = createMockState({ totalCost: 0.01 });

      await store.save('overwrite-test', session1, state1);

      const session2 = createMockSession('overwrite-test');
      (session2 as any).config.name = 'Second';
      const state2 = createMockState({ totalCost: 0.99 });

      await store.save('overwrite-test', session2, state2);

      const loaded = await store.load('overwrite-test');
      expect(loaded).not.toBeNull();
      expect((loaded!.session as any).config.name).toBe('Second');
      expect(loaded!.state.totalCost).toBe(0.99);
    });
  });

  describe('load() for non-existent agent', () => {
    it('should return null when agent does not exist', async () => {
      await store.init();
      const result = await store.load('non-existent');
      expect(result).toBeNull();
    });

    it('should return null when store directory does not exist', async () => {
      // Don't call init() - store directory doesn't exist
      const result = await store.load('non-existent');
      expect(result).toBeNull();
    });
  });

  describe('delete()', () => {
    it('should remove the agent directory', async () => {
      await store.init();
      const session = createMockSession('delete-me');
      const state = createMockState();

      await store.save('delete-me', session, state);
      expect(store.exists('delete-me')).toBe(true);

      await store.delete('delete-me');
      expect(store.exists('delete-me')).toBe(false);

      const loaded = await store.load('delete-me');
      expect(loaded).toBeNull();
    });

    it('should not error when deleting non-existent agent', async () => {
      await store.init();
      await expect(store.delete('no-such-agent')).resolves.toBeUndefined();
    });

    it('should reject invalid IDs', async () => {
      await store.init();
      await expect(store.delete('../escape')).rejects.toThrow('Invalid hub agent ID');
    });

    it('should remove sandbox directory when sandboxBasePath is set', async () => {
      const sandboxBase = join(storeDir, '..', `sandbox-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(sandboxBase, { recursive: true });
      const storeWithSandbox = new AgentStore(storeDir, sandboxBase);
      await storeWithSandbox.init();

      // Save an agent and create its sandbox directory
      await storeWithSandbox.save('sandbox-agent', createMockSession('sandbox-agent'), createMockState());
      const sandboxDir = join(sandboxBase, 'sandbox-agent');
      await mkdir(sandboxDir, { recursive: true });
      await writeFile(join(sandboxDir, 'test-file.txt'), 'hello', 'utf-8');
      expect(existsSync(sandboxDir)).toBe(true);

      // Delete should remove both agent store dir and sandbox dir
      await storeWithSandbox.delete('sandbox-agent');
      expect(storeWithSandbox.exists('sandbox-agent')).toBe(false);
      expect(existsSync(sandboxDir)).toBe(false);

      // Clean up
      await rm(sandboxBase, { recursive: true, force: true });
    });

    it('should not error when sandbox directory does not exist', async () => {
      const sandboxBase = join(storeDir, '..', `sandbox-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const storeWithSandbox = new AgentStore(storeDir, sandboxBase);
      await storeWithSandbox.init();

      await storeWithSandbox.save('no-sandbox', createMockSession('no-sandbox'), createMockState());
      // Don't create the sandbox directory — delete should still succeed
      await expect(storeWithSandbox.delete('no-sandbox')).resolves.toBeUndefined();
    });
  });

  describe('list()', () => {
    it('should return summaries of all saved agents', async () => {
      await store.init();

      const session1 = createMockSession('agent-1');
      (session1 as any).config.name = 'Agent One';
      (session1 as any).config.model = 'claude-sonnet-4-20250514';
      (session1 as any).config.provider = 'anthropic';
      (session1 as any).metadata.createdAt = 1000;
      const state1 = createMockState({ state: 'paused', totalCost: 0.5, savedAt: 2000 });

      const session2 = createMockSession('agent-2');
      (session2 as any).config.name = 'Agent Two';
      (session2 as any).config.model = 'gpt-4o';
      (session2 as any).config.provider = 'openai';
      (session2 as any).metadata.createdAt = 3000;
      const state2 = createMockState({ state: 'running', totalCost: 1.5, savedAt: 4000 });

      await store.save('agent-1', session1, state1);
      await store.save('agent-2', session2, state2);

      const summaries = await store.list();
      expect(summaries).toHaveLength(2);

      const s1 = summaries.find((s) => s.hubAgentId === 'agent-1');
      expect(s1).toBeDefined();
      expect(s1!.agentName).toBe('Agent One');
      expect(s1!.model).toBe('claude-sonnet-4-20250514');
      expect(s1!.provider).toBe('anthropic');
      expect(s1!.state).toBe('paused');
      expect(s1!.totalCost).toBe(0.5);
      expect(s1!.createdAt).toBe(1000);
      expect(s1!.lastActivity).toBe(2000);

      const s2 = summaries.find((s) => s.hubAgentId === 'agent-2');
      expect(s2).toBeDefined();
      expect(s2!.agentName).toBe('Agent Two');
      expect(s2!.model).toBe('gpt-4o');
      expect(s2!.provider).toBe('openai');
      expect(s2!.state).toBe('running');
      expect(s2!.totalCost).toBe(1.5);
    });

    it('should default provider to anthropic when not set', async () => {
      await store.init();
      const session = createMockSession('no-provider');
      delete (session as any).config.provider;
      const state = createMockState();

      await store.save('no-provider', session, state);

      const summaries = await store.list();
      expect(summaries).toHaveLength(1);
      expect(summaries[0].provider).toBe('anthropic');
    });
  });

  describe('list() on empty store', () => {
    it('should return empty array when store is empty', async () => {
      await store.init();
      const summaries = await store.list();
      expect(summaries).toEqual([]);
    });

    it('should return empty array when store directory does not exist', async () => {
      // Don't call init()
      const summaries = await store.list();
      expect(summaries).toEqual([]);
    });
  });

  describe('list() skips corrupted entries', () => {
    it('should skip entries with invalid JSON', async () => {
      await store.init();

      // Save a valid agent
      await store.save('good-agent', createMockSession('good-agent'), createMockState());

      // Create a corrupted agent directory
      const corruptDir = join(storeDir, 'corrupt-agent');
      await mkdir(corruptDir, { recursive: true });
      await writeFile(join(corruptDir, 'session.json'), 'not valid json', 'utf-8');
      await writeFile(join(corruptDir, 'state.json'), '{}', 'utf-8');

      const summaries = await store.list();
      expect(summaries).toHaveLength(1);
      expect(summaries[0].hubAgentId).toBe('good-agent');
    });

    it('should skip entries with missing files', async () => {
      await store.init();

      // Save a valid agent
      await store.save('good-agent', createMockSession('good-agent'), createMockState());

      // Create an agent directory with only session.json (missing state.json)
      const partialDir = join(storeDir, 'partial-agent');
      await mkdir(partialDir, { recursive: true });
      await writeFile(join(partialDir, 'session.json'), '{}', 'utf-8');

      const summaries = await store.list();
      expect(summaries).toHaveLength(1);
      expect(summaries[0].hubAgentId).toBe('good-agent');
    });

    it('should skip directories with unsafe names', async () => {
      await store.init();

      await store.save('good-agent', createMockSession('good-agent'), createMockState());

      // Manually create a directory with an unsafe name
      const unsafeDir = join(storeDir, 'has spaces');
      await mkdir(unsafeDir, { recursive: true });
      await writeFile(join(unsafeDir, 'session.json'), '{}', 'utf-8');
      await writeFile(join(unsafeDir, 'state.json'), '{}', 'utf-8');

      const summaries = await store.list();
      expect(summaries).toHaveLength(1);
      expect(summaries[0].hubAgentId).toBe('good-agent');
    });
  });

  describe('exists()', () => {
    it('should return true for saved agents', async () => {
      await store.init();
      await store.save('my-agent', createMockSession(), createMockState());
      expect(store.exists('my-agent')).toBe(true);
    });

    it('should return false for non-existent agents', async () => {
      await store.init();
      expect(store.exists('no-such-agent')).toBe(false);
    });

    it('should return false after deletion', async () => {
      await store.init();
      await store.save('temp-agent', createMockSession(), createMockState());
      await store.delete('temp-agent');
      expect(store.exists('temp-agent')).toBe(false);
    });

    it('should reject invalid IDs', () => {
      expect(() => store.exists('../escape')).toThrow('Invalid hub agent ID');
    });
  });

  describe('atomic write safety', () => {
    it('should not leave temp files after successful write', async () => {
      await store.init();
      await store.save('atomic-test', createMockSession(), createMockState());

      const agentDir = join(storeDir, 'atomic-test');
      const files = await readdir(agentDir);

      // Should only have session.json and state.json, no .tmp files
      expect(files.sort()).toEqual(['session.json', 'state.json']);
      const tmpFiles = files.filter((f) => f.includes('.tmp.'));
      expect(tmpFiles).toHaveLength(0);
    });

    it('should have valid JSON in both files after save', async () => {
      await store.init();
      const session = createMockSession('json-check');
      const state = createMockState();

      await store.save('json-check', session, state);

      const agentDir = join(storeDir, 'json-check');
      const sessionContent = await readFile(join(agentDir, 'session.json'), 'utf-8');
      const stateContent = await readFile(join(agentDir, 'state.json'), 'utf-8');

      // Both should parse without error
      expect(() => JSON.parse(sessionContent)).not.toThrow();
      expect(() => JSON.parse(stateContent)).not.toThrow();

      // And match what we saved
      expect(JSON.parse(sessionContent)).toEqual(session);
      expect(JSON.parse(stateContent)).toEqual(state);
    });
  });

  describe('file permissions', () => {
    it('should set session.json and state.json to mode 0o600', async () => {
      await store.init();
      await store.save('perm-test', createMockSession('perm-test'), createMockState());

      const agentDir = join(storeDir, 'perm-test');
      const sessionStat = await stat(join(agentDir, 'session.json'));
      const stateStat = await stat(join(agentDir, 'state.json'));

      // Mask with 0o777 to get just the permission bits
      expect(sessionStat.mode & 0o777).toBe(0o600);
      expect(stateStat.mode & 0o777).toBe(0o600);
    });
  });

  describe('path traversal prevention', () => {
    it('should reject IDs with ..', async () => {
      await store.init();
      await expect(store.save('..', createMockSession(), createMockState())).rejects.toThrow(
        'Invalid hub agent ID',
      );
    });

    it('should reject IDs with /', async () => {
      await store.init();
      await expect(store.save('a/b', createMockSession(), createMockState())).rejects.toThrow(
        'Invalid hub agent ID',
      );
    });

    it('should reject IDs with backslash', async () => {
      await store.init();
      await expect(store.save('a\\b', createMockSession(), createMockState())).rejects.toThrow(
        'Invalid hub agent ID',
      );
    });

    it('should reject IDs with null bytes', async () => {
      await store.init();
      await expect(store.save('a\x00b', createMockSession(), createMockState())).rejects.toThrow(
        'Invalid hub agent ID',
      );
    });

    it('should reject load with traversal ID', async () => {
      await store.init();
      await expect(store.load('../../etc/passwd')).rejects.toThrow('Invalid hub agent ID');
    });

    it('should reject delete with traversal ID', async () => {
      await store.init();
      await expect(store.delete('../../tmp')).rejects.toThrow('Invalid hub agent ID');
    });

    it('should reject exists with traversal ID', () => {
      expect(() => store.exists('../../etc')).toThrow('Invalid hub agent ID');
    });
  });
});
