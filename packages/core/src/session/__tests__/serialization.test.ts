/**
 * Tests for session serialization
 */

import { describe, it, expect } from 'vitest';
import {
  serializeSession,
  deserializeSession,
  validateSession,
  migrateSessionV1ToV2,
  type SerializedSession,
  type SerializedFile,
  type SerializedDomState,
  type SerializedListener,
  type SessionDependencies,
  type SkillDependency,
  type ExtensionDependency,
} from '../serialization.js';
import type { AgentConfig } from '../../types/agent.js';

describe('session serialization', () => {
  const mockConfig: AgentConfig = {
    id: 'test-agent',
    name: 'Test Agent',
    model: 'claude-sonnet-4-20250514',
    tools: [],
    maxTokens: 4096,
  };

  const mockMetadata = {
    createdAt: 1000,
    totalTokens: 500,
    totalCost: 0.01,
  };

  describe('serializeSession', () => {
    it('should create a valid session structure', () => {
      const conversation = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ];
      const storage = { key1: 'value1' };

      const session = serializeSession(
        'agent-123',
        mockConfig,
        conversation,
        storage,
        mockMetadata,
      );

      expect(session.version).toBe(2);
      expect(session.agentId).toBe('agent-123');
      expect(session.config).toBe(mockConfig);
      expect(session.conversation).toBe(conversation);
      expect(session.storage).toBe(storage);
      expect(session.metadata.createdAt).toBe(1000);
      expect(session.metadata.totalTokens).toBe(500);
      expect(session.metadata.totalCost).toBe(0.01);
      expect(session.metadata.serializedAt).toBeGreaterThan(0);
    });

    it('should include files when provided', () => {
      const files: SerializedFile[] = [
        { path: 'test.txt', content: 'hello', encoding: 'utf8' },
      ];

      const session = serializeSession(
        'agent-123',
        mockConfig,
        [],
        {},
        mockMetadata,
        { files },
      );

      expect(session.files).toBe(files);
      expect(session.files).toHaveLength(1);
      expect(session.files![0].path).toBe('test.txt');
    });

    it('should include subagents when provided', () => {
      const subSession: SerializedSession = {
        version: 1,
        agentId: 'sub-1',
        config: { ...mockConfig, id: 'sub-1' },
        conversation: [],
        storage: {},
        metadata: { createdAt: 1000, serializedAt: 1001, totalTokens: 0, totalCost: 0 },
      };

      const session = serializeSession(
        'agent-123',
        mockConfig,
        [],
        {},
        mockMetadata,
        { subagents: [subSession] },
      );

      expect(session.subagents).toHaveLength(1);
      expect(session.subagents![0].agentId).toBe('sub-1');
    });
  });

  describe('deserializeSession', () => {
    it('should extract data correctly', () => {
      const session: SerializedSession = {
        version: 1,
        agentId: 'test-agent',
        config: mockConfig,
        conversation: [{ role: 'user', content: 'test' }],
        storage: { foo: 'bar' },
        metadata: {
          createdAt: 1000,
          serializedAt: 2000,
          totalTokens: 100,
          totalCost: 0.005,
        },
      };

      const result = deserializeSession(session);

      expect(result.agentId).toBe('test-agent');
      expect(result.config).toBe(mockConfig);
      expect(result.conversation).toEqual([{ role: 'user', content: 'test' }]);
      expect(result.storage).toEqual({ foo: 'bar' });
      expect(result.metadata.createdAt).toBe(1000);
    });

    it('should handle optional files and subagents', () => {
      const files: SerializedFile[] = [
        { path: 'a.txt', content: 'a', encoding: 'utf8' },
      ];
      const subagents: SerializedSession[] = [
        {
          version: 1,
          agentId: 'sub',
          config: mockConfig,
          conversation: [],
          storage: {},
          metadata: { createdAt: 1, serializedAt: 2, totalTokens: 0, totalCost: 0 },
        },
      ];

      const session: SerializedSession = {
        version: 1,
        agentId: 'main',
        config: mockConfig,
        conversation: [],
        storage: {},
        files,
        subagents,
        metadata: { createdAt: 1, serializedAt: 2, totalTokens: 0, totalCost: 0 },
      };

      const result = deserializeSession(session);

      expect(result.files).toBe(files);
      expect(result.subagents).toBe(subagents);
    });
  });

  describe('validateSession', () => {
    it('should validate a correct session', () => {
      const session: SerializedSession = {
        version: 1,
        agentId: 'test',
        config: mockConfig,
        conversation: [],
        storage: {},
        metadata: {
          createdAt: 1000,
          serializedAt: 2000,
          totalTokens: 0,
          totalCost: 0,
        },
      };

      expect(validateSession(session)).toBe(true);
    });

    it('should reject wrong version', () => {
      const session = {
        version: 99,
        agentId: 'test',
        config: mockConfig,
        conversation: [],
        storage: {},
        metadata: {
          createdAt: 1000,
          serializedAt: 2000,
          totalTokens: 0,
          totalCost: 0,
        },
      };

      expect(validateSession(session)).toBe(false);
    });

    it('should validate v2 sessions with dependencies', () => {
      const session = {
        version: 2,
        agentId: 'test',
        config: mockConfig,
        conversation: [],
        storage: {},
        metadata: {
          createdAt: 1000,
          serializedAt: 2000,
          totalTokens: 0,
          totalCost: 0,
        },
        dependencies: {
          skills: [
            { name: 'commit', source: { type: 'builtin' } },
            { name: 'custom', source: { type: 'url', url: 'https://example.com/skill.md' } },
          ],
          extensions: [
            { id: 'ext-1', source: { type: 'builtin' } },
          ],
        },
      };

      expect(validateSession(session)).toBe(true);
    });

    it('should validate v2 sessions with domState', () => {
      const session = {
        version: 2,
        agentId: 'test',
        config: mockConfig,
        conversation: [],
        storage: {},
        metadata: {
          createdAt: 1000,
          serializedAt: 2000,
          totalTokens: 0,
          totalCost: 0,
        },
        domState: {
          viewportHtml: '<div>Hello</div>',
          listeners: [],
          capturedAt: 1000,
        },
      };

      expect(validateSession(session)).toBe(true);
    });

    it('should reject v2 sessions with invalid dependencies', () => {
      const session = {
        version: 2,
        agentId: 'test',
        config: mockConfig,
        conversation: [],
        storage: {},
        metadata: {
          createdAt: 1000,
          serializedAt: 2000,
          totalTokens: 0,
          totalCost: 0,
        },
        dependencies: {
          skills: [{ name: 'test', source: { type: 'invalid' } }],
          extensions: [],
        },
      };

      expect(validateSession(session)).toBe(false);
    });

    it('should reject v2 sessions with invalid domState', () => {
      const session = {
        version: 2,
        agentId: 'test',
        config: mockConfig,
        conversation: [],
        storage: {},
        metadata: {
          createdAt: 1000,
          serializedAt: 2000,
          totalTokens: 0,
          totalCost: 0,
        },
        domState: {
          viewportHtml: 123, // should be string
          listeners: [],
          capturedAt: 1000,
        },
      };

      expect(validateSession(session)).toBe(false);
    });

    it('should reject invalid data types', () => {
      expect(validateSession(null)).toBe(false);
      expect(validateSession(undefined)).toBe(false);
      expect(validateSession('string')).toBe(false);
      expect(validateSession(123)).toBe(false);
    });

    it('should reject missing required fields', () => {
      // Missing agentId
      expect(validateSession({
        version: 1,
        config: {},
        conversation: [],
        storage: {},
        metadata: { createdAt: 1, serializedAt: 2, totalTokens: 0, totalCost: 0 },
      })).toBe(false);

      // Empty agentId
      expect(validateSession({
        version: 1,
        agentId: '',
        config: {},
        conversation: [],
        storage: {},
        metadata: { createdAt: 1, serializedAt: 2, totalTokens: 0, totalCost: 0 },
      })).toBe(false);
    });

    it('should validate files when present', () => {
      // Valid files
      const validSession = {
        version: 1,
        agentId: 'test',
        config: {},
        conversation: [],
        storage: {},
        files: [{ path: 'a.txt', content: 'hi', encoding: 'utf8' }],
        metadata: { createdAt: 1, serializedAt: 2, totalTokens: 0, totalCost: 0 },
      };
      expect(validateSession(validSession)).toBe(true);

      // Invalid file encoding
      const invalidSession = {
        version: 1,
        agentId: 'test',
        config: {},
        conversation: [],
        storage: {},
        files: [{ path: 'a.txt', content: 'hi', encoding: 'invalid' }],
        metadata: { createdAt: 1, serializedAt: 2, totalTokens: 0, totalCost: 0 },
      };
      expect(validateSession(invalidSession)).toBe(false);
    });

    it('should recursively validate subagents', () => {
      // Valid subagent
      const validSession = {
        version: 1,
        agentId: 'main',
        config: {},
        conversation: [],
        storage: {},
        subagents: [{
          version: 1,
          agentId: 'sub',
          config: {},
          conversation: [],
          storage: {},
          metadata: { createdAt: 1, serializedAt: 2, totalTokens: 0, totalCost: 0 },
        }],
        metadata: { createdAt: 1, serializedAt: 2, totalTokens: 0, totalCost: 0 },
      };
      expect(validateSession(validSession)).toBe(true);

      // Invalid subagent (wrong version)
      const invalidSession = {
        version: 1,
        agentId: 'main',
        config: {},
        conversation: [],
        storage: {},
        subagents: [{
          version: 99,
          agentId: 'sub',
          config: {},
          conversation: [],
          storage: {},
          metadata: { createdAt: 1, serializedAt: 2, totalTokens: 0, totalCost: 0 },
        }],
        metadata: { createdAt: 1, serializedAt: 2, totalTokens: 0, totalCost: 0 },
      };
      expect(validateSession(invalidSession)).toBe(false);
    });
  });

  describe('migrateSessionV1ToV2', () => {
    it('should migrate v1 session to v2', () => {
      const v1Session: SerializedSession = {
        version: 1,
        agentId: 'test',
        config: mockConfig,
        conversation: [{ role: 'user', content: 'test' }],
        storage: { key: 'value' },
        metadata: {
          createdAt: 1000,
          serializedAt: 2000,
          totalTokens: 100,
          totalCost: 0.01,
        },
      };

      const v2Session = migrateSessionV1ToV2(v1Session);

      expect(v2Session.version).toBe(2);
      expect(v2Session.agentId).toBe('test');
      expect(v2Session.conversation).toEqual([{ role: 'user', content: 'test' }]);
      expect(v2Session.storage).toEqual({ key: 'value' });
      expect(v2Session.dependencies).toEqual({ skills: [], extensions: [] });
    });

    it('should not modify already v2 sessions', () => {
      const v2Session: SerializedSession = {
        version: 2,
        agentId: 'test',
        config: mockConfig,
        conversation: [],
        storage: {},
        metadata: {
          createdAt: 1000,
          serializedAt: 2000,
          totalTokens: 0,
          totalCost: 0,
        },
        dependencies: {
          skills: [{ name: 'commit', source: { type: 'builtin' } }],
          extensions: [],
        },
      };

      const result = migrateSessionV1ToV2(v2Session);

      expect(result).toBe(v2Session);
      expect(result.dependencies?.skills).toHaveLength(1);
    });

    it('should preserve files and subagents during migration', () => {
      const v1Session: SerializedSession = {
        version: 1,
        agentId: 'main',
        config: mockConfig,
        conversation: [],
        storage: {},
        files: [{ path: 'test.txt', content: 'hello', encoding: 'utf8' }],
        subagents: [{
          version: 1,
          agentId: 'sub',
          config: mockConfig,
          conversation: [],
          storage: {},
          metadata: { createdAt: 1, serializedAt: 2, totalTokens: 0, totalCost: 0 },
        }],
        metadata: {
          createdAt: 1000,
          serializedAt: 2000,
          totalTokens: 0,
          totalCost: 0,
        },
      };

      const v2Session = migrateSessionV1ToV2(v1Session);

      expect(v2Session.files).toHaveLength(1);
      expect(v2Session.subagents).toHaveLength(1);
    });
  });

  describe('serializeSession with v2 options', () => {
    it('should include dependencies when provided', () => {
      const dependencies: SessionDependencies = {
        skills: [
          { name: 'commit', source: { type: 'builtin' } },
        ],
        extensions: [
          { id: 'ext-1', source: { type: 'url', url: 'https://example.com/ext' } },
        ],
        hooks: {
          PreToolUse: [{ hooks: [{ type: 'action', action: 'allow' }] }],
        },
      };

      const session = serializeSession(
        'agent-123',
        mockConfig,
        [],
        {},
        mockMetadata,
        { dependencies },
      );

      expect(session.dependencies).toBeDefined();
      expect(session.dependencies?.skills).toHaveLength(1);
      expect(session.dependencies?.skills[0].name).toBe('commit');
      expect(session.dependencies?.extensions).toHaveLength(1);
      expect(session.dependencies?.hooks?.PreToolUse).toHaveLength(1);
    });

    it('should include domState when provided', () => {
      const domState: SerializedDomState = {
        viewportHtml: '<div id="app">Content</div>',
        listeners: [
          { selector: '#btn', events: ['click'], workerId: 'main' },
        ],
        capturedAt: Date.now(),
      };

      const session = serializeSession(
        'agent-123',
        mockConfig,
        [],
        {},
        mockMetadata,
        { domState },
      );

      expect(session.domState).toBeDefined();
      expect(session.domState?.viewportHtml).toBe('<div id="app">Content</div>');
      expect(session.domState?.listeners).toHaveLength(1);
    });
  });

  describe('deserializeSession with v2 fields', () => {
    it('should extract dependencies and domState', () => {
      const session: SerializedSession = {
        version: 2,
        agentId: 'test',
        config: mockConfig,
        conversation: [],
        storage: {},
        metadata: {
          createdAt: 1000,
          serializedAt: 2000,
          totalTokens: 0,
          totalCost: 0,
        },
        dependencies: {
          skills: [{ name: 'test-skill', source: { type: 'local' } }],
          extensions: [],
        },
        domState: {
          viewportHtml: '<div></div>',
          listeners: [],
          capturedAt: 1000,
        },
      };

      const result = deserializeSession(session);

      expect(result.dependencies).toBeDefined();
      expect(result.dependencies?.skills[0].name).toBe('test-skill');
      expect(result.domState).toBeDefined();
      expect(result.domState?.viewportHtml).toBe('<div></div>');
    });
  });

  describe('dependency types', () => {
    it('SkillDependency should support inline fallback', () => {
      const dep: SkillDependency = {
        name: 'custom-skill',
        source: { type: 'url', url: 'https://example.com/skill.md' },
        inline: {
          name: 'custom-skill',
          manifest: {
            name: 'custom-skill',
            description: 'A custom skill',
          },
          instructions: 'Do something',
          source: { type: 'url', url: 'https://example.com/skill.md' },
          installedAt: Date.now(),
        },
      };

      expect(dep.inline?.manifest.description).toBe('A custom skill');
    });

    it('ExtensionDependency should support inline manifest', () => {
      const dep: ExtensionDependency = {
        id: 'my-ext',
        source: { type: 'url', url: 'https://example.com/ext' },
        inline: {
          manifest: {
            id: 'my-ext',
            name: 'My Extension',
            version: '1.0.0',
          },
          systemPromptAddition: 'Additional instructions',
        },
      };

      expect(dep.inline?.manifest.name).toBe('My Extension');
      expect(dep.inline?.systemPromptAddition).toBe('Additional instructions');
    });
  });

  describe('SerializedDomState type structure', () => {
    it('should have correct shape with viewportHtml, listeners, and capturedAt', () => {
      const domState: SerializedDomState = {
        viewportHtml: '<div>Hello</div>',
        listeners: [],
        capturedAt: Date.now(),
      };

      expect(domState.viewportHtml).toBe('<div>Hello</div>');
      expect(domState.listeners).toEqual([]);
      expect(typeof domState.capturedAt).toBe('number');
    });

    it('should accept listeners with full structure', () => {
      const listener: SerializedListener = {
        selector: '#myButton',
        events: ['click', 'mouseenter'],
        workerId: 'main',
        options: { debounce: 100 },
      };

      const domState: SerializedDomState = {
        viewportHtml: '<button id="myButton">Click</button>',
        listeners: [listener],
        capturedAt: Date.now(),
      };

      expect(domState.listeners).toHaveLength(1);
      expect(domState.listeners[0].selector).toBe('#myButton');
      expect(domState.listeners[0].events).toEqual(['click', 'mouseenter']);
      expect(domState.listeners[0].workerId).toBe('main');
      expect(domState.listeners[0].options?.debounce).toBe(100);
    });

    it('should allow listeners without options', () => {
      const listener: SerializedListener = {
        selector: 'form',
        events: ['submit'],
        workerId: 'sub-1',
      };

      expect(listener.options).toBeUndefined();
    });

    it('should support multiple listeners with different workerIds', () => {
      const listeners: SerializedListener[] = [
        { selector: '#form1', events: ['submit'], workerId: 'main' },
        { selector: '#form2', events: ['submit'], workerId: 'sub-1' },
        { selector: '.input', events: ['input', 'change'], workerId: 'main', options: { debounce: 200 } },
      ];

      const domState: SerializedDomState = {
        viewportHtml: '<form id="form1"></form><form id="form2"></form>',
        listeners,
        capturedAt: Date.now(),
      };

      expect(domState.listeners).toHaveLength(3);
      const workerIds = domState.listeners.map(l => l.workerId);
      expect(workerIds).toContain('main');
      expect(workerIds).toContain('sub-1');
    });
  });
});
