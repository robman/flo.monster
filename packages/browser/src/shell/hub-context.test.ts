import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateHubContext } from './hub-context.js';
import type { HubClient, HubConnection } from './hub-client.js';
import type { AgentConfig, ToolDef } from '@flo-monster/core';

// Helper to create a minimal agent config
function createAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    model: 'claude-sonnet-4-20250514',
    systemPrompt: 'Test prompt',
    tools: [],
    maxTokens: 4096,
    networkPolicy: { mode: 'allow-all' },
    ...overrides,
  };
}

// Helper to create a mock hub client
function createMockHubClient(connections: HubConnection[] = []): HubClient {
  return {
    getConnections: vi.fn(() => connections),
    getConnection: vi.fn((id: string) => connections.find(c => c.id === id)),
  } as unknown as HubClient;
}

// Helper to create a hub connection
function createConnection(
  overrides: Partial<HubConnection> = {}
): HubConnection {
  return {
    id: 'conn-1',
    name: 'Test Hub',
    url: 'ws://localhost:3002',
    connected: true,
    tools: [],
    ...overrides,
  };
}

describe('generateHubContext', () => {
  describe('returns empty string when no hub', () => {
    it('returns empty string when hubClient is null', () => {
      const config = createAgentConfig();
      const result = generateHubContext(config, null);
      expect(result).toBe('');
    });

    it('returns empty string when no connections', () => {
      const config = createAgentConfig();
      const client = createMockHubClient([]);
      const result = generateHubContext(config, client);
      expect(result).toBe('');
    });

    it('returns empty string when connection is not connected', () => {
      const config = createAgentConfig();
      const client = createMockHubClient([
        createConnection({ connected: false, tools: [{ name: 'bash', description: 'Run commands', input_schema: { type: 'object' } }] }),
      ]);
      const result = generateHubContext(config, client);
      expect(result).toBe('');
    });

    it('returns empty string when connection has no tools', () => {
      const config = createAgentConfig();
      const client = createMockHubClient([
        createConnection({ tools: [] }),
      ]);
      const result = generateHubContext(config, client);
      expect(result).toBe('');
    });
  });

  describe('includes available tools', () => {
    it('lists all available tools with descriptions', () => {
      const tools: ToolDef[] = [
        { name: 'bash', description: 'Execute shell commands', input_schema: { type: 'object' } },
        { name: 'read_file', description: 'Read file contents', input_schema: { type: 'object' } },
        { name: 'write_file', description: 'Write file contents', input_schema: { type: 'object' } },
      ];
      const config = createAgentConfig();
      const client = createMockHubClient([createConnection({ tools })]);

      const result = generateHubContext(config, client);

      expect(result).toContain('## Hub Environment');
      expect(result).toContain('### Available Hub Tools');
      expect(result).toContain('- bash: Execute shell commands');
      expect(result).toContain('- read_file: Read file contents');
      expect(result).toContain('- write_file: Write file contents');
    });

    it('lists tools without descriptions correctly', () => {
      const tools: ToolDef[] = [
        { name: 'my_tool', description: '', input_schema: { type: 'object' } },
      ];
      const config = createAgentConfig();
      const client = createMockHubClient([createConnection({ tools })]);

      const result = generateHubContext(config, client);

      // Should just show the name without trailing colon
      expect(result).toContain('- my_tool');
      expect(result).not.toContain('- my_tool:');
    });

    it('uses specific hub connection when hubConnectionId is set', () => {
      const tools1: ToolDef[] = [
        { name: 'tool_a', description: 'Tool A', input_schema: { type: 'object' } },
      ];
      const tools2: ToolDef[] = [
        { name: 'tool_b', description: 'Tool B', input_schema: { type: 'object' } },
      ];
      const conn1 = createConnection({ id: 'conn-1', tools: tools1 });
      const conn2 = createConnection({ id: 'conn-2', tools: tools2 });

      const config = createAgentConfig({ hubConnectionId: 'conn-2' });
      const client = createMockHubClient([conn1, conn2]);

      const result = generateHubContext(config, client);

      expect(result).toContain('- tool_b: Tool B');
      expect(result).not.toContain('tool_a');
    });
  });

  describe('includes sandbox path', () => {
    it('shows default sandbox path', () => {
      const tools: ToolDef[] = [
        { name: 'bash', description: 'Run commands', input_schema: { type: 'object' } },
      ];
      const config = createAgentConfig();
      const client = createMockHubClient([createConnection({ tools })]);

      const result = generateHubContext(config, client);

      expect(result).toContain('### Working Directory');
      expect(result).toContain('Your working directory is: ~/.flo-monster/sandbox');
    });

    it('shows agent-specific sandbox path when configured', () => {
      const tools: ToolDef[] = [
        { name: 'bash', description: 'Run commands', input_schema: { type: 'object' } },
      ];
      const config = createAgentConfig({
        hubSandboxPath: '/home/user/my-project',
      });
      const client = createMockHubClient([createConnection({ tools })]);

      const result = generateHubContext(config, client);

      expect(result).toContain('### Working Directory');
      expect(result).toContain('Your working directory is: /home/user/my-project');
      expect(result).not.toContain('~/.flo-monster/sandbox');
    });
  });

  describe('output format', () => {
    it('generates clean markdown format', () => {
      const tools: ToolDef[] = [
        { name: 'bash', description: 'Execute shell commands', input_schema: { type: 'object' } },
      ];
      const config = createAgentConfig();
      const client = createMockHubClient([createConnection({ tools })]);

      const result = generateHubContext(config, client);

      // Check overall structure
      expect(result).toMatch(/^## Hub Environment\n\n/);
      expect(result).toContain('You have access to a local hub server');
      expect(result).toContain('\n\n### Available Hub Tools\n');
      expect(result).toContain('\n\n### Working Directory\n');
    });
  });
});
