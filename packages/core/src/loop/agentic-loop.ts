import type { Message, ContentBlock, ToolUseContent, TokenUsage, ApiToolDef } from '../types/messages.js';
import type { AgentConfig } from '../types/agent.js';
import type { AgentEvent } from '../types/events.js';
import type { ProviderAdapter, CostEstimate } from '../types/provider.js';
import type { ToolResult } from '../types/tools.js';
import { SSEParser } from '../stream/sse-parser.js';
import { accumulateUsage } from '../utils/tokens.js';

/**
 * Parse text-based tool calls from model output.
 * Some models (Gemini) output tool calls as text instead of using function calling:
 *   "toolname\n{json args}"
 * This detects the pattern and converts to proper ToolUseContent blocks.
 */
export function parseTextToolCalls(
  content: ContentBlock[],
  toolNames: Set<string>,
): ToolUseContent[] {
  const results: ToolUseContent[] = [];

  for (const block of content) {
    if (block.type !== 'text') continue;
    const text = block.text.trim();

    // Look for pattern: known tool name followed by JSON object
    // The tool name can be on its own line or immediately before the JSON
    for (const name of toolNames) {
      // Pattern 1: "toolname\n{...}" (tool name on separate line)
      const prefix1 = name + '\n';
      if (text.startsWith(prefix1)) {
        const jsonStr = text.slice(prefix1.length).trim();
        const input = tryParseJson(jsonStr);
        if (input !== null) {
          results.push({
            type: 'tool_use',
            id: `text_tool_${Date.now()}_${results.length}`,
            name,
            input,
          });
          break;
        }
      }

      // Pattern 2: entire text is just "toolname\n{...}" possibly with trailing text
      const idx = text.indexOf(name + '\n');
      if (idx >= 0) {
        const afterName = text.slice(idx + name.length + 1).trim();
        // Extract the JSON object (find the matching closing brace)
        const jsonStr = extractJsonObject(afterName);
        if (jsonStr) {
          const input = tryParseJson(jsonStr);
          if (input !== null) {
            results.push({
              type: 'tool_use',
              id: `text_tool_${Date.now()}_${results.length}`,
              name,
              input,
            });
            break;
          }
        }
      }
    }
  }

  return results;
}

function tryParseJson(str: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(str);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Not valid JSON
  }
  return null;
}

function extractJsonObject(str: string): string | null {
  if (!str.startsWith('{')) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') { depth--; if (depth === 0) return str.slice(0, i + 1); }
  }
  return null;
}

export interface LoopDeps {
  sendApiRequest(body: string, headers: Record<string, string>, url: string): AsyncIterable<string>;
  executeToolCall(name: string, input: Record<string, unknown>): Promise<ToolResult>;
  emit(event: AgentEvent): void;
  adapter: ProviderAdapter;
}

