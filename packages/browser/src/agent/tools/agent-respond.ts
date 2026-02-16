import type { ToolHandler, ToolResult, ToolContext } from '@flo-monster/core';

/**
 * Creates the agent_respond tool for responding to flo.ask() calls from iframe JavaScript.
 * When JS in the agent's iframe calls `flo.ask(event, data)`, it creates a request
 * that the agent can respond to using this tool.
 */
export function createAgentRespondTool(): ToolHandler {
  return {
    definition: {
      name: 'agent_respond',
      description: `Respond to a flo.ask() request from JavaScript in the agent's iframe.
When JS in the iframe calls flo.ask(event, data), the agent receives the request and should
respond using this tool. The response will be delivered as a resolved Promise to the JS caller.`,
      input_schema: {
        type: 'object',
        properties: {
          result: {
            type: 'object',
            description: 'The result to send back to the JS caller. Can be any JSON-serializable value.',
          },
          error: {
            type: 'string',
            description: 'Optional error message. If provided, the JS Promise will be rejected with this error.',
          },
        },
      },
    },
    async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      // The actual response is handled in worker-bundle.js which tracks pendingAskId
      // This tool just sends the agent_ask_response message
      ctx.sendToShell({
        type: 'agent_ask_response',
        id: '', // Will be filled by the worker from pendingAskId
        result: input.result,
        error: input.error as string | undefined,
      });

      if (input.error) {
        return { content: `Error response sent: ${input.error}` };
      }
      return { content: 'Response sent to caller' };
    },
  };
}
