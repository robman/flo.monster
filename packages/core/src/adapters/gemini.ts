import type { Message, ApiToolDef, TokenUsage } from '../types/messages.js';
import type { AgentConfig } from '../types/agent.js';
import type { AgentEvent } from '../types/events.js';
import type { ProviderAdapter, CostEstimate, SSEEvent, ModelInfo } from '../types/provider.js';
import { calculateCost } from './cost-utils.js';
import { resolveModelId } from './model-aliases.js';

/**
 * Gemini model registry — native Gemini API models.
 */
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
  'gemini-3-flash-preview': {
    id: 'gemini-3-flash-preview',
    displayName: 'Gemini 3 Flash Preview',
    provider: 'gemini',
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    pricing: { inputPerMillion: 0.50, outputPerMillion: 3.0 },
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

/**
 * Convert a JSON Schema to Gemini's native format.
 *
 * Gemini requires type strings in UPPERCASE, objects must have `properties`,
 * and `additionalProperties` is not supported.
 */
export function convertToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const result = { ...schema };
  delete result.additionalProperties;

  // Convert type to UPPERCASE
  if (typeof result.type === 'string') {
    result.type = result.type.toUpperCase();
  }

  // Gemini requires properties on object types
  if (result.type === 'OBJECT' && !result.properties) {
    result.properties = {};
  }

  // Recurse into properties
  if (result.properties && typeof result.properties === 'object') {
    const props = result.properties as Record<string, Record<string, unknown>>;
    const newProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (typeof value === 'object' && value !== null) {
        newProps[key] = convertToolSchema(value);
      } else {
        newProps[key] = value;
      }
    }
    result.properties = newProps;
  }

  // Recurse into items (for arrays)
  if (result.items && typeof result.items === 'object') {
    result.items = convertToolSchema(result.items as Record<string, unknown>);
  }

  return result;
}

/**
 * Convert canonical messages to Gemini native format.
 *
 * Returns `{ systemInstruction?, contents }` where contents is an array of
 * `{ role, parts }` objects with strict role alternation (user/model).
 */
function convertMessagesToGemini(
  messages: Message[],
  systemPrompt?: string,
): { systemInstruction?: Record<string, unknown>; contents: Array<Record<string, unknown>> } {
  const systemInstruction = systemPrompt
    ? { parts: [{ text: systemPrompt }] }
    : undefined;

  const contents: Array<Record<string, unknown>> = [];

  // Track last assistant tool_use blocks for matching tool_result → name
  let lastToolUses: Map<string, string> = new Map(); // tool_use_id → name

  for (const msg of messages) {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts: Array<Record<string, unknown>> = [];

    if (msg.role === 'assistant') {
      // Track tool uses for next user message's tool results
      const newToolUses = new Map<string, string>();
      for (const block of msg.content) {
        if (block.type === 'text') {
          parts.push({ text: block.text });
        } else if (block.type === 'tool_use') {
          newToolUses.set(block.id, block.name);
          const fcPart: Record<string, unknown> = {
            functionCall: { name: block.name, args: block.input },
          };
          if (block.thoughtSignature) {
            fcPart.thoughtSignature = block.thoughtSignature;
          }
          parts.push(fcPart);
        }
      }
      lastToolUses = newToolUses;
    } else {
      // User message
      for (const block of msg.content) {
        if (block.type === 'text') {
          parts.push({ text: block.text });
        } else if (block.type === 'tool_result') {
          const name = lastToolUses.get(block.tool_use_id) || 'unknown';
          const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
          let response: Record<string, unknown>;
          if (block.is_error) {
            response = { error: content };
          } else {
            try {
              const parsed = JSON.parse(content);
              response = typeof parsed === 'object' && parsed !== null ? parsed : { result: content };
            } catch {
              response = { result: content };
            }
          }
          parts.push({
            functionResponse: { name, response },
          });
        }
      }
    }

    if (parts.length === 0) continue;

    // Merge with previous if same role (Gemini requires strict alternation)
    const lastContent = contents[contents.length - 1];
    if (lastContent && lastContent.role === role) {
      (lastContent.parts as Array<Record<string, unknown>>).push(...parts);
    } else {
      contents.push({ role, parts });
    }
  }

  return { systemInstruction, contents };
}

/**
 * Create a native Gemini API adapter.
 *
 * This talks directly to Google's generateContent/streamGenerateContent API
 * (NOT the OpenAI-compatible endpoint). It uses the native Gemini request
 * format with functionDeclarations and functionCall/functionResponse parts.
 */
