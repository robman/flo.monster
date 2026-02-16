import type { ToolHandler, ToolResult, ToolContext } from '@flo-monster/core';
import { generateRequestId } from '@flo-monster/core';

export function createRunJsTool(): ToolHandler {
  return {
    definition: {
      name: 'runjs',
      description: 'Execute JavaScript code. Returns the result of the last expression and any console output.',
      input_schema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'JavaScript code to execute' },
          context: {
            type: 'string',
            enum: ['worker', 'iframe'],
            description: 'Execution context. "worker" (default) runs in isolated worker, "iframe" runs in the DOM iframe.'
          },
        },
        required: ['code'],
      },
    },
    async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const code = input.code as string;
      const execContext = (input.context as string) || 'worker';

      if (execContext === 'iframe') {
        // Delegate to iframe via postMessage
        const id = generateRequestId('runjs');
        ctx.sendToShell({ type: 'runjs_iframe', id, code });

        try {
          const response = await ctx.waitForResponse(id) as { result?: string; error?: string };
          if (response.error) {
            return { content: `Error: ${response.error}`, is_error: true };
          }
          return { content: String(response.result ?? 'undefined') };
        } catch (err) {
          return { content: `RunJS iframe timeout: ${String(err)}`, is_error: true };
        }
      }

      // Worker context: execute locally via Function constructor
      const consoleOutput: string[] = [];
      const mockConsole = {
        log: (...args: unknown[]) => consoleOutput.push(args.map(String).join(' ')),
        error: (...args: unknown[]) => consoleOutput.push('[error] ' + args.map(String).join(' ')),
        warn: (...args: unknown[]) => consoleOutput.push('[warn] ' + args.map(String).join(' ')),
      };

      try {
        const fn = new Function('console', `'use strict';\n${code}`);
        const result = fn(mockConsole);
        const parts: string[] = [];
        if (consoleOutput.length > 0) {
          parts.push('Console:\n' + consoleOutput.join('\n'));
        }
        parts.push('Result: ' + (result !== undefined ? String(result) : 'undefined'));
        return { content: parts.join('\n\n') };
      } catch (err) {
        return { content: `Error: ${(err as Error).message}`, is_error: true };
      }
    },
  };
}
