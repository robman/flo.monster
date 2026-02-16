/**
 * Tests for PersistHandler
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { PersistHandler } from './persist-handler.js';
import type { HubClient, HubConnection } from './hub-client.js';
import type { MessageRelay } from './message-relay.js';
import type { AgentContainer } from '../agent/agent-container.js';
import type { AgentConfig } from '@flo-monster/core';

describe('PersistHandler', () => {
  let handler: PersistHandler;
  let mockHubClient: Partial<HubClient>;
  let mockMessageRelay: Partial<MessageRelay>;
  let mockAgent: Partial<AgentContainer>;

  const mockConfig: AgentConfig = {
    id: 'agent-1',
    name: 'Test Agent',
    model: 'claude-sonnet-4-20250514',
    tools: [],
    maxTokens: 4096,
  };

  beforeEach(() => {
    mockHubClient = {
      getConnection: vi.fn(),
      getConnections: vi.fn(() => []),
      persistAgent: vi.fn(),
      restoreAgent: vi.fn(),
    };

    mockMessageRelay = {
      loadConversationContext: vi.fn().mockResolvedValue([]),
    };

    mockAgent = {
      id: 'agent-1',
      config: mockConfig,
    };

    handler = new PersistHandler(
      mockHubClient as HubClient,
      mockMessageRelay as MessageRelay,
    );
  });

  describe('persistAgent', () => {
    it('should return error when hub is not connected', async () => {
      (mockHubClient.getConnection as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      const result = await handler.persistAgent(
        mockAgent as AgentContainer,
        { hubConnectionId: 'hub-1' },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Hub not connected');
    });

    it('should load conversation context from message relay', async () => {
      const mockConversation = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ];
      (mockMessageRelay.loadConversationContext as ReturnType<typeof vi.fn>).mockResolvedValue(mockConversation);
      (mockHubClient.getConnection as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 'hub-1',
        connected: true,
      } as HubConnection);
      (mockHubClient.persistAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
        hubAgentId: 'hub-agent-1',
        success: true,
      });

      const result = await handler.persistAgent(
        mockAgent as AgentContainer,
        { hubConnectionId: 'hub-1' },
      );

      expect(mockMessageRelay.loadConversationContext).toHaveBeenCalledWith('agent-1');
      expect(result.success).toBe(true);
    });

    it('should return success with hub agent ID when connected', async () => {
      (mockHubClient.getConnection as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 'hub-1',
        connected: true,
      } as HubConnection);
      (mockHubClient.persistAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
        hubAgentId: 'hub-agent-1',
        success: true,
      });

      const result = await handler.persistAgent(
        mockAgent as AgentContainer,
        { hubConnectionId: 'hub-1' },
      );

      expect(result.success).toBe(true);
      expect(result.hubAgentId).toBeDefined();
      expect(result.hubAgentId).toContain('hub-');
    });

    it('should handle errors gracefully', async () => {
      (mockHubClient.getConnection as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('Connection error');
      });

      const result = await handler.persistAgent(
        mockAgent as AgentContainer,
        { hubConnectionId: 'hub-1' },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection error');
    });
  });

  describe('restoreAgent', () => {
    it('should return null when hub is not connected', async () => {
      (mockHubClient.getConnection as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      const result = await handler.restoreAgent('hub-1', 'agent-123');

      expect(result).toBeNull();
    });

    it('should return null for disconnected hub', async () => {
      (mockHubClient.getConnection as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 'hub-1',
        connected: false,
      } as HubConnection);

      const result = await handler.restoreAgent('hub-1', 'agent-123');

      expect(result).toBeNull();
    });
  });
});
