import type {
  Message, ApiToolDef, TokenUsage, ContentBlock,
  ToolUseContent,
} from '../types/messages.js';
import type { AgentConfig } from '../types/agent.js';
import type { AgentEvent } from '../types/events.js';
import type { ProviderAdapter, CostEstimate, SSEEvent, ModelInfo } from '../types/provider.js';
import { calculateCost } from './cost-utils.js';
import { resolveModelId } from './model-aliases.js';

// Model pricing (per million tokens)
// Order matters — UI model selectors display models in insertion order.
// Sonnet is the recommended default, so it goes first.
const MODEL_INFO: Record<string, ModelInfo> = {
  // Claude 4.6 series (current generation)
  'claude-sonnet-4-6': {
    id: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    contextWindow: 200000,
    maxOutputTokens: 65536,
    pricing: { inputPerMillion: 3.0, outputPerMillion: 15.0, cacheCreationPerMillion: 3.75, cacheReadPerMillion: 0.3 },
  },
  'claude-opus-4-6': {
    id: 'claude-opus-4-6',
    displayName: 'Claude Opus 4.6',
    provider: 'anthropic',
    contextWindow: 200000,
    maxOutputTokens: 131072,
    pricing: { inputPerMillion: 5.0, outputPerMillion: 25.0, cacheCreationPerMillion: 6.25, cacheReadPerMillion: 0.5 },
  },
  // Claude 4.5 series
  'claude-opus-4-5-20251101': {
    id: 'claude-opus-4-5-20251101',
    displayName: 'Claude Opus 4.5',
    provider: 'anthropic',
    contextWindow: 200000,
    maxOutputTokens: 65536,
    pricing: { inputPerMillion: 5.0, outputPerMillion: 25.0, cacheCreationPerMillion: 6.25, cacheReadPerMillion: 0.5 },
  },
  'claude-sonnet-4-5-20250929': {
    id: 'claude-sonnet-4-5-20250929',
    displayName: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    contextWindow: 200000,
    maxOutputTokens: 65536,
    pricing: { inputPerMillion: 3.0, outputPerMillion: 15.0, cacheCreationPerMillion: 3.75, cacheReadPerMillion: 0.3 },
  },
  'claude-haiku-4-5-20251001': {
    id: 'claude-haiku-4-5-20251001',
    displayName: 'Claude Haiku 4.5',
    provider: 'anthropic',
    contextWindow: 200000,
    maxOutputTokens: 65536,
    pricing: { inputPerMillion: 1.0, outputPerMillion: 5.0, cacheCreationPerMillion: 1.25, cacheReadPerMillion: 0.1 },
  },
  // Claude 4 series
  'claude-sonnet-4-20250514': {
    id: 'claude-sonnet-4-20250514',
    displayName: 'Claude Sonnet 4',
    provider: 'anthropic',
    contextWindow: 200000,
    maxOutputTokens: 65536,
    pricing: { inputPerMillion: 3.0, outputPerMillion: 15.0, cacheCreationPerMillion: 3.75, cacheReadPerMillion: 0.3 },
  },
  'claude-opus-4-20250514': {
    id: 'claude-opus-4-20250514',
    displayName: 'Claude Opus 4',
    provider: 'anthropic',
    contextWindow: 200000,
    maxOutputTokens: 32768,
    pricing: { inputPerMillion: 15.0, outputPerMillion: 75.0, cacheCreationPerMillion: 18.75, cacheReadPerMillion: 1.5 },
  },
  // Claude 3.5 series (legacy)
  'claude-haiku-3-5-20241022': {
    id: 'claude-haiku-3-5-20241022',
    displayName: 'Claude 3.5 Haiku',
    provider: 'anthropic',
    contextWindow: 200000,
    maxOutputTokens: 8192,
    pricing: { inputPerMillion: 0.80, outputPerMillion: 4.0, cacheCreationPerMillion: 1.0, cacheReadPerMillion: 0.08 },
  },
};

// State for accumulating streamed content
interface StreamState {
  currentToolId: string | null;
  currentToolName: string | null;
  toolInputAccumulator: string;
  currentTextAccumulator: string;
}

function createStreamState(): StreamState {
  return {
    currentToolId: null,
    currentToolName: null,
    toolInputAccumulator: '',
    currentTextAccumulator: '',
  };
}

