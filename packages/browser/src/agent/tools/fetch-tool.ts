import type { ToolHandler, ToolResult, ToolContext } from '@flo-monster/core';
import { generateRequestId } from '@flo-monster/core';

export function createFetchTool(): ToolHandler {
  return {
    definition: {
      name: 'fetch',
      description: 'Make HTTP requests. Requests are subject to the agent network policy.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
          method: { type: 'string', description: 'HTTP method (default: GET)' },
          headers: { type: 'object', description: 'Request headers' },
          body: { type: 'string', description: 'Request body' },
        },
        required: ['url'],
      },
    },
    async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const id = generateRequestId('fetch');

      ctx.sendToShell({
        type: 'fetch_request',
        id,
        url: input.url as string,
        options: {
          method: (input.method as string) || 'GET',
          headers: input.headers as Record<string, string> | undefined,
          body: input.body as string | undefined,
        },
      });

      try {
        const response = await ctx.waitForResponse(id) as {
          type: 'fetch_response' | 'fetch_error';
          status?: number;
          headers?: Record<string, string>;
          body?: string;
          error?: string;
        };

        if (response.type === 'fetch_error' || response.error) {
          return { content: `Fetch error: ${response.error}`, is_error: true };
        }

        const parts = [`Status: ${response.status}`];
        if (response.headers && Object.keys(response.headers).length > 0) {
          parts.push('Headers: ' + JSON.stringify(response.headers));
        }
        if (response.body) {
          parts.push('Body:\n' + response.body);
        }
        return { content: parts.join('\n') };
      } catch (err) {
        return { content: `Fetch timeout: ${String(err)}`, is_error: true };
      }
    },
  };
}
