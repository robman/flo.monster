import type { IframeToShell, ShellToIframe } from '@flo-monster/core';
import { buildContextMessages, toApiMessage, MESSAGE_API_FIELDS, GEMINI_API_FIELDS, compressBrowseResults } from '@flo-monster/core';
import type { AgentStorageProvider } from '../../storage/agent-storage.js';
import type { ProxySettings } from './types.js';
import { extractTerseSummary, appendTerseSummary, generateTurnId, loadTerseContext } from './context-manager.js';

/**
 * Function type for streaming API requests through a hub WebSocket connection.
 * Used by Mode 3 (hub shared keys, browser loop) to bypass PNA restrictions.
 */
export type HubStreamFn = (
  provider: string,
  path: string,
  payload: unknown,
  callbacks: {
    onChunk: (chunk: string) => void;
    onEnd: () => void;
    onError: (error: string) => void;
  },
) => void;

/**
 * Get the API endpoint URL based on proxy settings and provider.
 * Provider-specific paths:
 *   anthropic -> /api/anthropic/v1/messages
 *   openai    -> /api/openai/v1/chat/completions
 *   gemini    -> /api/gemini/v1beta/openai/chat/completions (OpenAI-compat fallback; native Gemini uses dynamic URL via msg.endpoint)
 *   ollama    -> /api/ollama/v1/chat/completions
 */
export function getApiEndpoint(provider: string, proxySettings: ProxySettings): string {
  const providerPaths: Record<string, string> = {
    anthropic: '/api/anthropic/v1/messages',
    openai: '/api/openai/v1/chat/completions',
    gemini: '/api/gemini/v1beta/openai/chat/completions',
    ollama: '/api/ollama/v1/chat/completions',
  };
  const path = providerPaths[provider] || '/api/anthropic/v1/messages';

  if (proxySettings.useBuiltinProxy !== false) {
    return path;
  }
  if (proxySettings.corsProxyUrl) {
    const baseUrl = proxySettings.corsProxyUrl.replace(/\/$/, '');
    // Strip the /api prefix for external proxy
    return `${baseUrl}${path.replace(/^\/api/, '')}`;
  }
  return path;
}

export interface ApiRequestOptions {
  contextMode?: 'slim' | 'full';
  fullContextTurns?: number;
}

