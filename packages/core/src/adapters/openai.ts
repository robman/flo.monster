import type {
  Message, ApiToolDef, TokenUsage, ContentBlock,
  ToolUseContent,
} from '../types/messages.js';
import type { AgentConfig } from '../types/agent.js';
import type { AgentEvent } from '../types/events.js';
import type { ProviderAdapter, CostEstimate, SSEEvent, ModelInfo } from '../types/provider.js';
import { calculateCost } from './cost-utils.js';

// OpenAI model pricing (per million tokens)
export const OPENAI_MODELS: Record<string, ModelInfo> = {
  // GPT-5 series (Aug 2025)
  'gpt-5': {
    id: 'gpt-5',
    displayName: 'GPT-5',
    provider: 'openai',
    contextWindow: 400000,
    maxOutputTokens: 32768,
    pricing: { inputPerMillion: 1.25, outputPerMillion: 10.0 },
  },
  'gpt-5-nano': {
    id: 'gpt-5-nano',
    displayName: 'GPT-5 Nano',
    provider: 'openai',
    contextWindow: 400000,
    maxOutputTokens: 16384,
    pricing: { inputPerMillion: 0.05, outputPerMillion: 0.40 },
  },
  // GPT-4 series
  'gpt-4o': {
    id: 'gpt-4o',
    displayName: 'GPT-4o',
    provider: 'openai',
    contextWindow: 128000,
    maxOutputTokens: 16384,
    pricing: { inputPerMillion: 2.5, outputPerMillion: 10.0 },
  },
  'gpt-4o-mini': {
    id: 'gpt-4o-mini',
    displayName: 'GPT-4o Mini',
    provider: 'openai',
    contextWindow: 128000,
    maxOutputTokens: 16384,
    pricing: { inputPerMillion: 0.15, outputPerMillion: 0.60 },
  },
  // Reasoning models
  'o3-mini': {
    id: 'o3-mini',
    displayName: 'o3-mini',
    provider: 'openai',
    contextWindow: 200000,
    maxOutputTokens: 100000,
    pricing: { inputPerMillion: 1.10, outputPerMillion: 4.40 },
  },
};

// Gemini model pricing (per million tokens)
export const GEMINI_MODELS: Record<string, ModelInfo> = {
  // Gemini 3 series (preview)
  'gemini-3-pro-preview': {
    id: 'gemini-3-pro-preview',
    displayName: 'Gemini 3 Pro Preview',
    provider: 'gemini',
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    pricing: { inputPerMillion: 2.0, outputPerMillion: 12.0 },
  },
  // Gemini 2.5 series
  'gemini-2.5-pro': {
    id: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    provider: 'gemini',
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    pricing: { inputPerMillion: 1.25, outputPerMillion: 10.0 },
  },
  'gemini-2.5-flash': {
    id: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    provider: 'gemini',
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    pricing: { inputPerMillion: 0.30, outputPerMillion: 2.50 },
  },
  'gemini-2.5-flash-lite': {
    id: 'gemini-2.5-flash-lite',
    displayName: 'Gemini 2.5 Flash-Lite',
    provider: 'gemini',
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    pricing: { inputPerMillion: 0.10, outputPerMillion: 0.40 },
  },
  // Gemini 2.0 series (deprecated March 31, 2026)
  'gemini-2.0-flash': {
    id: 'gemini-2.0-flash',
    displayName: 'Gemini 2.0 Flash (Deprecated)',
    provider: 'gemini',
    contextWindow: 1048576,
    maxOutputTokens: 8192,
    pricing: { inputPerMillion: 0.10, outputPerMillion: 0.40 },
  },
};

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
    case 'gemini':
      return '/api/gemini/v1beta/openai/chat/completions';
    case 'ollama':
      return '/api/ollama/v1/chat/completions';
    default:
      return '/api/anthropic/v1/messages';
  }
}

