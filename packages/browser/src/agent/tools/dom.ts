import type { ToolHandler, ToolResult, ToolContext } from '@flo-monster/core';
import { generateRequestId } from '@flo-monster/core';

export function createDomTool(): ToolHandler {
  return {
    definition: {
      name: 'dom',
      description: `Manipulate the DOM in the agent viewport. Supports:
- create: Insert HTML into the DOM
- modify: Change attributes or text content of elements
- query: Find and inspect elements
- remove: Delete elements from the DOM
- listen: Register event listeners that trigger new agent turns
- unlisten: Remove event listeners
- wait_for: Block until a specific event occurs (returns event data)
- get_listeners: List all registered event listeners`,
      input_schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'modify', 'query', 'remove', 'listen', 'unlisten', 'wait_for', 'get_listeners'],
            description: 'DOM action to perform',
          },
          html: { type: 'string', description: 'HTML string to create (for create action)' },
          selector: { type: 'string', description: 'CSS selector for targeting elements' },
          attributes: { type: 'object', description: 'Key-value attributes to set (for modify action)' },
          textContent: { type: 'string', description: 'Text content to set (for modify action)' },
          innerHTML: { type: 'string', description: 'Inner HTML to set (for modify action) - can include <script> tags that will execute' },
          parentSelector: { type: 'string', description: 'CSS selector for parent element (for create action)' },
          // Event listener options
          events: {
            type: 'array',
            items: { type: 'string' },
            description: 'Event types to listen for (for listen action), e.g. ["click", "input"]',
          },
          event: { type: 'string', description: 'Single event type to wait for (for wait_for action)' },
          timeout: { type: 'number', description: 'Timeout in milliseconds for wait_for action (default: 30000)' },
          options: {
            type: 'object',
            properties: {
              debounce: { type: 'number', description: 'Debounce delay in milliseconds for event handlers' },
            },
            description: 'Options for event listeners',
          },
        },
        required: ['action'],
      },
    },
    async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const id = generateRequestId('dom');
      const action = input.action as string;

      // Handle event listener actions with specialized messages
      if (action === 'listen') {
        ctx.sendToShell({
          type: 'dom_listen',
          id,
          selector: input.selector as string,
          events: input.events as string[] || [],
          options: input.options as { debounce?: number } | undefined,
        });

        try {
          const response = await ctx.waitForResponse(id) as { success: boolean; error?: string };
          if (!response.success) {
            return { content: `Listen error: ${response.error || 'Unknown error'}`, is_error: true };
          }
          const events = input.events as string[] || [];
          return { content: `Event listener registered for ${input.selector} on events: ${events.join(', ')}` };
        } catch (err) {
          return { content: `Listen command timeout: ${String(err)}`, is_error: true };
        }
      }

      if (action === 'unlisten') {
        ctx.sendToShell({
          type: 'dom_unlisten',
          id,
          selector: input.selector as string,
        });

        try {
          const response = await ctx.waitForResponse(id) as { success: boolean; error?: string };
          if (!response.success) {
            return { content: `Unlisten error: ${response.error || 'Unknown error'}`, is_error: true };
          }
          return { content: `Event listener removed for ${input.selector}` };
        } catch (err) {
          return { content: `Unlisten command timeout: ${String(err)}`, is_error: true };
        }
      }

      if (action === 'wait_for') {
        ctx.sendToShell({
          type: 'dom_wait',
          id,
          selector: input.selector as string,
          event: input.event as string,
          timeout: input.timeout as number | undefined,
        });

        try {
          const response = await ctx.waitForResponse(id) as {
            event?: { type: string; selector: string; target: { id?: string; value?: string }; formData?: Record<string, string> };
            error?: string;
          };
          if (response.error) {
            return { content: `Wait error: ${response.error}`, is_error: true };
          }
          if (response.event) {
            const e = response.event;
            let result = `Event received: ${e.type} on ${e.selector}`;
            if (e.target.id) result += ` (id: ${e.target.id})`;
            if (e.target.value !== undefined) result += ` [value: ${e.target.value}]`;
            if (e.formData) result += `\nForm data: ${JSON.stringify(e.formData)}`;
            return { content: result };
          }
          return { content: 'Event received' };
        } catch (err) {
          return { content: `Wait command timeout: ${String(err)}`, is_error: true };
        }
      }

      if (action === 'get_listeners') {
        ctx.sendToShell({
          type: 'dom_get_listeners',
          id,
        });

        try {
          const response = await ctx.waitForResponse(id) as {
            listeners: Array<{ selector: string; events: string[]; workerId: string }>;
          };
          if (!response.listeners || response.listeners.length === 0) {
            return { content: 'No event listeners registered' };
          }
          const lines = response.listeners.map(
            (l) => `- ${l.selector} (${l.events.join(', ')}) -> worker: ${l.workerId}`,
          );
          return { content: `Registered listeners:\n${lines.join('\n')}` };
        } catch (err) {
          return { content: `Get listeners command timeout: ${String(err)}`, is_error: true };
        }
      }

      // Standard DOM actions
      const command = {
        action,
        html: input.html as string | undefined,
        selector: input.selector as string | undefined,
        attributes: input.attributes as Record<string, string> | undefined,
        textContent: input.textContent as string | undefined,
        innerHTML: input.innerHTML as string | undefined,
        parentSelector: input.parentSelector as string | undefined,
      };

      ctx.sendToShell({ type: 'dom_command', id, command });

      try {
        const response = await ctx.waitForResponse(id) as { result: { description: string; elementCount: number; rendered?: { width: number; height: number; visible: boolean; display: string; childCount: number } }; error?: string };
        if (response.error) {
          return { content: `DOM error: ${response.error}`, is_error: true };
        }
        let content = `${response.result.description} (${response.result.elementCount} element(s))`;
        if (response.result.rendered) {
          const r = response.result.rendered;
          content += `\nRendered: ${r.width}x${r.height}`;
          content += r.visible ? ', visible' : ' [NOT VISIBLE]';
          content += `, display: ${r.display}`;
          content += `, ${r.childCount} children`;
        }
        return { content };
      } catch (err) {
        return { content: `DOM command timeout: ${String(err)}`, is_error: true };
      }
    },
  };
}
