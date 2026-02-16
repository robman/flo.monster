import type { HookRulesConfig, HookRuleConfig, HookActionConfig } from '@flo-monster/core';

export interface DeclarativeHookResult {
  decision: 'allow' | 'deny' | 'default';
  reason?: string;
}

/**
 * Evaluates declarative hook rules on the hub side.
 * Only supports declarative actions (deny, allow, log). Script hooks are skipped
 * since there is no sandboxed agent context on the hub to execute them safely.
 */
export class DeclarativeHookEvaluator {
  private config: HookRulesConfig;

  constructor(config: HookRulesConfig) {
    this.config = config;
  }

  evaluatePreToolUse(toolName: string, toolInput: Record<string, unknown>): DeclarativeHookResult {
    const rules = this.config.PreToolUse;
    if (!rules) return { decision: 'default' };

    return this.evaluateRules(rules, toolName, toolInput);
  }

  evaluatePostToolUse(toolName: string, toolInput: Record<string, unknown>): void {
    const rules = this.config.PostToolUse;
    if (!rules) return;

    // Post-tool-use just runs logging, no decision needed
    for (const rule of rules) {
      if (!this.matchesRule(rule, toolName, toolInput)) continue;
      for (const hook of rule.hooks) {
        if (hook.action === 'log') {
          console.log(`[hub:hook:PostToolUse] ${toolName}`, toolInput);
        }
      }
    }
  }

  getConfig(): HookRulesConfig {
    return this.config;
  }

  private evaluateRules(rules: HookRuleConfig[], toolName: string, toolInput: Record<string, unknown>): DeclarativeHookResult {
    for (const rule of rules) {
      if (!this.matchesRule(rule, toolName, toolInput)) continue;

      for (const hook of rule.hooks) {
        const result = this.evaluateAction(hook, toolName);
        if (result) return result;
      }
    }
    return { decision: 'default' };
  }

  private matchesRule(rule: HookRuleConfig, toolName: string, toolInput: Record<string, unknown>): boolean {
    // Check tool name matcher
    if (rule.matcher) {
      const regex = new RegExp(rule.matcher);
      if (!regex.test(toolName)) return false;
    }

    // Check input matchers
    if (rule.inputMatchers) {
      for (const [fieldName, pattern] of Object.entries(rule.inputMatchers)) {
        const value = toolInput[fieldName];
        if (typeof value !== 'string') return false;
        const regex = new RegExp(pattern);
        if (!regex.test(value)) return false;
      }
    }

    return true;
  }

  private evaluateAction(hook: HookActionConfig, toolName: string): DeclarativeHookResult | null {
    switch (hook.action) {
      case 'deny':
        return { decision: 'deny', reason: hook.reason };
      case 'allow':
        return { decision: 'allow', reason: hook.reason };
      case 'log':
        console.log(`[hub:hook:PreToolUse] ${toolName}`);
        return null; // Continue to next hook
      case 'script':
        console.warn('[hub] Script hooks not supported on hub, skipping');
        return null; // Continue to next hook
      default:
        return null;
    }
  }
}