export function createGeminiAdapter(): ProviderAdapter {
  let toolCallCounter = 0;
  let textAccum = '';
  let hasText = false;
  let hadToolCalls = false;  // Stateful across chunks — Gemini can split functionCall and finishReason into separate SSE chunks

  return {
    id: 'gemini',

    buildRequest(
      messages: Message[],
      tools: ApiToolDef[],
      config: AgentConfig,
    ): { url: string; headers: Record<string, string>; body: string } {
      const { systemInstruction, contents } = convertMessagesToGemini(messages, config.systemPrompt);

      const body: Record<string, unknown> = { contents };

      if (systemInstruction) {
        body.system_instruction = systemInstruction;
      }

      if (tools.length > 0) {
        body.tools = [{
          functionDeclarations: tools.map(t => ({
            name: t.name,
            description: t.description,
            parameters: convertToolSchema(t.input_schema as Record<string, unknown>),
          })),
        }];
        body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
      }

      body.generationConfig = {
        maxOutputTokens: config.maxTokens || 8192,
      };

      // Model name goes in the URL path (not in body)
      const url = `/api/gemini/v1beta/models/${config.model}:streamGenerateContent?alt=sse`;

      return {
        url,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      };
    },

    parseSSEEvent(event: SSEEvent): AgentEvent[] {
      if (!event.data) return [];

      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return [];
      }

      if (typeof parsed !== 'object' || parsed === null) return [];
      const p = parsed as Record<string, unknown>;
      const events: AgentEvent[] = [];

      // Extract candidates
      const candidates = p.candidates as Array<Record<string, unknown>> | undefined;
      if (candidates && candidates.length > 0) {
        const candidate = candidates[0];
        const content = candidate.content as Record<string, unknown> | undefined;
        const parts = content?.parts as Array<Record<string, unknown>> | undefined;

        if (parts) {
          for (const part of parts) {
            if (part.thought === true && typeof part.text === 'string') {
              // Thinking summary — skip (not actionable)
              continue;
            }

            if (typeof part.text === 'string') {
              // Text delta
              if (!hasText) {
                hasText = true;
                textAccum = '';
              }
              textAccum += part.text;
              events.push({ type: 'text_delta', text: part.text });
            }

            if (part.functionCall) {
              hadToolCalls = true;
              // Flush pending text
              if (hasText && textAccum) {
                events.push({ type: 'text_done', text: textAccum });
                textAccum = '';
                hasText = false;
              }

              const fc = part.functionCall as Record<string, unknown>;
              const name = fc.name as string;
              const args = (fc.args as Record<string, unknown>) || {};
              const id = `gemini_tc_${toolCallCounter++}`;

              events.push({ type: 'tool_use_start', toolUseId: id, toolName: name });
              events.push({ type: 'tool_use_input_delta', toolUseId: id, partialJson: JSON.stringify(args) });

              const doneEvent: AgentEvent = {
                type: 'tool_use_done',
                toolUseId: id,
                toolName: name,
                input: args,
              };

              // Preserve thoughtSignature if present
              if (part.thoughtSignature) {
                (doneEvent as AgentEvent & { thoughtSignature?: string }).thoughtSignature = part.thoughtSignature as string;
              }

              events.push(doneEvent);
            }
          }
        }

        // Handle finish reason
        const finishReason = candidate.finishReason as string | undefined;
        if (finishReason) {
          // Flush any pending text
          if (hasText && textAccum) {
            events.push({ type: 'text_done', text: textAccum });
            textAccum = '';
            hasText = false;
          }

          if (finishReason === 'STOP') {
            // Gemini uses STOP for both text completion AND tool calls
            // Check if we had tool calls in this chunk
            if (hadToolCalls) {
              events.push({ type: 'turn_end', stopReason: 'tool_use' });
            } else {
              events.push({ type: 'turn_end', stopReason: 'end_turn' });
            }
          } else if (finishReason === 'MAX_TOKENS') {
            events.push({ type: 'turn_end', stopReason: 'max_tokens' });
          } else if (finishReason === 'SAFETY' || finishReason === 'RECITATION') {
            events.push({ type: 'error', error: `Gemini blocked response: ${finishReason}` });
            events.push({ type: 'turn_end', stopReason: 'end_turn' });
          }
        }
      }

      // Usage metadata (usually on the final chunk)
      const usageMetadata = p.usageMetadata as Record<string, unknown> | undefined;
      if (usageMetadata) {
        events.push({
          type: 'usage',
          usage: {
            input_tokens: (usageMetadata.promptTokenCount as number) || 0,
            output_tokens: (usageMetadata.candidatesTokenCount as number) || 0,
          },
          cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: 'USD' },
        });
      }

      return events;
    },

    extractUsage(data: unknown): TokenUsage {
      const d = data as Record<string, unknown> | null | undefined;
      const usage = d?.usageMetadata as Record<string, unknown> | undefined;
      return {
        input_tokens: (usage?.promptTokenCount as number) || 0,
        output_tokens: (usage?.candidatesTokenCount as number) || 0,
      };
    },

    estimateCost(model: string, usage: TokenUsage): CostEstimate {
      const info = GEMINI_MODELS[resolveModelId(model)];
      if (!info) {
        return { inputCost: 0, outputCost: 0, totalCost: 0, currency: 'USD' };
      }
      return calculateCost(usage, info.pricing);
    },

    resetState(): void {
      toolCallCounter = 0;
      textAccum = '';
      hasText = false;
      hadToolCalls = false;
    },
  };
}
