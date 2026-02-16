/**
 * Hub-side context_search implementation.
 * Searches the agent's messageHistory directly (no file I/O).
 */

import {
  messageContains,
  mergeRanges,
  formatMessages,
  getMessagesByTurn,
} from '@flo-monster/core';
import type { ToolResult } from './index.js';

export const contextSearchToolDef = {
  name: 'context_search',
  description: 'Search conversation history or retrieve messages. Four modes: "search" finds messages matching a query with surrounding context, "tail" retrieves the last N messages, "head" retrieves the first N messages, "turn" retrieves all messages for a specific turn ID.',
  input_schema: {
    type: 'object' as const,
    properties: {
      mode: { type: 'string', enum: ['search', 'tail', 'head', 'turn'], description: 'Search mode' },
      query: { type: 'string', description: 'Search query (for search mode). Case-insensitive text matching across all message content.' },
      before: { type: 'number', description: 'Number of messages to include before each match (search mode, default: 2), or number of turns before (turn mode, default: 0)' },
      after: { type: 'number', description: 'Number of messages to include after each match (search mode, default: 2), or number of turns after (turn mode, default: 0)' },
      last: { type: 'number', description: 'Number of recent messages to retrieve (for tail mode, default: 10)' },
      first: { type: 'number', description: 'Number of messages from the start to retrieve (for head mode, default: 10)' },
      turnId: { type: 'string', description: 'Turn ID to retrieve (for turn mode, e.g. "t5")' },
    },
    required: ['mode'] as readonly string[],
  },
};

/**
 * Execute context_search on the hub agent's message history.
 */
export function executeHubContextSearch(
  input: Record<string, unknown>,
  messageHistory: Array<Record<string, unknown>>,
): ToolResult {
  const mode = input.mode as string;

  if (!Array.isArray(messageHistory) || messageHistory.length === 0) {
    return { content: 'No conversation history found.' };
  }

  if (mode === 'tail') {
    const last = (input.last as number) || 10;
    const tail = messageHistory.slice(-last);
    return { content: formatMessages(tail) };
  }

  if (mode === 'head') {
    const count = (input.first as number) || 10;
    const head = messageHistory.slice(0, count);
    return { content: formatMessages(head) };
  }

  if (mode === 'turn') {
    const turnId = input.turnId as string;
    if (!turnId) return { content: 'Error: turnId required for turn mode', is_error: true };

    const before = (input.before as number) ?? 0;
    const after = (input.after as number) ?? 0;

    const turnMessages = getMessagesByTurn(messageHistory, turnId, before, after);
    if (turnMessages.length === 0) {
      return { content: `No messages found for turn ${turnId}` };
    }
    return { content: formatMessages(turnMessages) };
  }

  if (mode === 'search') {
    const query = (input.query as string || '').toLowerCase();
    if (!query) return { content: 'Error: query required for search mode', is_error: true };

    const before = (input.before as number) ?? 2;
    const after = (input.after as number) ?? 2;

    const matchIndices: number[] = [];
    for (let i = 0; i < messageHistory.length; i++) {
      if (messageContains(messageHistory[i], query)) {
        matchIndices.push(i);
      }
    }

    if (matchIndices.length === 0) {
      return { content: 'No matches found.' };
    }

    const ranges = mergeRanges(matchIndices, before, after, messageHistory.length);
    const results: string[] = [];
    for (const [start, end] of ranges) {
      results.push(`--- messages ${start + 1}-${end + 1} of ${messageHistory.length} ---`);
      results.push(formatMessages(messageHistory.slice(start, end + 1)));
    }

    return { content: results.join('\n\n') };
  }

  return { content: 'Error: mode must be "search", "tail", "head", or "turn"', is_error: true };
}
