import type { ToolDef, ToolResult, ToolPlugin, ShellToolContext } from '../types/tools.js';

export class ToolPluginRegistry {
  private plugins = new Map<string, ToolPlugin>();

  register(plugin: ToolPlugin): void {
    if (this.plugins.has(plugin.definition.name)) {
      throw new Error(`Tool plugin already registered: ${plugin.definition.name}`);
    }
    this.plugins.set(plugin.definition.name, plugin);
  }

  unregister(name: string): void {
    this.plugins.delete(name);
  }

  get(name: string): ToolPlugin | undefined {
    return this.plugins.get(name);
  }

  getAll(): ToolPlugin[] {
    return Array.from(this.plugins.values());
  }

  getDefinitions(): ToolDef[] {
    return Array.from(this.plugins.values()).map(p => p.definition);
  }

  has(name: string): boolean {
    return this.plugins.has(name);
  }

  /**
   * Get the extension ID for a tool (if it belongs to an extension)
   */
  getExtensionId(name: string): string | undefined {
    return this.plugins.get(name)?.extensionId;
  }

  async execute(name: string, input: Record<string, unknown>, context: ShellToolContext): Promise<ToolResult> {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      return { content: `Unknown plugin tool: ${name}`, is_error: true };
    }
    try {
      return await plugin.execute(input, context);
    } catch (err) {
      return { content: `Plugin tool error: ${String(err)}`, is_error: true };
    }
  }
}
