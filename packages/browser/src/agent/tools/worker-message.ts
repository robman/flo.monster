import type { ToolHandler, ToolResult, ToolContext } from '@flo-monster/core';

/**
 * Creates the worker_message tool for inter-worker communication.
 * Allows agents (workers) to send messages to other workers in the same iframe,
 * enabling coordination between parent agents and subagents.
 */
export function createWorkerMessageTool(): ToolHandler {
  return {
    definition: {
      name: 'worker_message',
      description: `Send a message to another worker in the same agent iframe.
Use this to coordinate between parent agents and subagents, or between sibling subagents.
The target worker will receive the message as a new turn with the event and data.`,
      input_schema: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'Target worker ID. Use "main" for the parent agent, a subworker ID for a specific subagent, or "broadcast" to send to all workers.',
          },
          event: {
            type: 'string',
            description: 'Event name/type for the message',
          },
          data: {
            type: 'object',
            description: 'Data payload to send with the message (any JSON-serializable value)',
          },
        },
        required: ['target', 'event'],
      },
    },
    async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const target = (input.target as string) || 'main';
      const event = input.event as string;
      const data = input.data;

      if (!event) {
        return { content: 'Event name is required', is_error: true };
      }

      ctx.sendToShell({
        type: 'worker_message',
        target,
        event,
        data,
      });

      if (target === 'broadcast') {
        return { content: `Message broadcast to all workers: ${event}` };
      }
      return { content: `Message sent to worker "${target}": ${event}` };
    },
  };
}
