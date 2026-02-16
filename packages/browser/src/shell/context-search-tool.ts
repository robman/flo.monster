import type { ToolPlugin, ToolResult, ShellToolContext } from '@flo-monster/core';
import { messageContains, mergeRanges, formatMessages, getMessagesByTurn } from '@flo-monster/core';
import type { AgentStorageProvider } from '../storage/agent-storage.js';

// Re-export shared helpers for backwards compatibility
export { messageContains, mergeRanges, formatMessages };

interface ContextSearchDeps {
  getProvider: () => Promise<AgentStorageProvider>;
}

export function createContextSearchPlugin(deps: ContextSearchDeps): ToolPlugin {
  return {
    definition: {
      name: 'context_search',
      description: 'Search conversation history or retrieve messages. Four modes: "search" finds messages matching a query with surrounding context, "tail" retrieves the last N messages, "head" retrieves the first N messages, "turn" retrieves all messages for a specific turn ID.',
      input_schema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['search', 'tail', 'head', 'turn'], description: 'Search mode' },
          query: { type: 'string', description: 'Search query (for search mode). Case-insensitive text matching across all message content.' },
          before: { type: 'number', description: 'Number of messages to include before each match (search mode, default: 2), or number of turns before (turn mode, default: 0)' },
          after: { type: 'number', description: 'Number of messages to include after each match (search mode, default: 2), or number of turns after (turn mode, default: 0)' },
          last: { type: 'number', description: 'Number of recent messages to retrieve (for tail mode, default: 10)' },
          first: { type: 'number', description: 'Number of messages from the start to retrieve (for head mode, default: 10)' },
          turnId: { type: 'string', description: 'Turn ID to retrieve (for turn mode, e.g. "t5")' },
        },
        required: ['mode'],
      },
    },

    async execute(input: Record<string, unknown>, context: ShellToolContext): Promise<ToolResult> {
      const mode = input.mode as string;
      const agentId = context.agentId;

      // Load full history from context.json
      let messages: unknown[];
      try {
        const provider = await deps.getProvider();
        const content = await provider.readFile(agentId, 'context.json');
        messages = JSON.parse(content);
      } catch {
        return { content: 'No conversation history found.' };
      }

      if (!Array.isArray(messages) || messages.length === 0) {
        return { content: 'No conversation history found.' };
      }

      if (mode === 'tail') {
        const last = (input.last as number) || 10;
        const tail = messages.slice(-last);
        return { content: formatMessages(tail) };
      }

      if (mode === 'head') {
        const count = (input.first as number) || 10;
        const head = messages.slice(0, count);
        return { content: formatMessages(head) };
      }

      if (mode === 'turn') {
        const turnId = input.turnId as string;
        if (!turnId) return { content: 'Error: turnId required for turn mode', is_error: true };

        const before = (input.before as number) ?? 0;
        const after = (input.after as number) ?? 0;

        const turnMessages = getMessagesByTurn(messages as Array<Record<string, unknown>>, turnId, before, after);
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

        // Find matching message indices
        const matchIndices: number[] = [];
        for (let i = 0; i < messages.length; i++) {
          if (messageContains(messages[i], query)) {
            matchIndices.push(i);
          }
        }

        if (matchIndices.length === 0) {
          return { content: 'No matches found.' };
        }

        // Expand to include context (merge overlapping ranges)
        const ranges = mergeRanges(matchIndices, before, after, messages.length);
        const results: string[] = [];
        for (const [start, end] of ranges) {
          results.push(`--- messages ${start + 1}-${end + 1} of ${messages.length} ---`);
          results.push(formatMessages(messages.slice(start, end + 1)));
        }

        return { content: results.join('\n\n') };
      }

      return { content: 'Error: mode must be "search", "tail", "head", or "turn"', is_error: true };
    },
  };
}