/**
 * Sanitize a JSON Schema for providers that don't support all features.
 * Gemini doesn't support `additionalProperties` in tool schemas,
 * and requires `properties` on all object types (bare `{type:'object'}`
 * without properties causes Gemini to fall back to text-based tool calls).
 */
export function sanitizeToolSchema(provider: string, schema: Record<string, unknown>): Record<string, unknown> {
  if (provider !== 'gemini') return schema;

  const sanitized = { ...schema };
  delete sanitized.additionalProperties;

  // Gemini requires `properties` on object types — bare {type:'object'}
  // causes function calling to silently fail (model outputs tool calls as text).
  if (sanitized.type === 'object' && !sanitized.properties) {
    sanitized.properties = {};
  }

  // Recurse into properties
  if (sanitized.properties && typeof sanitized.properties === 'object') {
    const props = sanitized.properties as Record<string, Record<string, unknown>>;
    const newProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (typeof value === 'object' && value !== null) {
        newProps[key] = sanitizeToolSchema(provider, value);
      } else {
        newProps[key] = value;
      }
    }
    sanitized.properties = newProps;
  }

  // Recurse into items (for arrays)
  if (sanitized.items && typeof sanitized.items === 'object') {
    sanitized.items = sanitizeToolSchema(provider, sanitized.items as Record<string, unknown>);
  }

  return sanitized;
}

/**
 * Convert canonical Anthropic-style messages to OpenAI Chat Completions format.
 *
 * Gemini's OpenAI-compatible API doesn't support tool_calls/tool role in
 * conversation history (returns "Invalid content part type 'tool_use'").
 * For Gemini, we convert tool call turns to text descriptions so the model
 * retains context without relying on the broken history format.
 */
function convertMessagesToOpenAI(
  messages: Message[],
  systemPrompt?: string,
  provider?: string,
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  const isGemini = provider === 'gemini';

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
        if (isGemini) {
          // Gemini: convert tool results to user text
          const parts: string[] = [];
          for (const tr of toolResults) {
            if (tr.type === 'tool_result') {
              const content = typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content);
              parts.push(`[Tool result: ${content}]`);
            }
          }
          for (const tb of textBlocks) {
            if (tb.type === 'text') parts.push(tb.text);
          }
          if (parts.length > 0) {
            result.push({ role: 'user', content: parts.join('\n') });
          }
        } else {
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
          if (isGemini) {
            // Gemini: convert tool calls to text
            textParts.push(`[Called tool: ${block.name}(${JSON.stringify(block.input)})]`);
          } else {
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
      const openaiMessages = convertMessagesToOpenAI(messages, config.systemPrompt, provider);

      const isGemini = provider === 'gemini';

      const body: Record<string, unknown> = {
        model: config.model,
        messages: openaiMessages,
        stream: true,
      };

      // Gemini's OpenAI-compatible endpoint uses max_tokens, not max_completion_tokens.
      // It also doesn't support stream_options.
      if (isGemini) {
        body.max_tokens = config.maxTokens || 4096;
      } else {
        body.max_completion_tokens = config.maxTokens || 4096;
        body.stream_options = { include_usage: true };
      }

      if (tools.length > 0) {
        body.tools = tools.map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: sanitizeToolSchema(provider, t.input_schema as Record<string, unknown>),
          },
        }));
        // Gemini needs explicit tool_choice to enable function calling
        if (isGemini) {
          body.tool_choice = 'auto';
        }
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
        // Gemini sends finish_reason:"stop" even for tool calls, so if we
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
      const allModels = { ...OPENAI_MODELS, ...GEMINI_MODELS };
      const info = allModels[model];
      if (!info) {
        return { inputCost: 0, outputCost: 0, totalCost: 0, currency: 'USD' };
      }

      return calculateCost(usage, info.pricing);
    },

    resetState(): void {
      streamState = createOpenAIStreamState();
    },
  };
}