export async function handleApiRequest(
  msg: Extract<IframeToShell, { type: 'api_request' }>,
  target: Window,
  agentId: string,
  provider: string,
  proxySettings: ProxySettings,
  getProvider: () => Promise<AgentStorageProvider>,
  options?: ApiRequestOptions,
  hubStream?: HubStreamFn,
): Promise<void> {
  try {
    // Deep clone payload to avoid mutating the original
    const payload = JSON.parse(JSON.stringify(msg.payload));

    const contextMode = options?.contextMode ?? 'slim';
    const fullContextTurns = options?.fullContextTurns ?? 3;

    // Generate a turn ID for this turn
    const turnId = await generateTurnId(agentId, getProvider);

    // Load stored conversation history (for saving after response)
    const storedMessages = await loadConversationContext(agentId, getProvider);

    // Load terse entries for context building
    const terseEntries = await loadTerseContext(agentId, getProvider);

    // Gemini native format uses `contents` instead of `messages`.
    // Detect which field to use based on the payload structure.
    const isGeminiNative = !payload.messages && Array.isArray(payload.contents);

    // Extract and strip message type metadata (not an API field — worker attaches it for storage only)
    const firstUserMessageType = payload._firstUserMessageType as string | undefined;
    delete payload._firstUserMessageType;

    // The request's messages/contents are the current turn — tag with turnId.
    const rawTurnItems = (isGeminiNative ? payload.contents : payload.messages) || [];
    // Keep original format for the current request
    const turnMessages = rawTurnItems.map((m: Record<string, unknown>) => ({ ...m, turnId }));
    // For storage: normalize Gemini messages to canonical format (role: assistant/user, content blocks)
    // so context works when switching providers. Also filter out system messages — the worker
    // injects the system prompt on every request, so storing it duplicates it each turn.
    const isOpenAI = provider === 'openai' || provider === 'ollama';
    const turnMessagesForStorage = (isGeminiNative
      ? rawTurnItems.map((m: Record<string, unknown>) => ({ ...normalizeGeminiMessage(m), turnId }))
      : isOpenAI
        ? normalizeOpenAIMessages(rawTurnItems as Array<Record<string, unknown>>).map(m => ({ ...m, turnId }))
        : turnMessages
    ).filter((m: Record<string, unknown>) => m.role !== 'system');

    // Apply message type to the first user message in storage (e.g. type: 'intervention').
    // IMPORTANT: Replace the array element instead of mutating — turnMessagesForStorage shares
    // object references with turnMessages, which is used to build the API request payload.
    // Mutating would leak the type field into the API body (causing 400 from strict providers).
    if (firstUserMessageType) {
      for (let i = 0; i < turnMessagesForStorage.length; i++) {
        if (turnMessagesForStorage[i].role === 'user') {
          turnMessagesForStorage[i] = { ...turnMessagesForStorage[i], type: firstUserMessageType };
          break;
        }
      }
    }

    // Build context messages using the unified strategy
    const rawContextMessages = buildContextMessages(
      terseEntries,
      storedMessages as Array<Record<string, unknown>>,
      { contextMode, maxTerseEntries: 50, fullContextTurns },
    );
    // Compress stale browse accessibility trees — only the latest tree is actionable
    const contextMessages = compressBrowseResults(rawContextMessages as Array<Record<string, unknown>>);

    if (isGeminiNative) {
      // Gemini native: context messages are in canonical format (role/content blocks).
      // Convert to Gemini contents format: text → text parts, tool_use → functionCall,
      // tool_result → functionResponse. Mirrors convertMessagesToGemini() in core adapter.
      let lastToolUses = new Map<string, string>();
      const contextContents = contextMessages.map((m: Record<string, unknown>) => {
        const role = m.role === 'assistant' ? 'model' : 'user';
        const content = m.content as Array<Record<string, unknown>> | undefined;
        const parts: Array<Record<string, unknown>> = [];
        if (content) {
          if (role === 'model') {
            const newToolUses = new Map<string, string>();
            for (const block of content) {
              if (block.type === 'text') {
                parts.push({ text: block.text });
              } else if (block.type === 'tool_use') {
                newToolUses.set(block.id as string, block.name as string);
                parts.push({ functionCall: { name: block.name, args: block.input } });
              }
            }
            lastToolUses = newToolUses;
          } else {
            for (const block of content) {
              if (block.type === 'text') {
                parts.push({ text: block.text });
              } else if (block.type === 'tool_result') {
                const name = lastToolUses.get(block.tool_use_id as string) || 'unknown';
                const rawContent = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
                let response: Record<string, unknown>;
                try {
                  const parsed = JSON.parse(rawContent as string);
                  response = typeof parsed === 'object' && parsed !== null ? parsed : { result: rawContent };
                } catch {
                  response = { result: rawContent };
                }
                parts.push({ functionResponse: { name, response } });
              }
            }
          }
        }
        return parts.length > 0 ? { role, parts } : null;
      }).filter(Boolean);

      // Merge context + turn contents, ensuring role alternation
      const allContents: Array<Record<string, unknown>> = [];
      for (const item of [...contextContents, ...turnMessages]) {
        const typedItem = item as Record<string, unknown>;
        const last = allContents[allContents.length - 1];
        if (last && last.role === typedItem.role) {
          // Merge consecutive same-role entries
          (last.parts as Array<Record<string, unknown>>).push(
            ...(typedItem.parts as Array<Record<string, unknown>>),
          );
        } else {
          allContents.push({ ...typedItem });
        }
      }
      // Allowlist: only Gemini API fields pass through. Internal metadata
      // (turnId, type, messageType, timestamp, etc.) is automatically excluded.
      payload.contents = allContents.map(m => toApiMessage(m, GEMINI_API_FIELDS));
    } else {
      // Context messages are stored in canonical (Anthropic) format. For OpenAI/Ollama,
      // convert them back to wire format (tool_calls, role:'tool', etc.) since the OpenAI
      // API doesn't understand tool_use/tool_result content blocks.
      const apiContextMessages = isOpenAI
        ? canonicalToOpenAIMessages(contextMessages as Array<Record<string, unknown>>)
        : contextMessages;

      // Allowlist: only Anthropic/OpenAI API fields pass through. Internal metadata
      // (turnId, type, messageType, timestamp, etc.) is automatically excluded.
      // Content block fields (type: 'text', etc.) are nested inside content and unaffected.
      payload.messages = [...apiContextMessages, ...turnMessages].map(
        m => toApiMessage(m, MESSAGE_API_FIELDS),
      );
    }

    // Use worker-provided endpoint (e.g. native Gemini URL) or fall back to static provider path
    const apiEndpoint = (msg.endpoint as string) || getApiEndpoint(provider, proxySettings);

    if (hubStream) {
      // Mode 3: stream through hub WebSocket
      let fullResponseText = '';

      await new Promise<void>((resolve, reject) => {
        hubStream(provider, apiEndpoint, payload, {
          onChunk: (chunk: string) => {
            fullResponseText += chunk;
            target.postMessage({
              type: 'api_response_chunk',
              id: msg.id,
              chunk,
            } satisfies ShellToIframe, '*');
          },
          onEnd: () => resolve(),
          onError: (err: string) => reject(new Error(err)),
        });
      });

      // Parse assistant response from SSE stream and save context
      const parsed = parseAssistantFromSSE(fullResponseText, provider);
      if (parsed && parsed.message) {
        if (parsed.stopReason !== 'tool_use') {
          const taggedResponse = { ...parsed.message, turnId };
          const fullHistory = [...storedMessages, ...turnMessagesForStorage, taggedResponse];
          await saveConversationContext(agentId, fullHistory, getProvider);
          const terseSummary = extractTerseSummary(parsed.message);
          if (terseSummary) {
            await appendTerseSummary(agentId, terseSummary, 'assistant', turnId, getProvider);
          }
        }
      }

      target.postMessage({
        type: 'api_response_end',
        id: msg.id,
      } satisfies ShellToIframe, '*');
    } else {
      // Modes 1/2: direct fetch (existing path)
      const response = await fetch(apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        target.postMessage({
          type: 'api_response_error',
          id: msg.id,
          error: `HTTP ${response.status}: ${errorText}`,
        } satisfies ShellToIframe, '*');
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        target.postMessage({
          type: 'api_response_error',
          id: msg.id,
          error: 'No response body',
        } satisfies ShellToIframe, '*');
        return;
      }

      const decoder = new TextDecoder();
      let fullResponseText = ''; // Buffer for SSE parsing

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        fullResponseText += chunk; // Buffer
        target.postMessage({
          type: 'api_response_chunk',
          id: msg.id,
          chunk,
        } satisfies ShellToIframe, '*');
      }

      // Parse assistant response from SSE stream
      const parsed = parseAssistantFromSSE(fullResponseText, provider);
      if (parsed && parsed.message) {
        // Only save context when the turn is complete (not tool_use)
        if (parsed.stopReason !== 'tool_use') {
          const taggedResponse = { ...parsed.message, turnId };
          const fullHistory = [...storedMessages, ...turnMessagesForStorage, taggedResponse];
          await saveConversationContext(agentId, fullHistory, getProvider);
          const terseSummary = extractTerseSummary(parsed.message);
          if (terseSummary) {
            await appendTerseSummary(agentId, terseSummary, 'assistant', turnId, getProvider);
          }
        }
      }

      target.postMessage({
        type: 'api_response_end',
        id: msg.id,
      } satisfies ShellToIframe, '*');
    }
  } catch (err) {
    target.postMessage({
      type: 'api_response_error',
      id: msg.id,
      error: String(err),
    } satisfies ShellToIframe, '*');
  }
}

