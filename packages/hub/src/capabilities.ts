/**
 * Hub-side capabilities response for hub agents.
 * Provides execution context, available tools, and browser status.
 */

import type { AgentConfig } from '@flo-monster/core';
import type { BrowserToolRouter } from './browser-tool-router.js';

/** Browser-only tools that can be routed to a connected browser */
const BROWSER_ROUTED_TOOLS = [
  'dom', 'runjs', 'storage', 'files', 'view_state', 'state', 'audit_log',
];

/** Hub-native tools */
const HUB_NATIVE_TOOLS = [
  'bash', 'filesystem', 'list_skills', 'load_skill', 'context_search',
];

export interface HubCapabilitiesResult {
  runtime: 'hub';
  executionMode: 'browser-only' | 'browser-with-hub' | 'hub-with-browser' | 'hub-only';
  browserConnected: boolean;
  provider: string;
  model: string;
  tools: {
    hub: string[];
    browserRouted: string[];
    hubState?: boolean;  // true when hub-side state store is available
    hubFiles?: boolean;  // true when hub-side files root is available
    hubDom?: string[];   // structural actions available when hub-side DOM container exists
  };
  agent: {
    id: string;
    name: string;
  };
  skills: string[];
  limits: {
    maxSubagentDepth: number;
    subagentTimeout: number;
    tokenBudget: number | null;
    costBudget: number | null;
  };
}

export function getHubCapabilities(
  config: AgentConfig,
  hubAgentId: string,
  browserToolRouter?: BrowserToolRouter,
  options?: { hasStateStore?: boolean; hasFilesRoot?: boolean; hasDomContainer?: boolean; hasScheduler?: boolean },
): HubCapabilitiesResult {
  const browserConnected = browserToolRouter?.isAvailable(hubAgentId) ?? false;
  const browserRouted = browserConnected
    ? BROWSER_ROUTED_TOOLS.filter(t =>
        !(t === 'state' && options?.hasStateStore) &&
        !(t === 'files' && options?.hasFilesRoot) &&
        !(t === 'dom' && options?.hasDomContainer)
      )
    : [];

  return {
    runtime: 'hub',
    executionMode: browserConnected ? 'hub-with-browser' : 'hub-only',
    browserConnected,
    provider: config.provider || 'anthropic',
    model: config.model,
    tools: {
      hub: options?.hasScheduler ? [...HUB_NATIVE_TOOLS, 'schedule'] : HUB_NATIVE_TOOLS,
      browserRouted,
      ...(options?.hasStateStore ? { hubState: true } : {}),
      ...(options?.hasFilesRoot ? { hubFiles: true } : {}),
      ...(options?.hasDomContainer ? { hubDom: ['create', 'modify', 'query', 'remove'] } : {}),
    },
    agent: {
      id: config.id || hubAgentId,
      name: config.name,
    },
    skills: [],
    limits: {
      maxSubagentDepth: 3,
      subagentTimeout: 300000,
      tokenBudget: config.tokenBudget || null,
      costBudget: config.costBudgetUsd || null,
    },
  };
}
