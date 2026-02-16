/**
 * Hub-side hook executor
 * Executes shell commands defined in hook rules before/after tool execution.
 */

import type { HubHooksConfig, HubHookRule } from '@flo-monster/core';
import { executeProcess, type ProcessResult } from './utils/process-utils.js';

export interface HookExecutorContext {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult?: { content: string; is_error?: boolean };
  sandboxPath: string;
}

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface HookExecutionResult {
  blocked: boolean; // true if PreToolUse hook blocked execution
  blockReason?: string; // reason if blocked
  commandResults: CommandResult[];
}

const DEFAULT_TIMEOUT = 5000;

/**
 * Check if a rule's matchers match the given context
 */
export function matchesRule(rule: HubHookRule, context: HookExecutorContext): boolean {
  // Check tool name matcher (if specified)
  if (rule.matcher) {
    try {
      const regex = new RegExp(rule.matcher);
      if (!regex.test(context.toolName)) {
        return false;
      }
    } catch {
      // Invalid regex - skip this rule
      console.warn(`Invalid matcher regex: ${rule.matcher}`);
      return false;
    }
  }

  // Check input matchers (all must pass)
  if (rule.inputMatchers) {
    for (const [fieldName, pattern] of Object.entries(rule.inputMatchers)) {
      const inputValue = context.toolInput[fieldName];
      if (inputValue === undefined) {
        // Field not present - doesn't match
        return false;
      }

      try {
        const regex = new RegExp(pattern);
        const valueString = String(inputValue);
        if (!regex.test(valueString)) {
          return false;
        }
      } catch {
        // Invalid regex - skip this matcher
        console.warn(`Invalid inputMatcher regex for ${fieldName}: ${pattern}`);
        return false;
      }
    }
  }

  return true;
}

/**
 * Shell-escape a string value by wrapping in single quotes.
 * Single quotes within the value are escaped as: '\''
 * This is the standard POSIX shell escaping technique.
 */
export function shellEscape(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Render template placeholders in a command string.
 * All interpolated values are shell-escaped to prevent injection.
 */
export function renderTemplate(command: string, context: HookExecutorContext): string {
  let result = command;

  // Replace {{sandbox}} with sandbox path (shell-escaped)
  result = result.replace(/\{\{sandbox\}\}/g, shellEscape(context.sandboxPath));

  // Replace {{result}} with tool result content (shell-escaped)
  if (context.toolResult) {
    result = result.replace(/\{\{result\}\}/g, shellEscape(context.toolResult.content));
  } else {
    // Remove {{result}} placeholders if no result available
    result = result.replace(/\{\{result\}\}/g, "''");
  }

  // Replace {{fieldName}} with corresponding input values (shell-escaped)
  result = result.replace(/\{\{(\w+)\}\}/g, (match, fieldName) => {
    const value = context.toolInput[fieldName];
    if (value === undefined) {
      return "''";
    }
    // Convert non-string values to string, then escape
    const strValue = typeof value === 'string' ? value : JSON.stringify(value);
    return shellEscape(strValue);
  });

  return result;
}

/**
 * Execute a single command with timeout.
 * Wraps the shared executeProcess utility, adding the command string to the result.
 */
async function executeCommand(
  command: string,
  cwd: string,
  timeout: number
): Promise<CommandResult> {
  const result: ProcessResult = await executeProcess(command, { cwd, timeout });
  return {
    command,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  };
}

/**
 * Executes hub-side hooks before and after tool execution
 */
export class HookExecutor {
  private config: HubHooksConfig;

  constructor(config: HubHooksConfig) {
    this.config = config;
  }

  /**
   * Run PreToolUse hooks. If any hook command exits non-zero, blocks the tool.
   */
  async runPreToolUse(context: HookExecutorContext): Promise<HookExecutionResult> {
    const rules = this.config.PreToolUse ?? [];
    return this.executeRules(rules, context, true);
  }

  /**
   * Run PostToolUse hooks. Failures are logged but don't affect tool result.
   */
  async runPostToolUse(context: HookExecutorContext): Promise<HookExecutionResult> {
    const rules = this.config.PostToolUse ?? [];
    return this.executeRules(rules, context, false);
  }

  /**
   * Execute matching rules
   * @param rules - The rules to evaluate
   * @param context - The hook execution context
   * @param blockOnError - If true, non-zero exit blocks; if false, continue on error
   */
  private async executeRules(
    rules: HubHookRule[],
    context: HookExecutorContext,
    blockOnError: boolean
  ): Promise<HookExecutionResult> {
    const commandResults: CommandResult[] = [];
    let blocked = false;
    let blockReason: string | undefined;

    for (const rule of rules) {
      // Check if rule matches this context
      if (!matchesRule(rule, context)) {
        continue;
      }

      // Render the command template
      const renderedCommand = renderTemplate(rule.command, context);
      const timeout = rule.timeout ?? DEFAULT_TIMEOUT;
      const continueOnError = rule.continueOnError ?? true;

      // Execute the command
      const result = await executeCommand(renderedCommand, context.sandboxPath, timeout);
      commandResults.push(result);

      // Check for errors
      const hasError = result.exitCode !== 0 || result.error !== undefined;

      if (hasError) {
        if (blockOnError) {
          // PreToolUse: block on any non-zero exit
          blocked = true;
          blockReason = result.error || `Hook command exited with code ${result.exitCode}: ${result.stderr || result.stdout}`.trim();
          // Stop processing further rules after blocking
          break;
        } else if (!continueOnError) {
          // PostToolUse with continueOnError=false: log and stop (but don't block)
          console.warn(`Hook command failed: ${renderedCommand}`, result.error || result.stderr);
          break;
        } else {
          // PostToolUse with continueOnError=true: log and continue
          console.warn(`Hook command failed (continuing): ${renderedCommand}`, result.error || result.stderr);
        }
      }
    }

    return {
      blocked,
      blockReason,
      commandResults,
    };
  }
}
