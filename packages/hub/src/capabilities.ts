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
  timezone: string;  // Hub server timezone (IANA format, e.g. "Australia/Sydney")
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
  options?: { hasStateStore?: boolean; hasFilesRoot?: boolean; hasDomContainer?: boolean; hasScheduler?: boolean; hasBrowse?: boolean },
): HubCapabilitiesResult {
  const browserConnected = browserToolRouter?.isAvailable(hubAgentId) ?? false;
  const browserRouted = browserConnected
    ? BROWSER_ROUTED_TOOLS.filter(t =>
        !(t === 'state' && options?.hasStateStore) &&
        !(t === 'files' && options?.hasFilesRoot) &&
        !(t === 'dom' && options?.hasDomContainer) &&
        !(t === 'runjs' && options?.hasStateStore)
      )
    : [];

  // Build hub tools list — add runjs when hub can execute it natively
  const hubTools = [...HUB_NATIVE_TOOLS];
  if (options?.hasScheduler) hubTools.push('schedule');
  if (options?.hasStateStore) hubTools.push('runjs');
  if (options?.hasBrowse) hubTools.push('browse');

  return {
    runtime: 'hub',
    executionMode: browserConnected ? 'hub-with-browser' : 'hub-only',
    browserConnected,
    provider: config.provider || 'anthropic',
    model: config.model,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    tools: {
      hub: hubTools,
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
