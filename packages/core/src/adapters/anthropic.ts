import type {
  Message, ApiToolDef, TokenUsage, ContentBlock,
  ToolUseContent,
} from '../types/messages.js';
import type { AgentConfig } from '../types/agent.js';
import type { AgentEvent } from '../types/events.js';
import type { ProviderAdapter, CostEstimate, SSEEvent, ModelInfo } from '../types/provider.js';
import { estimateCostForModel } from './cost-utils.js';
import { MODEL_PRICING } from '../data/model-pricing.js';

// Backward-compatible export — derived from centralized model-pricing
const MODEL_INFO: Record<string, ModelInfo> = Object.fromEntries(
  Object.entries(MODEL_PRICING).filter(([, m]) => m.provider === 'anthropic')
);

// State for accumulating streamed content
interface StreamState {
  currentToolId: string | null;
  currentToolName: string | null;
  toolInputAccumulator: string;
  currentTextAccumulator: string;
  // Per-API-call usage (merged across message_start and message_delta)
  callUsage: TokenUsage;
}

function createStreamState(): StreamState {
  return {
    currentToolId: null,
    currentToolName: null,
    toolInputAccumulator: '',
    currentTextAccumulator: '',
    callUsage: { input_tokens: 0, output_tokens: 0 },
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
          // Save per-call usage — will be emitted at message_delta
          const msgUsage = message?.usage as Record<string, unknown> | undefined;
          if (msgUsage) {
            streamState.callUsage.input_tokens = Math.max(streamState.callUsage.input_tokens, (msgUsage.input_tokens as number) || 0);
            streamState.callUsage.output_tokens = Math.max(streamState.callUsage.output_tokens, (msgUsage.output_tokens as number) || 0);
            if (msgUsage.cache_creation_input_tokens) {
              streamState.callUsage.cache_creation_input_tokens = Math.max(
                streamState.callUsage.cache_creation_input_tokens ?? 0,
                msgUsage.cache_creation_input_tokens as number
              );
            }
            if (msgUsage.cache_read_input_tokens) {
              streamState.callUsage.cache_read_input_tokens = Math.max(
                streamState.callUsage.cache_read_input_tokens ?? 0,
                msgUsage.cache_read_input_tokens as number
              );
            }
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
            streamState.callUsage.input_tokens = Math.max(streamState.callUsage.input_tokens, (usage.input_tokens as number) || 0);
            streamState.callUsage.output_tokens = Math.max(streamState.callUsage.output_tokens, (usage.output_tokens as number) || 0);
            if (usage.cache_creation_input_tokens) {
              streamState.callUsage.cache_creation_input_tokens = Math.max(
                streamState.callUsage.cache_creation_input_tokens ?? 0,
                usage.cache_creation_input_tokens as number
              );
            }
            if (usage.cache_read_input_tokens) {
              streamState.callUsage.cache_read_input_tokens = Math.max(
                streamState.callUsage.cache_read_input_tokens ?? 0,
                usage.cache_read_input_tokens as number
              );
            }
          }
          // Always emit merged per-call usage at message_delta (end of stream)
          events.push({
            type: 'usage',
            usage: { ...streamState.callUsage },
            cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: 'USD' },
          });
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
      return estimateCostForModel(model, usage);
    },

    resetState(): void {
      streamState = createStreamState();
    },
  };
}

export { MODEL_INFO };
