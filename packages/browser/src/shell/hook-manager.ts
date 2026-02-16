import type {
  HookType,
  HookRegistration,
  HookInput,
  HookResult,
  HooksConfig,
  HookRulesConfig,
  HookRuleConfig,
} from '@flo-monster/core';
import type { HubClient } from './hub-client.js';
import type { MessageRelay } from './message-relay.js';

// Map between declarative config event names and HookType
const CONFIG_TO_HOOK_TYPE: Record<string, HookType> = {
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
  Stop: 'stop',
  UserPromptSubmit: 'user_prompt_submit',
  AgentStart: 'agent_start',
  AgentEnd: 'agent_end',
};

// Hub tools that should be routed through hubClient
const HUB_TOOLS = ['bash', 'read_file', 'write_file', 'list_directory'];

export class HookManager {
  private hooks = new Map<string, HookRegistration>();
  private configHookIds = new Set<string>();  // Track hooks registered from config
  private _configRules: HookRulesConfig = {};
  private hubClient: HubClient | null = null;
  private messageRelay: MessageRelay | null = null;

  setHubClient(client: HubClient | null): void {
    this.hubClient = client;
  }

  setMessageRelay(relay: MessageRelay | null): void {
    this.messageRelay = relay;
  }

  register(hook: HookRegistration): () => void {
    this.hooks.set(hook.id, hook);
    return () => this.unregister(hook.id);
  }

  unregister(id: string): void {
    this.hooks.delete(id);
    this.configHookIds.delete(id);
  }

  getActiveHookTypes(): HookType[] {
    const types = new Set<HookType>();
    for (const hook of this.hooks.values()) {
      types.add(hook.type);
    }
    return Array.from(types);
  }

  getHooksConfig(): HooksConfig {
    return {
      activeHookTypes: this.getActiveHookTypes(),
    };
  }

  async evaluate(input: HookInput): Promise<HookResult> {
    // Get matching hooks
    const matching = this.getMatchingHooks(input);

    if (matching.length === 0) {
      return { decision: 'default' };
    }

    // Sort by priority (higher first)
    matching.sort((a, b) => (b.priority || 0) - (a.priority || 0));

    let hasAllow = false;

    for (const hook of matching) {
      try {
        const result = await hook.callback(input);
        if (result.decision === 'deny') {
          // Deny wins immediately
          return result;
        }
        if (result.decision === 'allow') {
          hasAllow = true;
          // If pre_tool_use and has modifiedInput, carry it forward
          if (result.modifiedInput) {
            return result;
          }
        }
      } catch (err) {
        // Hook errors should not block execution
        console.error(`[HookManager] Hook ${hook.id} error:`, err);
      }
    }

    if (hasAllow) {
      return { decision: 'allow' };
    }

    return { decision: 'default' };
  }

  clear(): void {
    this.hooks.clear();
    this.configHookIds.clear();
    this._configRules = {};
  }

  /**
   * Export the stored declarative config rules (for session persistence).
   */
  exportConfigRules(): HookRulesConfig {
    return this._configRules;
  }

  /**
   * Register hooks from declarative config rules.
   * Clears any previously registered config hooks before applying new rules.
   * @returns Array of registered hook IDs
   */
  registerFromConfig(rules: HookRulesConfig): string[] {
    const registeredIds: string[] = [];

    // Store a deep copy of the rules for later export (session persistence)
    this._configRules = JSON.parse(JSON.stringify(rules));

    // Clear previously registered config hooks
    for (const id of this.configHookIds) {
      this.hooks.delete(id);
    }
    this.configHookIds.clear();

    // Process each event type
    for (const [configType, ruleList] of Object.entries(rules)) {
      const hookType = CONFIG_TO_HOOK_TYPE[configType];
      if (!hookType || !ruleList) continue;

      for (let i = 0; i < ruleList.length; i++) {
        const rule = ruleList[i] as HookRuleConfig;
        const id = `config-${configType}-${i}`;

        const registration: HookRegistration = {
          id,
          type: hookType,
          priority: rule.priority ?? 0,
          callback: async (input: HookInput): Promise<HookResult> => {
            // Check inputMatchers for tool-related hooks
            if (rule.inputMatchers && (hookType === 'pre_tool_use' || hookType === 'post_tool_use')) {
              if ('toolInput' in input && input.toolInput) {
                for (const [fieldName, pattern] of Object.entries(rule.inputMatchers)) {
                  const value = input.toolInput[fieldName];
                  if (typeof value === 'string') {
                    const regex = new RegExp(pattern);
                    if (!regex.test(value)) {
                      return { decision: 'default' };
                    }
                  } else {
                    // Value doesn't exist or isn't a string - matcher doesn't apply
                    return { decision: 'default' };
                  }
                }
              }
            }

            // Process hooks in order - first deny/allow wins
            for (const hook of rule.hooks) {
              if (hook.action === 'log') {
                console.log(`[Hook:${configType}]`, input);
                continue;
              }
              if (hook.action === 'deny') {
                return { decision: 'deny', reason: hook.reason };
              }
              if (hook.action === 'allow') {
                return { decision: 'allow', reason: hook.reason };
              }
              if (hook.action === 'script' && hook.script) {
                try {
                  const scriptResult = await this.executeScript(hook.script, input, configType);

                  // If script returns a decision object, use it
                  if (scriptResult && typeof scriptResult === 'object' && 'decision' in scriptResult) {
                    const resultObj = scriptResult as { decision: unknown; reason?: unknown };
                    const decision = resultObj.decision;
                    if (decision === 'deny' || decision === 'allow') {
                      return {
                        decision,
                        reason: typeof resultObj.reason === 'string' ? resultObj.reason : undefined,
                      };
                    }
                  }
                } catch (err) {
                  console.error(`[Hook:${configType}] Script execution error:`, err);
                  if (hook.continueOnError === false) {
                    return { decision: 'deny', reason: `Hook script error: ${String(err)}` };
                  }
                }
                continue;
              }
            }
            return { decision: 'default' };
          },
        };

        // Add matcher for tool-related hooks
        if (rule.matcher && (hookType === 'pre_tool_use' || hookType === 'post_tool_use')) {
          registration.matcher = { toolNamePattern: rule.matcher };
        }

        this.hooks.set(id, registration);
        this.configHookIds.add(id);
        registeredIds.push(id);
      }
    }

    return registeredIds;
  }

