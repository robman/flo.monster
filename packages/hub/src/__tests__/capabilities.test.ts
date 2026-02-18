/**
 * Tests for hub-side capabilities handler.
 */

import { describe, it, expect, vi } from 'vitest';
import { getHubCapabilities, type HubCapabilitiesResult } from '../capabilities.js';
import type { AgentConfig } from '@flo-monster/core';

function createMockConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    model: 'claude-sonnet-4-20250514',
    tools: [],
    maxTokens: 4096,
    ...overrides,
  };
}

function createMockRouter(isAvailable: boolean) {
  return {
    isAvailable: vi.fn().mockReturnValue(isAvailable),
    routeToBrowser: vi.fn(),
    handleResult: vi.fn(),
    pendingCount: 0,
  };
}

describe('getHubCapabilities', () => {
  it('returns hub runtime', () => {
    const config = createMockConfig();
    const result = getHubCapabilities(config, 'hub-agent-1');
    expect(result.runtime).toBe('hub');
  });

  it('returns hub-only when no browser connected', () => {
    const config = createMockConfig();
    const result = getHubCapabilities(config, 'hub-agent-1');
    expect(result.executionMode).toBe('hub-only');
    expect(result.browserConnected).toBe(false);
  });

  it('returns hub-only when router says not available', () => {
    const config = createMockConfig();
    const router = createMockRouter(false);
    const result = getHubCapabilities(config, 'hub-agent-1', router as any);
    expect(result.executionMode).toBe('hub-only');
    expect(result.browserConnected).toBe(false);
    expect(router.isAvailable).toHaveBeenCalledWith('hub-agent-1');
  });

  it('returns hub-with-browser when browser is connected', () => {
    const config = createMockConfig();
    const router = createMockRouter(true);
    const result = getHubCapabilities(config, 'hub-agent-1', router as any);
    expect(result.executionMode).toBe('hub-with-browser');
    expect(result.browserConnected).toBe(true);
    expect(router.isAvailable).toHaveBeenCalledWith('hub-agent-1');
  });

  it('includes agent config info (name, model, provider)', () => {
    const config = createMockConfig({ name: 'My Agent', model: 'gpt-4', provider: 'openai' });
    const result = getHubCapabilities(config, 'hub-agent-1');
    expect(result.agent.name).toBe('My Agent');
    expect(result.model).toBe('gpt-4');
    expect(result.provider).toBe('openai');
  });

  it('returns empty browserRouted when no browser', () => {
    const config = createMockConfig();
    const result = getHubCapabilities(config, 'hub-agent-1');
    expect(result.tools.browserRouted).toEqual([]);
    expect(result.tools.hub).toContain('bash');
    expect(result.tools.hub).toContain('filesystem');
  });

  it('returns browser tools when browser connected', () => {
    const config = createMockConfig();
    const router = createMockRouter(true);
    const result = getHubCapabilities(config, 'hub-agent-1', router as any);
    expect(result.tools.browserRouted).toContain('dom');
    expect(result.tools.browserRouted).toContain('runjs');
    expect(result.tools.browserRouted).toContain('storage');
    expect(result.tools.hub).toContain('bash');
  });

  it('uses default provider when none specified', () => {
    const config = createMockConfig({ provider: undefined });
    const result = getHubCapabilities(config, 'hub-agent-1');
    expect(result.provider).toBe('anthropic');
  });

  it('includes limits from config', () => {
    const config = createMockConfig({ tokenBudget: 50000, costBudgetUsd: 1.5 });
    const result = getHubCapabilities(config, 'hub-agent-1');
    expect(result.limits.tokenBudget).toBe(50000);
    expect(result.limits.costBudget).toBe(1.5);
    expect(result.limits.maxSubagentDepth).toBe(3);
    expect(result.limits.subagentTimeout).toBe(300000);
  });

  it('returns null limits when config has no budget', () => {
    const config = createMockConfig();
    const result = getHubCapabilities(config, 'hub-agent-1');
    expect(result.limits.tokenBudget).toBeNull();
    expect(result.limits.costBudget).toBeNull();
  });

  it('uses config.id for agent.id when available', () => {
    const config = createMockConfig({ id: 'custom-id' });
    const result = getHubCapabilities(config, 'hub-agent-1');
    expect(result.agent.id).toBe('custom-id');
  });

  it('falls back to hubAgentId when config.id is empty', () => {
    const config = createMockConfig({ id: '' });
    const result = getHubCapabilities(config, 'hub-agent-1');
    expect(result.agent.id).toBe('hub-agent-1');
  });

  it('returns empty skills array', () => {
    const config = createMockConfig();
    const result = getHubCapabilities(config, 'hub-agent-1');
    expect(result.skills).toEqual([]);
  });

  it('includes hub timezone in IANA format', () => {
    const config = createMockConfig();
    const result = getHubCapabilities(config, 'hub-agent-1');
    expect(result.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(typeof result.timezone).toBe('string');
    expect(result.timezone.length).toBeGreaterThan(0);
  });

  it('moves runjs from browserRouted to hub tools when hasStateStore', () => {
    const config = createMockConfig();
    const router = createMockRouter(true);
    const result = getHubCapabilities(config, 'hub-agent-1', router as any, { hasStateStore: true });
    expect(result.tools.browserRouted).not.toContain('runjs');
    expect(result.tools.hub).toContain('runjs');
  });

  it('includes runjs in hub tools without browser when hasStateStore', () => {
    const config = createMockConfig();
    const result = getHubCapabilities(config, 'hub-agent-1', undefined, { hasStateStore: true });
    expect(result.tools.hub).toContain('runjs');
    expect(result.tools.browserRouted).toEqual([]);
  });

  it('keeps runjs in browserRouted when no hasStateStore', () => {
    const config = createMockConfig();
    const router = createMockRouter(true);
    const result = getHubCapabilities(config, 'hub-agent-1', router as any);
    expect(result.tools.browserRouted).toContain('runjs');
    expect(result.tools.hub).not.toContain('runjs');
  });

  it('includes schedule in hub tools when hasScheduler', () => {
    const config = createMockConfig();
    const result = getHubCapabilities(config, 'hub-agent-1', undefined, { hasScheduler: true });
    expect(result.tools.hub).toContain('schedule');
  });

  it('does not include schedule in hub tools without hasScheduler', () => {
    const config = createMockConfig();
    const result = getHubCapabilities(config, 'hub-agent-1');
    expect(result.tools.hub).not.toContain('schedule');
  });
});