export function parseAssistantFromSSE(sseText: string, provider: string = 'anthropic'): { message: Record<string, unknown>; stopReason: string } | null {
  if (provider === 'gemini') {
    return parseGeminiAssistantFromSSE(sseText);
  }
  if (provider !== 'anthropic') {
    return parseOpenAIAssistantFromSSE(sseText);
  }
  // Parse Anthropic SSE events -- look for content blocks and stop_reason
  const contentBlocks: unknown[] = [];
  let stopReason = 'end_turn';
  const lines = sseText.split('\n').map(l => l.replace(/\r$/, ''));
  let currentEvent = '';
  let currentData = '';

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      currentData = line.slice(6);
    } else if (line === '' && currentEvent && currentData) {
      // Process event
      try {
        const parsed = JSON.parse(currentData);
        if (currentEvent === 'content_block_start' && parsed.content_block) {
          contentBlocks.push({ ...parsed.content_block });
        } else if (currentEvent === 'content_block_delta' && parsed.delta) {
          const lastBlock = contentBlocks[contentBlocks.length - 1] as Record<string, unknown>;
          if (lastBlock && parsed.delta.type === 'text_delta' && parsed.delta.text) {
            lastBlock.text = ((lastBlock.text as string) || '') + parsed.delta.text;
          } else if (lastBlock && parsed.delta.type === 'input_json_delta' && parsed.delta.partial_json) {
            lastBlock.input = ((lastBlock.input as string) || '') + parsed.delta.partial_json;
          }
        } else if (currentEvent === 'message_delta' && parsed.delta?.stop_reason) {
          stopReason = parsed.delta.stop_reason;
        }
      } catch {
        // Skip unparseable events
      }
      currentEvent = '';
      currentData = '';
    }
  }

  if (contentBlocks.length === 0) return null;

  // Parse any accumulated JSON input in tool_use blocks
  for (const block of contentBlocks) {
    const b = block as Record<string, unknown>;
    if (b.type === 'tool_use' && typeof b.input === 'string') {
      try {
        b.input = JSON.parse(b.input as string);
      } catch {
        b.input = {};
      }
    }
  }

  return { message: { role: 'assistant', content: contentBlocks }, stopReason };
}