export function createAnthropicAdapter(): ProviderAdapter {
  let streamState = createStreamState();

  return {
    id: 'anthropic',

    buildRequest(
      messages: Message[],
      tools: ApiToolDef[],
      config: AgentConfig,
    ): { url: string; headers: Record<string, string>; body: string } {
      const body: Record<string, unknown> = {
        model: config.model,
        max_tokens: config.maxTokens,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content.map((c) => {
            if (c.type === 'text') return { type: 'text', text: c.text };
            if (c.type === 'tool_use') return { type: 'tool_use', id: c.id, name: c.name, input: c.input };
            if (c.type === 'tool_result') return {
              type: 'tool_result',
              tool_use_id: c.tool_use_id,
              content: typeof c.content === 'string' ? c.content : JSON.stringify(c.content),
              ...(c.is_error ? { is_error: true } : {}),
            };
            return c;
          }),
        })),
        stream: true,
      };

      if (config.systemPrompt) {
        body.system = config.systemPrompt;
      }

      if (tools.length > 0) {
        body.tools = tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema,
        }));
      }

      return {
        url: '/api/anthropic/v1/messages',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      };
    },

    parseSSEEvent(event: SSEEvent): AgentEvent[] {
      if (!event.data || event.data === '[DONE]') return [];

      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return [];
      }

      if (typeof parsed !== 'object' || parsed === null) return [];
      const p = parsed as Record<string, unknown>;

      const events: AgentEvent[] = [];

      switch (p.type) {
        case 'message_start': {
          const message = p.message as Record<string, unknown> | undefined;
          events.push({ type: 'message_start', messageId: (message?.id as string) || '' });
          // Capture input token usage from message_start
          const msgUsage = message?.usage as Record<string, unknown> | undefined;
          if (msgUsage) {
            events.push({
              type: 'usage',
              usage: {
                input_tokens: (msgUsage.input_tokens as number) || 0,
                output_tokens: (msgUsage.output_tokens as number) || 0,
              },
              cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: 'USD' },
            });
          }
          break;
        }

        case 'content_block_start': {
          const block = p.content_block as Record<string, unknown> | undefined;
          if (block?.type === 'text') {
            streamState.currentTextAccumulator = '';
          } else if (block?.type === 'tool_use') {
            streamState.currentToolId = block.id as string;
            streamState.currentToolName = block.name as string;
            streamState.toolInputAccumulator = '';
            events.push({
              type: 'tool_use_start',
              toolUseId: block.id as string,
              toolName: block.name as string,
            });
          }
          break;
        }

        case 'content_block_delta': {
          const delta = p.delta as Record<string, unknown> | undefined;
          if (delta?.type === 'text_delta') {
            streamState.currentTextAccumulator += delta.text as string;
            events.push({ type: 'text_delta', text: delta.text as string });
          } else if (delta?.type === 'input_json_delta') {
            streamState.toolInputAccumulator += delta.partial_json as string;
            events.push({
              type: 'tool_use_input_delta',
              toolUseId: streamState.currentToolId || '',
              partialJson: delta.partial_json as string,
            });
          }
          break;
        }

        case 'content_block_stop': {
          if (streamState.currentToolId) {
            let input: Record<string, unknown> = {};
            try {
              input = JSON.parse(streamState.toolInputAccumulator);
            } catch {
              // Invalid JSON, use empty
            }
            events.push({
              type: 'tool_use_done',
              toolUseId: streamState.currentToolId,
              toolName: streamState.currentToolName || '',
              input,
            });
            streamState.currentToolId = null;
            streamState.currentToolName = null;
            streamState.toolInputAccumulator = '';
          } else if (streamState.currentTextAccumulator) {
            events.push({
              type: 'text_done',
              text: streamState.currentTextAccumulator,
            });
            streamState.currentTextAccumulator = '';
          }
          break;
        }

        case 'message_delta': {
          const usage = p.usage as Record<string, unknown> | undefined;
          if (usage) {
            events.push({
              type: 'usage',
              usage: {
                input_tokens: (usage.input_tokens as number) || 0,
                output_tokens: (usage.output_tokens as number) || 0,
              },
              cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: 'USD' },
            });
          }
          const delta = p.delta as Record<string, unknown> | undefined;
          if (delta?.stop_reason) {
            events.push({
              type: 'turn_end',
              stopReason: delta.stop_reason as 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence',
            });
          }
          break;
        }

        case 'message_stop':
          // Redundant with message_delta, ignore
          break;
      }

      return events;
    },

    extractUsage(data: unknown): TokenUsage {
      const d = data as Record<string, unknown> | null | undefined;
      const usage = d?.usage as Record<string, unknown> | undefined;
      return {
        input_tokens: (usage?.input_tokens as number) || (d?.input_tokens as number) || 0,
        output_tokens: (usage?.output_tokens as number) || (d?.output_tokens as number) || 0,
        cache_creation_input_tokens: usage?.cache_creation_input_tokens as number | undefined,
        cache_read_input_tokens: usage?.cache_read_input_tokens as number | undefined,
      };
    },

    estimateCost(model: string, usage: TokenUsage): CostEstimate {
      const info = MODEL_INFO[resolveModelId(model)];
      if (!info) {
        return { inputCost: 0, outputCost: 0, totalCost: 0, currency: 'USD' };
      }

      return calculateCost(usage, info.pricing);
    },

    resetState(): void {
      streamState = createStreamState();
    },
  };
}

export { MODEL_INFO };
