import type {
  Message, ApiToolDef, TokenUsage,
} from '../types/messages.js';
import type { AgentConfig } from '../types/agent.js';
import type { AgentEvent } from '../types/events.js';
import type { ProviderAdapter, CostEstimate, SSEEvent, ModelInfo } from '../types/provider.js';
import { estimateCostForModel } from './cost-utils.js';
import { MODEL_PRICING } from '../data/model-pricing.js';

// Backward-compatible export — derived from centralized model-pricing
export const OPENAI_MODELS: Record<string, ModelInfo> = Object.fromEntries(
  Object.entries(MODEL_PRICING).filter(([, m]) => m.provider === 'openai')
);

// State for accumulating streamed OpenAI content
interface OpenAIStreamState {
  activeToolCalls: Map<number, { id: string; name: string; argsAccum: string }>;
  textAccum: string;
  hasText: boolean;
}

function createOpenAIStreamState(): OpenAIStreamState {
  return {
    activeToolCalls: new Map(),
    textAccum: '',
    hasText: false,
  };
}

/**
 * Get the API endpoint path for a given provider.
 */
export function getProviderEndpoint(provider: string): string {
  switch (provider) {
    case 'openai':
      return '/api/openai/v1/chat/completions';
    case 'ollama':
      return '/api/ollama/v1/chat/completions';
    default:
      return '/api/anthropic/v1/messages';
  }
}

/**
 * Convert canonical Anthropic-style messages to OpenAI Chat Completions format.
 */
function convertMessagesToOpenAI(
  messages: Message[],
  systemPrompt?: string,
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];

  // System prompt as first message
  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt });
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      // Check if this is a tool_result message
      const toolResults = msg.content.filter(c => c.type === 'tool_result');
      const textBlocks = msg.content.filter(c => c.type === 'text');

      if (toolResults.length > 0) {
        // Each tool_result becomes a separate "tool" role message
        for (const tr of toolResults) {
          if (tr.type === 'tool_result') {
            result.push({
              role: 'tool',
              tool_call_id: tr.tool_use_id,
              content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
            });
          }
        }
        // Any text blocks alongside tool_results become user messages
        if (textBlocks.length > 0) {
          const text = textBlocks.map(b => b.type === 'text' ? b.text : '').join('\n');
          result.push({ role: 'user', content: text });
        }
      } else {
        // Regular user message
        const text = msg.content
          .map(b => b.type === 'text' ? b.text : '')
          .filter(Boolean)
          .join('\n');
        if (text) {
          result.push({ role: 'user', content: text });
        }
      }
    } else if (msg.role === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: Array<Record<string, unknown>> = [];

      for (const block of msg.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
        }
      }

      const assistantMsg: Record<string, unknown> = { role: 'assistant' };
      if (textParts.length > 0) {
        assistantMsg.content = textParts.join('\n');
      } else {
        assistantMsg.content = null;
      }
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
      }
      result.push(assistantMsg);
    }
  }

  return result;
}