/**
 * Parse OpenAI-format SSE stream into canonical ContentBlock[] format.
 * Used for OpenAI, Gemini, and Ollama providers (all use OpenAI-compatible format).
 */
function parseOpenAIAssistantFromSSE(sseText: string): { message: Record<string, unknown>; stopReason: string } | null {
  const contentBlocks: unknown[] = [];
  let stopReason = 'end_turn';
  let currentText = '';
  const toolCalls: Record<number, { id: string; name: string; argsAccum: string }> = {};

  const lines = sseText.split('\n').map(l => l.replace(/\r$/, ''));
  let currentData = '';

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      currentData = line.slice(6);
    } else if (line === '' && currentData) {
      if (currentData === '[DONE]') {
        currentData = '';
        continue;
      }
      try {
        const parsed = JSON.parse(currentData);
        const choices = parsed.choices;
        if (choices && choices.length > 0) {
          const delta = choices[0].delta;
          const finishReason = choices[0].finish_reason;

          if (delta) {
            if (delta.content) {
              currentText += delta.content;
            }
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const index = tc.index;
                if (!toolCalls[index]) {
                  toolCalls[index] = { id: tc.id || `tool_${index}`, name: tc.function?.name || '', argsAccum: '' };
                }
                if (tc.function?.name) {
                  toolCalls[index].name = tc.function.name;
                }
                if (tc.function?.arguments) {
                  toolCalls[index].argsAccum += tc.function.arguments;
                }
              }
            }
          }

          if (finishReason) {
            if (finishReason === 'tool_calls') stopReason = 'tool_use';
            else if (finishReason === 'stop') stopReason = 'end_turn';
            else if (finishReason === 'length') stopReason = 'max_tokens';
          }
        }
      } catch {
        // Skip unparseable events
      }
      currentData = '';
    }
  }

  // Build canonical content blocks
  if (currentText) {
    contentBlocks.push({ type: 'text', text: currentText });
  }
  for (const [, tc] of Object.entries(toolCalls)) {
    let input = {};
    try { if (tc.argsAccum) input = JSON.parse(tc.argsAccum); } catch { /* empty */ }
    contentBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
  }

  if (contentBlocks.length === 0) return null;
  return { message: { role: 'assistant', content: contentBlocks }, stopReason };
}

