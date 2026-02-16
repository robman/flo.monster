/**
 * Tests for hub context generation
 */

import { describe, it, expect, vi } from 'vitest';
import { generateHubContext } from '../hub-context.js';
import type { AgentConfig } from '@flo-monster/core';
import type { HubClient, HubConnection } from '../hub-client.js';

describe('hub-context', () => {
  const createMockConfig = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
    id: 'test-agent',
    name: 'Test Agent',
    model: 'claude-sonnet-4-20250514',
    systemPrompt: 'You are a helpful assistant.',
    tools: [],
    maxTokens: 4096,
    networkPolicy: { mode: 'allow-all' },
    ...overrides,
  });

  const createToolDef = (name: string, description: string) => ({
    name,
    description,
    input_schema: { type: 'object' as const, properties: {} },
  });

  const createMockConnection = (overrides: Partial<HubConnection> = {}): HubConnection => ({
    id: 'conn-123',
    name: 'Local Hub',
    url: 'ws://localhost:8080',
    connected: true,
    tools: [
      createToolDef('bash', 'Execute bash commands'),
      createToolDef('read_file', 'Read a file from the filesystem'),
      createToolDef('write_file', 'Write content to a file'),
    ],
    ...overrides,
  });

  const createMockHubClient = (
    connections: HubConnection[] = [],
    connectionMap?: Map<string, HubConnection>
  ): HubClient => {
    const map = connectionMap || new Map(connections.map(c => [c.id, c]));
    return {
      getConnections: vi.fn().mockReturnValue(connections),
      getConnection: vi.fn((id: string) => map.get(id)),
    } as unknown as HubClient;
  };

  describe('generateHubContext', () => {
    it('should return empty string when hubClient is null', () => {
      const config = createMockConfig();
      const result = generateHubContext(config, null);
      expect(result).toBe('');
    });

    it('should return empty string when no connections exist', () => {
      const config = createMockConfig();
      const client = createMockHubClient([]);

      const result = generateHubContext(config, client);
      expect(result).toBe('');
    });

    it('should return empty string when connection is not connected', () => {
      const config = createMockConfig();
      const connection = createMockConnection({ connected: false });
      const client = createMockHubClient([connection]);

      const result = generateHubContext(config, client);
      expect(result).toBe('');
    });

    it('should return empty string when connection has no tools', () => {
      const config = createMockConfig();
      const connection = createMockConnection({ tools: [] });
      const client = createMockHubClient([connection]);

      const result = generateHubContext(config, client);
      expect(result).toBe('');
    });

    it('should generate context for connected hub with tools', () => {
      const config = createMockConfig();
      const connection = createMockConnection();
      const client = createMockHubClient([connection]);

      const result = generateHubContext(config, client);

      expect(result).toContain('## Hub Environment');
      expect(result).toContain('### Available Hub Tools');
      expect(result).toContain('- bash: Execute bash commands');
      expect(result).toContain('- read_file: Read a file from the filesystem');
      expect(result).toContain('- write_file: Write content to a file');
    });

    it('should include working directory section', () => {
      const config = createMockConfig();
      const connection = createMockConnection();
      const client = createMockHubClient([connection]);

      const result = generateHubContext(config, client);

      expect(result).toContain('### Working Directory');
      expect(result).toContain('~/.flo-monster/sandbox');
    });

    it('should use agent-specific sandbox path when provided', () => {
      const config = createMockConfig({
        hubSandboxPath: '/home/user/projects',
      });
      const connection = createMockConnection();
      const client = createMockHubClient([connection]);

      const result = generateHubContext(config, client);

      expect(result).toContain('Your working directory is: /home/user/projects');
    });

    it('should use specific hub connection when hubConnectionId is set', () => {
      const config = createMockConfig({
        hubConnectionId: 'specific-conn',
      });

      const specificConnection = createMockConnection({
        id: 'specific-conn',
        name: 'Specific Hub',
        tools: [createToolDef('custom_tool', 'A custom tool')],
      });

      const otherConnection = createMockConnection({
        id: 'other-conn',
        tools: [createToolDef('bash', 'Execute bash')],
      });

      const connectionMap = new Map([
        ['specific-conn', specificConnection],
        ['other-conn', otherConnection],
      ]);

      const client = createMockHubClient([otherConnection, specificConnection], connectionMap);

      const result = generateHubContext(config, client);

      expect(result).toContain('custom_tool');
      expect(result).not.toContain('bash');
    });

    it('should use first connected hub when no hubConnectionId specified', () => {
      const config = createMockConfig();

      const disconnected = createMockConnection({
        id: 'disconnected-conn',
        connected: false,
        tools: [createToolDef('unavailable_tool', '')],
      });

      const connected = createMockConnection({
        id: 'connected-conn',
        connected: true,
        tools: [createToolDef('available_tool', 'An available tool')],
      });

      const client = createMockHubClient([disconnected, connected]);

      const result = generateHubContext(config, client);

      expect(result).toContain('available_tool');
      expect(result).not.toContain('unavailable_tool');
    });

    it('should handle tools without descriptions', () => {
      const config = createMockConfig();
      const connection = createMockConnection({
        tools: [
          createToolDef('tool_no_desc', ''),
          createToolDef('tool_with_desc', 'Has a description'),
        ],
      });
      const client = createMockHubClient([connection]);

      const result = generateHubContext(config, client);

      expect(result).toContain('- tool_no_desc');
      expect(result).toContain('- tool_with_desc: Has a description');
    });

    it('should return empty when hubConnectionId does not exist', () => {
      const config = createMockConfig({
        hubConnectionId: 'nonexistent',
      });

      const connection = createMockConnection({ id: 'other-conn' });
      const connectionMap = new Map([['other-conn', connection]]);
      const client = createMockHubClient([connection], connectionMap);

      const result = generateHubContext(config, client);
      expect(result).toBe('');
    });

    it('should include all tools from connection', () => {
      const config = createMockConfig();
      const manyTools = [
        createToolDef('bash', 'Execute commands'),
        createToolDef('read_file', 'Read files'),
        createToolDef('write_file', 'Write files'),
        createToolDef('list_dir', 'List directories'),
        createToolDef('fetch', 'HTTP requests'),
      ];
      const connection = createMockConnection({ tools: manyTools });
      const client = createMockHubClient([connection]);

      const result = generateHubContext(config, client);

      for (const tool of manyTools) {
        expect(result).toContain(tool.name);
        expect(result).toContain(tool.description);
      }
    });

    it('should format output as proper markdown', () => {
      const config = createMockConfig();
      const connection = createMockConnection();
      const client = createMockHubClient([connection]);

      const result = generateHubContext(config, client);
      const lines = result.split('\n');

      // Check markdown structure
      expect(lines[0]).toBe('## Hub Environment');
      expect(lines[1]).toBe('');
      expect(lines.some(l => l.startsWith('### '))).toBe(true);
      expect(lines.some(l => l.startsWith('- '))).toBe(true);
    });

    it('should show browser-only message when no hubPersistInfo', () => {
      const config = createMockConfig();
      const connection = createMockConnection();
      const client = createMockHubClient([connection]);

      const result = generateHubContext(config, client);

      expect(result).toContain('browser-only mode');
      expect(result).toContain('persist to the hub to gain autonomous execution');
    });

    it('should show persistence context when hubPersistInfo provided', () => {
      const config = createMockConfig();
      const connection = createMockConnection();
      const client = createMockHubClient([connection]);

      const persistInfo = {
        hubAgentId: 'hub-test-agent-123',
        hubName: 'My Hub',
        hubConnectionId: 'conn-123',
      };

      const result = generateHubContext(config, client, persistInfo);

      expect(result).toContain('persisted to hub "My Hub"');
      expect(result).toContain('hub-test-agent-123');
      expect(result).toContain('run autonomously without a browser');
      expect(result).toContain('flo-hub');
      expect(result).not.toContain('browser-only mode');
    });
  });
});
