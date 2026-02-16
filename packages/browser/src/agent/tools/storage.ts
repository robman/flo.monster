import type { ToolHandler, ToolResult, ToolContext } from '@flo-monster/core';
import { generateRequestId } from '@flo-monster/core';

export function createStorageTool(): ToolHandler {
  return {
    definition: {
      name: 'storage',
      description: 'Persistent key-value storage scoped to this agent. Supports get, set, delete, and list operations.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'set', 'delete', 'list'], description: 'Storage action' },
          key: { type: 'string', description: 'Storage key (required for get, set, delete)' },
          value: { type: 'string', description: 'Value to store (required for set)' },
        },
        required: ['action'],
      },
    },
    async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const id = generateRequestId('storage');

      ctx.sendToShell({
        type: 'storage_request',
        id,
        action: input.action as string,
        key: input.key as string | undefined,
        value: input.value as unknown,
      });

      try {
        const response = await ctx.waitForResponse(id) as {
          result?: unknown;
          keys?: string[];
          error?: string;
        };

        if (response.error) {
          return { content: `Storage error: ${response.error}`, is_error: true };
        }

        const action = input.action as string;
        if (action === 'list') {
          const keys = response.keys || [];
          return { content: keys.length > 0 ? `Keys: ${keys.join(', ')}` : 'No keys found' };
        }
        if (action === 'get') {
          return { content: response.result !== undefined ? String(response.result) : 'Key not found' };
        }
        if (action === 'set') {
          return { content: 'Value stored successfully' };
        }
        if (action === 'delete') {
          return { content: 'Key deleted successfully' };
        }

        return { content: JSON.stringify(response.result) };
      } catch (err) {
        return { content: `Storage timeout: ${String(err)}`, is_error: true };
      }
    },
  };
}