/**
 * Parse Gemini native SSE stream into canonical ContentBlock[] format.
 * Gemini uses `candidates[0].content.parts` with `text`, `functionCall` parts
 * and `finishReason` instead of OpenAI's `choices[0].delta`.
 */
function parseGeminiAssistantFromSSE(sseText: string): { message: Record<string, unknown>; stopReason: string } | null {
  const contentBlocks: unknown[] = [];
  let stopReason = 'end_turn';
  let currentText = '';
  let toolCallCounter = 0;

  const lines = sseText.split('\n').map(l => l.replace(/\r$/, ''));
  let currentData = '';

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      currentData = line.slice(6);
    } else if (line.startsWith('data:')) {
      currentData = line.slice(5).trimStart();
    } else if (line === '' && currentData) {
      try {
        const parsed = JSON.parse(currentData);
        const candidates = parsed.candidates;
        if (candidates && candidates.length > 0) {
          const candidate = candidates[0];
          const parts = candidate.content?.parts;

          if (parts) {
            for (const part of parts) {
              // Skip thinking parts
              if (part.thought === true) continue;

              if (typeof part.text === 'string') {
                currentText += part.text;
              }
              if (part.functionCall) {
                const fc = part.functionCall;
                contentBlocks.push({
                  type: 'tool_use',
                  id: `gemini_tc_${toolCallCounter++}`,
                  name: fc.name,
                  input: fc.args || {},
                  ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
                });
              }
            }
          }

          const finishReason = candidate.finishReason;
          if (finishReason === 'STOP') {
            stopReason = contentBlocks.length > 0 ? 'tool_use' : 'end_turn';
          } else if (finishReason === 'MAX_TOKENS') {
            stopReason = 'max_tokens';
          }
        }
      } catch {
        // Skip unparseable events
      }
      currentData = '';
    }
  }

  // Add text block first (before tool calls)
  if (currentText) {
    contentBlocks.unshift({ type: 'text', text: currentText });
  }

  if (contentBlocks.length === 0) return null;
  return { message: { role: 'assistant', content: contentBlocks }, stopReason };
}

/**
 * Normalize an OpenAI-format message to canonical format
 * (role: user/assistant, content blocks) for cross-provider context storage.
 *
 * OpenAI wire format differs from canonical:
 *   - content can be string, null, or array
 *   - tool calls are in tool_calls array (not content blocks)
 *   - tool results use role:'tool' + tool_call_id (not role:'user' + tool_result block)
 *
 * We merge consecutive tool-result messages into the preceding user message
 * to match the Anthropic conversation structure.
 */
export function normalizeOpenAIMessages(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];

  for (const m of messages) {
    const role = m.role as string;

    if (role === 'tool') {
      // OpenAI tool results: merge into preceding user message as tool_result content block.
      // If no preceding user message, create one.
      let target = result[result.length - 1];
      if (!target || target.role !== 'user') {
        target = { role: 'user', content: [] };
        result.push(target);
      }
      (target.content as Array<Record<string, unknown>>).push({
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
      });
    } else if (role === 'assistant') {
      const content: Array<Record<string, unknown>> = [];
      // Text content
      if (typeof m.content === 'string' && m.content) {
        content.push({ type: 'text', text: m.content });
      }
      // Tool calls → tool_use blocks
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls as Array<Record<string, unknown>>) {
          const fn = tc.function as Record<string, unknown> | undefined;
          let input = {};
          try { if (fn?.arguments) input = JSON.parse(fn.arguments as string); } catch { /* empty */ }
          content.push({
            type: 'tool_use',
            id: tc.id as string,
            name: fn?.name as string,
            input,
          });
        }
      }
      result.push({ role: 'assistant', content });
    } else if (role === 'user') {
      const content: Array<Record<string, unknown>> = [];
      if (typeof m.content === 'string' && m.content) {
        content.push({ type: 'text', text: m.content });
      } else if (Array.isArray(m.content)) {
        content.push(...(m.content as Array<Record<string, unknown>>));
      }
      result.push({ role: 'user', content });
    }
    // Skip system messages (already filtered separately)
  }

  return result;
}

