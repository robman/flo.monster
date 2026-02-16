import type { ToolDef } from './tools.js';

export type AgentState = 'pending' | 'running' | 'paused' | 'stopped' | 'error' | 'killed';

/**
 * Agent view states control how the agent UI is displayed:
 * - min: Dashboard card (agent minimized)
 * - max: Full view with both iframe and chat panes (default)
 * - ui-only: Only the iframe viewport visible (apps, games, immersive UIs)
 * - chat-only: Only the chat/conversation pane visible (text-focused, mobile)
 */
export type AgentViewState = 'min' | 'max' | 'ui-only' | 'chat-only';

export interface AgentConfig {
  id: string;
  name: string;
  model: string;
  provider?: string;
  systemPrompt?: string;
  tools: ToolDef[];
  maxTokens: number;
  tokenBudget?: number;
  costBudgetUsd?: number;
  networkPolicy?: NetworkPolicy;
  hubConnectionId?: string;   // Which hub to use (null = first available)
  hubSandboxPath?: string;    // Override sandbox path for this agent
  sandboxPermissions?: SandboxPermissions;
  contextMode?: 'slim' | 'full';      // default 'slim'
  fullContextTurns?: number;           // default 3
}

export interface NetworkPolicy {
  mode: 'allow-all' | 'allowlist' | 'blocklist';
  allowedDomains?: string[];
  blockedDomains?: string[];
  useHubProxy?: boolean;  // Route through hub (Phase 6)
  hubProxyPatterns?: string[];  // Which URLs go through hub
}

export interface NetworkApproval {
  origin: string;
  approved: boolean;
  approvedAt: number;
  persistent: boolean;  // "Allow Always" vs "Allow Once"
}

export interface SandboxPermissions {
  camera?: boolean;
  microphone?: boolean;
  geolocation?: boolean;
}

export interface SubworkerInfo {
  id: string;
  config: AgentConfig;
  createdAt: number;
  state: AgentState;
}