export function createOpenAIChatAdapter(): ProviderAdapter {
  let streamState = createOpenAIStreamState();

  return {
    id: 'openai-chat',

    buildRequest(
      messages: Message[],
      tools: ApiToolDef[],
      config: AgentConfig,
    ): { url: string; headers: Record<string, string>; body: string } {
      const provider = config.provider || 'openai';
      const openaiMessages = convertMessagesToOpenAI(messages, config.systemPrompt);

      const body: Record<string, unknown> = {
        model: config.model,
        messages: openaiMessages,
        stream: true,
        max_completion_tokens: config.maxTokens || 4096,
        stream_options: { include_usage: true },
      };

      if (tools.length > 0) {
        body.tools = tools.map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
          },
        }));
      }

      return {
        url: getProviderEndpoint(provider),
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

      // Handle usage (comes in the final chunk with stream_options.include_usage)
      const usage = p.usage as Record<string, unknown> | undefined;
      if (usage) {
        events.push({
          type: 'usage',
          usage: {
            input_tokens: (usage.prompt_tokens as number) || 0,
            output_tokens: (usage.completion_tokens as number) || 0,
          },
          cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: 'USD' },
        });
      }

      const choices = p.choices as Array<Record<string, unknown>> | undefined;
      if (!choices || choices.length === 0) {
        // First chunk often has id but no choices (just the model info)
        if (p.id && !usage) {
          events.push({ type: 'message_start', messageId: p.id as string });
        }
        return events;
      }

      const choice = choices[0];
      const delta = choice.delta as Record<string, unknown> | undefined;
      const finishReason = choice.finish_reason as string | null;

      if (delta) {
        // Text content
        const content = delta.content as string | undefined;
        if (content) {
          if (!streamState.hasText) {
            streamState.hasText = true;
            streamState.textAccum = '';
          }
          streamState.textAccum += content;
          events.push({ type: 'text_delta', text: content });
        }

        // Tool calls
        const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
        if (toolCalls) {
          // If there was accumulated text, flush it first
          if (streamState.hasText && streamState.textAccum) {
            events.push({ type: 'text_done', text: streamState.textAccum });
            streamState.textAccum = '';
            streamState.hasText = false;
          }

          for (const tc of toolCalls) {
            const index = tc.index as number;
            const fn = tc.function as Record<string, unknown> | undefined;

            if (!streamState.activeToolCalls.has(index)) {
              // New tool call start
              const id = tc.id as string || `tool_${index}`;
              const name = fn?.name as string || '';
              streamState.activeToolCalls.set(index, { id, name, argsAccum: '' });
              events.push({ type: 'tool_use_start', toolUseId: id, toolName: name });
            }

            // Accumulate arguments
            const existing = streamState.activeToolCalls.get(index)!;
            if (fn?.arguments) {
              existing.argsAccum += fn.arguments as string;
              events.push({
                type: 'tool_use_input_delta',
                toolUseId: existing.id,
                partialJson: fn.arguments as string,
              });
            }
          }
        }
      }

      // Handle finish_reason
      if (finishReason) {
        // Flush any pending text
        if (streamState.hasText && streamState.textAccum) {
          events.push({ type: 'text_done', text: streamState.textAccum });
          streamState.textAccum = '';
          streamState.hasText = false;
        }

        // Flush all active tool calls
        const hadToolCalls = streamState.activeToolCalls.size > 0;
        for (const [, tc] of streamState.activeToolCalls) {
          let input: Record<string, unknown> = {};
          try {
            if (tc.argsAccum) {
              input = JSON.parse(tc.argsAccum);
            }
          } catch {
            // Invalid JSON, use empty
          }
          events.push({
            type: 'tool_use_done',
            toolUseId: tc.id,
            toolName: tc.name,
            input,
          });
        }
        streamState.activeToolCalls.clear();

        // Map finish reason.
        // Some providers send finish_reason:"stop" even for tool calls, so if we
        // just flushed tool calls, override to 'tool_use' regardless.
        if (finishReason === 'tool_calls' || hadToolCalls) {
          events.push({ type: 'turn_end', stopReason: 'tool_use' });
        } else if (finishReason === 'stop') {
          events.push({ type: 'turn_end', stopReason: 'end_turn' });
        } else if (finishReason === 'length') {
          events.push({ type: 'turn_end', stopReason: 'max_tokens' });
        } else {
          events.push({ type: 'turn_end', stopReason: 'end_turn' });
        }
      }

      return events;
    },

    extractUsage(data: unknown): TokenUsage {
      const d = data as Record<string, unknown> | null | undefined;
      const usage = d?.usage as Record<string, unknown> | undefined;
      return {
        input_tokens: (usage?.prompt_tokens as number) || 0,
        output_tokens: (usage?.completion_tokens as number) || 0,
      };
    },

    estimateCost(model: string, usage: TokenUsage): CostEstimate {
      return estimateCostForModel(model, usage);
    },

    resetState(): void {
      streamState = createOpenAIStreamState();
    },
  };
}
