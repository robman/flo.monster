import type { ToolHandler, ToolResult, ToolContext } from '@flo-monster/core';
import { generateRequestId } from '@flo-monster/core';

export function createStateTool(): ToolHandler {
  return {
    definition: {
      name: 'state',
      description: 'Reactive state management. Read/write persistent state visible to page JavaScript via flo.state, and manage escalation rules that wake the agent when conditions are met.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'get_all', 'set', 'delete', 'escalation_rules', 'escalate', 'clear_escalation'], description: 'State action to perform' },
          key: { type: 'string', description: 'State key (required for get, set, delete, escalate, clear_escalation)' },
          value: { type: 'object', description: 'Value to set (any JSON type, required for set)' },
          condition: { type: 'string', description: 'JS expression for escalation condition. Use "always" to escalate on every change, or a JS expression like "val > 100" where val is the new value.' },
          message: { type: 'string', description: 'Context message included when escalation fires, so you remember why you set this rule' },
        },
        required: ['action'],
      },
    },
    async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const id = generateRequestId('state');

      ctx.sendToShell({
        type: 'state_request',
        id,
        action: input.action as string,
        key: input.key as string | undefined,
        value: input.value as unknown,
        condition: input.condition as string | undefined,
        message: input.message as string | undefined,
      });

      try {
        const response = await ctx.waitForResponse(id) as {
          result?: unknown;
          error?: string;
        };

        if (response.error) {
          return { content: `State error: ${response.error}`, is_error: true };
        }

        const action = input.action as string;
        if (action === 'get') {
          return { content: response.result !== undefined ? JSON.stringify(response.result) : 'Key not found' };
        }
        if (action === 'get_all') {
          return { content: JSON.stringify(response.result) };
        }
        if (action === 'set') {
          return { content: 'State updated' };
        }
        if (action === 'delete') {
          return { content: 'State key deleted' };
        }
        if (action === 'escalation_rules') {
          return { content: JSON.stringify(response.result) };
        }
        if (action === 'escalate') {
          return { content: 'Escalation rule set' };
        }
        if (action === 'clear_escalation') {
          return { content: 'Escalation rule cleared' };
        }

        return { content: JSON.stringify(response.result) };
      } catch (err) {
        return { content: `State timeout: ${String(err)}`, is_error: true };
      }
    },
  };
}
