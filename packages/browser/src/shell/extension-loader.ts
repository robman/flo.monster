import type { Extension, ExtensionManifest, ExtensionDependency, ExtensionContext, ToolPlugin } from '@flo-monster/core';
import type { ToolDef } from '@flo-monster/core';
import { ToolPluginRegistry } from '@flo-monster/core';
import type { ExtensionConfigStore } from './extension-config-store.js';

export class ExtensionLoader {
  private loaded = new Map<string, Extension>();
  private pluginRegistry: ToolPluginRegistry;
  private agentExtensionUsage = new Map<string, Set<string>>();  // agentId -> Set<extension ids>
  private configStore: ExtensionConfigStore | null = null;

  constructor(pluginRegistry: ToolPluginRegistry) {
    this.pluginRegistry = pluginRegistry;
  }

  /**
   * Set the config store for extension configuration
   */
  setConfigStore(configStore: ExtensionConfigStore): void {
    this.configStore = configStore;
  }

  /**
   * Get the extension context for a given extension
   */
  async getExtensionContext(extensionId: string): Promise<ExtensionContext> {
    const config = this.configStore
      ? await this.configStore.getFullConfig(extensionId)
      : {};

    const logs: string[] = [];

    return {
      config,
      log: (...args: unknown[]) => {
        const message = args.map(a => String(a)).join(' ');
        logs.push(message);
        console.log(`[extension:${extensionId}]`, ...args);
      },
      fetch: globalThis.fetch.bind(globalThis),
    };
  }

  /**
   * Get the extension ID for a tool (if it belongs to an extension)
   */
  getToolExtensionId(toolName: string): string | undefined {
    for (const ext of this.loaded.values()) {
      if (ext.tools?.some(t => t.definition.name === toolName)) {
        return ext.id;
      }
    }
    return undefined;
  }

  loadBuiltin(extension: Extension): void {
    if (this.loaded.has(extension.id)) {
      throw new Error(`Extension already loaded: ${extension.id}`);
    }
    // Register tools with the plugin registry (with extension ID)
    if (extension.tools) {
      for (const tool of extension.tools) {
        const toolWithExtId: ToolPlugin = {
          ...tool,
          extensionId: extension.id,
        };
        this.pluginRegistry.register(toolWithExtId);
      }
    }
    this.loaded.set(extension.id, extension);
  }

  async loadFromUrl(manifest: ExtensionManifest): Promise<Extension> {
    if (this.loaded.has(manifest.id)) {
      throw new Error(`Extension already loaded: ${manifest.id}`);
    }
    if (!manifest.entryUrl) {
      throw new Error(`Extension manifest missing entryUrl: ${manifest.id}`);
    }

    // Validate URL scheme
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(manifest.entryUrl);
    } catch {
      throw new Error(`Invalid extension URL: ${manifest.entryUrl}`);
    }
    const isLocalhost = parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '127.0.0.1';
    if (parsedUrl.protocol !== 'https:' && !(parsedUrl.protocol === 'http:' && isLocalhost)) {
      throw new Error(`Extension URL must use HTTPS (got ${parsedUrl.protocol}). HTTP is only allowed for localhost.`);
    }

    try {
      const module = await import(/* @vite-ignore */ manifest.entryUrl);
      const extension: Extension = module.default;

      if (!extension || !extension.id || !extension.name || !extension.version) {
        throw new Error('Invalid extension module: must export default an Extension object');
      }

      // Register tools (with extension ID)
      if (extension.tools) {
        for (const tool of extension.tools) {
          const toolWithExtId: ToolPlugin = {
            ...tool,
            extensionId: extension.id,
          };
          this.pluginRegistry.register(toolWithExtId);
        }
      }

      this.loaded.set(extension.id, extension);
      return extension;
    } catch (err) {
      throw new Error(`Failed to load extension from ${manifest.entryUrl}: ${String(err)}`);
    }
  }

  unload(extensionId: string): void {
    const ext = this.loaded.get(extensionId);
    if (!ext) return;

    // Unregister tools from plugin registry
    if (ext.tools) {
      for (const tool of ext.tools) {
        this.pluginRegistry.unregister(tool.definition.name);
      }
    }

    this.loaded.delete(extensionId);
  }

  getLoaded(): Extension[] {
    return Array.from(this.loaded.values());
  }

  getExtension(id: string): Extension | undefined {
    return this.loaded.get(id);
  }

  isLoaded(id: string): boolean {
    return this.loaded.has(id);
  }

  getToolDefinitions(): ToolDef[] {
    const defs: ToolDef[] = [];
    for (const ext of this.loaded.values()) {
      if (ext.tools) {
        for (const tool of ext.tools) {
          defs.push(tool.definition);
        }
      }
    }
    return defs;
  }

  getSystemPromptAdditions(): string {
    const additions: string[] = [];
    const MAX_ADDITION_LENGTH = 10000; // 10KB per extension
    const MAX_TOTAL_LENGTH = 50000;   // 50KB total

    for (const ext of this.loaded.values()) {
      if (ext.systemPromptAddition) {
        // Sanitize: limit length and strip control characters (except newlines/tabs)
        let sanitized = ext.systemPromptAddition
          .substring(0, MAX_ADDITION_LENGTH)
          .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ''); // Strip control chars except \t\n\r

        additions.push(sanitized);
      }
    }

    const result = additions.join('\n\n');
    return result.substring(0, MAX_TOTAL_LENGTH);
  }

  /**
   * Track extension usage for an agent
   */
  trackAgentExtensionUsage(agentId: string, extensionId: string): void {
    const usedExts = this.agentExtensionUsage.get(agentId) || new Set<string>();
    usedExts.add(extensionId);
    this.agentExtensionUsage.set(agentId, usedExts);
  }

  /**
   * Get extension dependencies for an agent (for serialization)
   */
  getAgentExtensionDependencies(agentId: string): ExtensionDependency[] {
    const usedExtIds = this.agentExtensionUsage.get(agentId);
    if (!usedExtIds) return [];

    const deps: ExtensionDependency[] = [];
    for (const id of usedExtIds) {
      const ext = this.loaded.get(id);
      if (ext) {
        deps.push({
          id: ext.id,
          source: { type: 'builtin' },  // Default to builtin, could be enhanced
          inline: {
            manifest: {
              id: ext.id,
              name: ext.name,
              version: ext.version,
            },
            systemPromptAddition: ext.systemPromptAddition,
          },
        });
      }
    }
    return deps;
  }

  /**
   * Clear extension usage tracking for an agent
   */
  clearAgentExtensionUsage(agentId: string): void {
    this.agentExtensionUsage.delete(agentId);
  }
}