/**
 * Convert canonical (Anthropic) format context messages back to OpenAI wire format.
 * This is the reverse of normalizeOpenAIMessages() — used when building the API
 * request payload for OpenAI/Ollama from stored canonical context.
 *
 * Conversions:
 *   - assistant content with tool_use blocks → tool_calls array + content: null/string
 *   - user content with tool_result blocks → separate role:'tool' messages
 *   - other messages pass through unchanged
 */
export function canonicalToOpenAIMessages(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];

  for (const m of messages) {
    const role = m.role as string;
    const content = m.content;

    if (!Array.isArray(content)) {
      // String content or null — pass through as-is
      result.push({ ...m });
      continue;
    }

    const blocks = content as Array<Record<string, unknown>>;

    if (role === 'assistant') {
      // Convert tool_use blocks → tool_calls array, text blocks → content string
      const textParts: string[] = [];
      const toolCalls: Array<Record<string, unknown>> = [];

      for (const block of blocks) {
        if (block.type === 'text') {
          textParts.push(block.text as string);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        }
      }

      const msg: Record<string, unknown> = { role: 'assistant' };
      msg.content = textParts.length > 0 ? textParts.join('') : null;
      if (toolCalls.length > 0) {
        msg.tool_calls = toolCalls;
      }
      result.push(msg);
    } else if (role === 'user') {
      // Split: tool_result blocks → separate role:'tool' messages, rest stays as user
      const toolResults = blocks.filter(b => b.type === 'tool_result');
      const otherBlocks = blocks.filter(b => b.type !== 'tool_result');

      if (otherBlocks.length > 0) {
        result.push({ role: 'user', content: otherBlocks });
      }

      for (const tr of toolResults) {
        result.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content ?? ''),
        });
      }
    } else {
      result.push({ ...m });
    }
  }

  return result;
}

/**
 * Normalize a Gemini-format message (role: model, parts) to canonical format
 * (role: assistant/user, content blocks) for cross-provider context storage.
 */
function normalizeGeminiMessage(m: Record<string, unknown>): Record<string, unknown> {
  const role = m.role === 'model' ? 'assistant' : (m.role as string) || 'user';
  const parts = m.parts as Array<Record<string, unknown>> | undefined;
  if (!parts) return { role, content: [] };

  const content: Array<Record<string, unknown>> = [];
  for (const part of parts) {
    if (typeof part.text === 'string') {
      if (part.text) content.push({ type: 'text', text: part.text });
    } else if (part.functionCall) {
      const fc = part.functionCall as Record<string, unknown>;
      content.push({
        type: 'tool_use',
        id: `gemini_ctx_${Date.now()}_${content.length}`,
        name: fc.name,
        input: fc.args || {},
        ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
      });
    } else if (part.functionResponse) {
      const fr = part.functionResponse as Record<string, unknown>;
      content.push({
        type: 'tool_result',
        tool_use_id: `gemini_ctx_${Date.now()}_${content.length}`,
        content: JSON.stringify(fr.response || {}),
      });
    }
  }
  return { role, content, ...(m.type ? { type: m.type } : {}) };
}

export async function loadConversationContext(
  agentId: string,
  getProvider: () => Promise<AgentStorageProvider>,
): Promise<unknown[]> {
  try {
    const provider = await getProvider();
    const content = await provider.readFile(agentId, 'context.json');
    return JSON.parse(content);
  } catch {
    return [];
  }
}

async function saveConversationContext(
  agentId: string,
  messages: unknown[],
  getProvider: () => Promise<AgentStorageProvider>,
): Promise<void> {
  try {
    const provider = await getProvider();
    await provider.writeFile(agentId, 'context.json', JSON.stringify(messages));
  } catch (err) {
    console.error('[MessageRelay] Failed to save conversation context:', err);
  }
}
