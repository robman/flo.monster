import type { Message, TokenUsage, ApiToolDef } from './messages.js';
import type { AgentConfig } from './agent.js';
import type { AgentEvent } from './events.js';

export interface SSEEvent {
  event?: string;
  data: string;
}

export interface ProviderAdapter {
  id: string;
  buildRequest(
    messages: Message[],
    tools: ApiToolDef[],
    config: AgentConfig,
  ): { url: string; headers: Record<string, string>; body: string };
  parseSSEEvent(event: SSEEvent): AgentEvent[];
  extractUsage(data: unknown): TokenUsage;
  estimateCost(model: string, usage: TokenUsage): CostEstimate;
  resetState(): void;
}

export interface CostEstimate {
  inputCost: number;
  outputCost: number;
  totalCost: number;
  currency: 'USD';
}

export interface ModelInfo {
  id: string;
  displayName: string;
  provider: string;
  contextWindow: number;
  maxOutputTokens: number;
  pricing: {
    inputPerMillion: number;
    outputPerMillion: number;
    cacheCreationPerMillion?: number;
    cacheReadPerMillion?: number;
  };
}