  /**
   * Get count of hooks registered from config (useful for testing)
   */
  getConfigHookCount(): number {
    return this.configHookIds.size;
  }

  /**
   * Execute a hook script with the given context.
   * Scripts are routed to the agent's sandboxed context if messageRelay is available,
   * otherwise fall back to local execution (shell context).
   */
  private async executeScript(
    script: string,
    input: HookInput,
    configType: string,
  ): Promise<unknown> {
    // Build context object with hook data
    const context: Record<string, unknown> = {
      type: input.type,
      agentId: input.agentId,
    };

    // Add type-specific fields
    if ('toolName' in input) {
      context.toolName = input.toolName;
    }
    if ('toolInput' in input) {
      context.toolInput = input.toolInput;
    }
    if ('toolResult' in input) {
      context.toolResult = input.toolResult;
    }
    if ('prompt' in input) {
      context.prompt = input.prompt;
    }
    if ('stopReason' in input) {
      context.stopReason = input.stopReason;
    }

    // Route script execution to agent's sandboxed context if available
    if (this.messageRelay) {
      const result = await this.messageRelay.executeScriptInAgent(
        input.agentId,
        script,
        context,
      );
      if (result.error) {
        throw new Error(result.error);
      }
      return result.result;
    }

    // Fallback to local execution if no relay (shouldn't happen in production)
    console.warn(`[Hook:${configType}] No message relay available, executing script in shell context`);

    // Create callTool function that routes to appropriate handler
    const callTool = async (
      name: string,
      toolInput: Record<string, unknown>,
    ): Promise<{ content: string; is_error?: boolean }> => {
      // Route hub tools through hubClient
      if (HUB_TOOLS.includes(name)) {
        if (!this.hubClient) {
          return { content: `Hub not connected (required for ${name})`, is_error: true };
        }
        const hubId = this.hubClient.findToolHub(name);
        if (!hubId) {
          return { content: `No hub with ${name} tool found`, is_error: true };
        }
        const result = await this.hubClient.executeTool(hubId, name, toolInput);
        return { content: result.result, is_error: result.is_error };
      }

      // No relay available, can't route browser tools
      return { content: 'Message relay not available for browser tools', is_error: true };
    };

    // Create log function
    const log = (...args: unknown[]): void => {
      console.log(`[Hook:${configType}:script]`, ...args);
    };

    // Add APIs to context
    context.callTool = callTool;
    context.log = log;

    // Build parameter names and values
    const contextKeys = Object.keys(context);
    const contextValues = contextKeys.map((k) => context[k]);

    // Create and execute async function
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction(...contextKeys, script);
    return fn(...contextValues);
  }

  private getMatchingHooks(input: HookInput): HookRegistration[] {
    const matching: HookRegistration[] = [];

    for (const hook of this.hooks.values()) {
      if (hook.type !== input.type) continue;

      // Check matcher
      if (hook.matcher?.toolNamePattern) {
        // Only applies to tool-related hooks
        if ('toolName' in input) {
          const regex = new RegExp(hook.matcher.toolNamePattern);
          if (!regex.test(input.toolName)) continue;
        }
      }

      matching.push(hook);
    }

    return matching;
  }
}
