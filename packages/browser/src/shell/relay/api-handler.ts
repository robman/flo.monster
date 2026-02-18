import type { IframeToShell, ShellToIframe } from '@flo-monster/core';
import { buildContextMessages } from '@flo-monster/core';
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

    // The request's messages/contents are the current turn — tag with turnId.
    const rawTurnItems = (isGeminiNative ? payload.contents : payload.messages) || [];
    // Keep original format for the current request
    const turnMessages = rawTurnItems.map((m: Record<string, unknown>) => ({ ...m, turnId }));
    // For storage: normalize Gemini messages to canonical format (role: assistant/user, content blocks)
    // so context works when switching providers. Also filter out system messages — the worker
    // injects the system prompt on every request, so storing it duplicates it each turn.
    const turnMessagesForStorage = (isGeminiNative
      ? rawTurnItems.map((m: Record<string, unknown>) => ({ ...normalizeGeminiMessage(m), turnId }))
      : turnMessages
    ).filter((m: Record<string, unknown>) => m.role !== 'system');

    // Build context messages using the unified strategy
    const contextMessages = buildContextMessages(
      terseEntries,
      storedMessages as Array<Record<string, unknown>>,
      { contextMode, maxTerseEntries: 50, fullContextTurns },
    );

    if (isGeminiNative) {
      // Gemini native: context messages are in internal format (role/content blocks).
      // Convert them to Gemini contents format before prepending.
      const contextContents = contextMessages.map((m: Record<string, unknown>) => {
        const role = m.role === 'assistant' ? 'model' : 'user';
        const content = m.content as Array<Record<string, unknown>> | undefined;
        const parts: Array<Record<string, unknown>> = [];
        if (content) {
          for (const block of content) {
            if (block.type === 'text') {
              parts.push({ text: block.text });
            }
            // Tool use/result blocks in context are best represented as text summaries
            // since we don't have the full functionCall/Response metadata.
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
      // Strip turnId from contents
      payload.contents = allContents.map(
        ({ turnId: _tid, ...rest }: Record<string, unknown>) => rest,
      );
    } else {
      // OpenAI/Anthropic: inject context into messages array
      payload.messages = [...contextMessages, ...turnMessages].map(
        ({ turnId: _tid, ...rest }: Record<string, unknown>) => rest,
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
  return { role, content };
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
