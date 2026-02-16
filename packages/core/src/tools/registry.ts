import type { ToolDef, ToolHandler, ToolResult, ToolContext } from '../types/tools.js';

export class ToolRegistry {
  private handlers = new Map<string, ToolHandler>();

  register(handler: ToolHandler): void {
    this.handlers.set(handler.definition.name, handler);
  }

  get(name: string): ToolHandler | undefined {
    return this.handlers.get(name);
  }

  getDefinitions(): ToolDef[] {
    return Array.from(this.handlers.values()).map(h => h.definition);
  }

  async execute(name: string, input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const handler = this.handlers.get(name);
    if (!handler) {
      return { content: `Unknown tool: ${name}`, is_error: true };
    }
    try {
      return await handler.execute(input, context);
    } catch (err) {
      return { content: `Tool execution error: ${String(err)}`, is_error: true };
    }
  }
}