export async function runAgenticLoop(
  config: AgentConfig,
  initialMessage: string,
  deps: LoopDeps,
  existingMessages?: Message[],
): Promise<Message[]> {
  const messages: Message[] = existingMessages ? [...existingMessages] : [];
  const tools: ApiToolDef[] = config.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));

  // Add initial user message
  messages.push({
    role: 'user',
    content: [{ type: 'text', text: initialMessage }],
  });

  let totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
  let running = true;
  const MAX_ITERATIONS = 200;
  let iterations = 0;

  while (running) {
    // Check iteration limit
    iterations++;
    if (iterations > MAX_ITERATIONS) {
      deps.emit({
        type: 'budget_exceeded',
        reason: 'iteration_limit',
        message: `Exceeded maximum iterations (${MAX_ITERATIONS})`,
      });
      return messages;
    }

    deps.adapter.resetState();
    const { url, headers, body } = deps.adapter.buildRequest(messages, tools, config);

    const parser = new SSEParser();
    let assistantContent: ContentBlock[] = [];
    let stopReason: string = 'end_turn';
    const toolCalls: ToolUseContent[] = [];

    try {
      for await (const chunk of deps.sendApiRequest(body, headers, url)) {
        const sseEvents = parser.feed(chunk);
        for (const sseEvent of sseEvents) {
          const agentEvents = deps.adapter.parseSSEEvent(sseEvent);
          for (const event of agentEvents) {
            if (event.type === 'usage') {
              // Accumulate usage, emit only cumulative with cost
              totalUsage = accumulateUsage(totalUsage, event.usage);
              const cost = deps.adapter.estimateCost(config.model, totalUsage);
              deps.emit({ type: 'usage', usage: { ...totalUsage }, cost });
              // Check token budget
              if (config.tokenBudget && (totalUsage.input_tokens + totalUsage.output_tokens) > config.tokenBudget) {
                deps.emit({
                  type: 'budget_exceeded',
                  reason: 'token_limit',
                  message: `Token budget exceeded: ${totalUsage.input_tokens + totalUsage.output_tokens} > ${config.tokenBudget}`,
                });
                return messages;
              }
              // Check cost budget
              if (config.costBudgetUsd && cost.totalCost > config.costBudgetUsd) {
                deps.emit({
                  type: 'budget_exceeded',
                  reason: 'cost_limit',
                  message: `Cost budget exceeded: $${cost.totalCost.toFixed(4)} > $${config.costBudgetUsd}`,
                });
                return messages;
              }
            } else {
              deps.emit(event);

              // Track content
              if (event.type === 'text_done') {
                assistantContent.push({ type: 'text', text: event.text });
              } else if (event.type === 'tool_use_done') {
                const toolUse: ToolUseContent = {
                  type: 'tool_use',
                  id: event.toolUseId,
                  name: event.toolName,
                  input: event.input,
                };
                if (event.thoughtSignature) {
                  toolUse.thoughtSignature = event.thoughtSignature;
                }
                assistantContent.push(toolUse);
                toolCalls.push(toolUse);
              } else if (event.type === 'turn_end') {
                stopReason = event.stopReason;
              }
            }
          }
        }
      }
    } catch (err) {
      deps.emit({ type: 'error', error: String(err) });
      return messages;
    }

    // Fallback: detect tool calls output as text (some models like Gemini
    // fall back to text-based tool calls despite proper function calling setup).
    // Pattern: "toolname\n{json}" where toolname is a known tool.
    if (toolCalls.length === 0 && assistantContent.length > 0) {
      const toolNames = new Set(tools.map(t => t.name));
      const parsed = parseTextToolCalls(assistantContent, toolNames);
      if (parsed.length > 0) {
        // Remove text blocks that contained tool calls — keeping them causes the model
        // to see both the raw text AND the structured call in history, leading to loops.
        const parsedNames = new Set(parsed.map(tc => tc.name));
        assistantContent = assistantContent.filter(block => {
          if (block.type !== 'text') return true;
          const text = block.text.trim();
          for (const name of parsedNames) {
            if (text.includes(name + '\n')) return false;
          }
          return true;
        });
        for (const tc of parsed) {
          assistantContent.push(tc);
          toolCalls.push(tc);
        }
        stopReason = 'tool_use';
      }
    }

    // Add assistant message to history
    if (assistantContent.length > 0) {
      messages.push({ role: 'assistant', content: assistantContent });
    }

    // Handle tool calls
    if (stopReason === 'tool_use' && toolCalls.length > 0) {
      const toolResults: ContentBlock[] = [];

      for (const toolCall of toolCalls) {
        try {
          const result = await deps.executeToolCall(toolCall.name, toolCall.input);
          deps.emit({ type: 'tool_result', toolUseId: toolCall.id, result });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolCall.id,
            content: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
            is_error: result.is_error,
          });
        } catch (err) {
          const errorResult: ToolResult = { content: String(err), is_error: true };
          deps.emit({ type: 'tool_result', toolUseId: toolCall.id, result: errorResult });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolCall.id,
            content: String(err),
            is_error: true,
          });
        }
      }

      // Add tool results as user message
      messages.push({ role: 'user', content: toolResults });
      // Continue loop to get next response
    } else {
      // End turn or max tokens - stop looping
      running = false;
    }
  }

  return messages;
}
