/**
 * Bash tool for executing shell commands
 */

import { DEFAULT_RESTRICTED_BLOCKLIST, type HubConfig } from '../config.js';
import { validateSandboxPath } from '../utils/path-utils.js';
import { executeProcess } from '../utils/process-utils.js';

export interface BashInput {
  command: string;
  cwd?: string;
  timeout?: number;
}

export interface ToolResult {
  content: string;
  is_error?: boolean;
}

export const bashToolDef = {
  name: 'bash',
  description: 'Execute a shell command',
  input_schema: {
    type: 'object' as const,
    properties: {
      command: { type: 'string' as const, description: 'The command to execute' },
      cwd: { type: 'string' as const, description: 'Working directory' },
      timeout: { type: 'number' as const, description: 'Timeout in ms', default: 30000 },
    },
    required: ['command'] as const,
  },
};

/**
 * Get the effective blocklist based on bash config mode.
 * Restricted mode: DEFAULT_RESTRICTED_BLOCKLIST + custom blockedCommands
 * Unrestricted mode: only custom blockedCommands
 */
export function getEffectiveBlocklist(bashConfig: HubConfig['tools']['bash']): string[] {
  const custom = bashConfig.blockedCommands ?? [];
  if (bashConfig.mode === 'unrestricted') {
    return custom;
  }
  // Default is restricted
  return [...DEFAULT_RESTRICTED_BLOCKLIST, ...custom];
}

/**
 * Check if a command is blocked.
 * Splits compound commands (pipes, chains) and checks each segment.
 * Detects `bash -c`, `sh -c`, and `env` wrappers.
 */
export function isCommandBlocked(command: string, blockedCommands?: string[]): boolean {
  if (!blockedCommands || blockedCommands.length === 0) {
    return false;
  }

  // Block shell metacharacters that can embed commands (HUB-RUN-05)
  // These bypass compound command splitting
  if (/\$\(/.test(command)) return true;      // Command substitution: $(...)
  if (/`/.test(command)) return true;          // Backtick command substitution
  if (/\n/.test(command)) return true;         // Newline (command separator)
  if (/<\(/.test(command)) return true;        // Process substitution: <(...)
  if (/>\(/.test(command)) return true;        // Process substitution: >(...)
  if (/<</.test(command)) return true;         // Heredoc

  // Split on ;, &&, ||, | to check each segment
  const segments = command.split(/\s*(?:;|&&|\|\||(?<!=)\|(?!=))\s*/);

  for (const segment of segments) {
    if (isSegmentBlocked(segment.trim(), blockedCommands)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a single command segment is blocked.
 * Handles sudo, bash -c, sh -c, and env prefixes.
 */
function isSegmentBlocked(segment: string, blockedCommands: string[]): boolean {
  if (!segment) return false;

  const normalized = segment.toLowerCase().trim();

  // Strip sudo prefix
  let cmd = normalized;
  if (cmd.startsWith('sudo ')) {
    cmd = cmd.slice(5).trim();
  }

  // Detect bash -c / sh -c wrappers — extract inner command
  const shellExecMatch = cmd.match(/^(?:bash|sh|\/bin\/(?:ba)?sh)\s+-c\s+['"](.*)['"]\s*$/);
  if (shellExecMatch) {
    // Recursively check the inner command
    return isCommandBlocked(shellExecMatch[1], blockedCommands);
  }
  // Also handle without quotes: bash -c command
  const shellExecNoQuoteMatch = cmd.match(/^(?:bash|sh|\/bin\/(?:ba)?sh)\s+-c\s+(.+)$/);
  if (shellExecNoQuoteMatch) {
    return isCommandBlocked(shellExecNoQuoteMatch[1], blockedCommands);
  }

  // Detect env prefix: env [VAR=val...] command
  const envMatch = cmd.match(/^(?:\/usr\/bin\/)?env\s+(?:\w+=\S+\s+)*(.+)$/);
  if (envMatch) {
    return isSegmentBlocked(envMatch[1], blockedCommands);
  }

  // Now check against blocklist
  const firstWord = cmd.split(/\s+/)[0];
  const firstTwoWords = cmd.split(/\s+/).slice(0, 2).join(' ');

  for (const blocked of blockedCommands) {
    const normalizedBlocked = blocked.toLowerCase().trim();

    // For multi-word patterns like "rm -rf /", check if command starts with it
    if (normalizedBlocked.includes(' ')) {
      if (cmd.startsWith(normalizedBlocked)) {
        return true;
      }
    } else {
      // For single-word patterns, check if it matches the command name
      if (firstWord === normalizedBlocked ||
          firstWord.endsWith('/' + normalizedBlocked) ||
          firstTwoWords.endsWith(' ' + normalizedBlocked)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if a command is allowed (when allowedCommands is specified)
 */
export function isCommandAllowed(command: string, allowedCommands?: string[]): boolean {
  if (!allowedCommands || allowedCommands.length === 0) {
    return true; // No restrictions
  }

  // Block shell metacharacters in allowed mode too (HUB-RUN-05)
  if (/\$\(/.test(command)) return false;
  if (/`/.test(command)) return false;
  if (/\n/.test(command)) return false;
  if (/<\(/.test(command)) return false;
  if (/>\(/.test(command)) return false;
  if (/<</.test(command)) return false;

  // Split compound commands and check each segment
  const segments = command.split(/\s*(?:;|&&|\|\||(?<!=)\|(?!=))\s*/);

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    const normalizedCommand = trimmed.toLowerCase();
    // Strip sudo prefix for checking
    const stripped = normalizedCommand.startsWith('sudo ') ? normalizedCommand.slice(5).trim() : normalizedCommand;
    const commandName = stripped.split(/\s+/)[0];

    let found = false;
    for (const allowed of allowedCommands) {
      const normalizedAllowed = allowed.toLowerCase().trim();
      if (commandName === normalizedAllowed || commandName.endsWith('/' + normalizedAllowed)) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }

  return true;
}

/**
 * Validate that a cwd is within the sandbox directory
 * Uses realpath to resolve symlinks and prevent traversal attacks
 */
export async function validateCwd(
  cwd: string,
  config: HubConfig
): Promise<{ valid: boolean; reason?: string; resolvedPath?: string }> {
  // If no sandboxPath is configured, reject all cwd overrides
  if (!config.sandboxPath || config.sandboxPath.length === 0) {
    return { valid: false, reason: 'Sandbox path is not configured' };
  }

  const result = await validateSandboxPath(cwd, config, config.sandboxPath);

  if (!result.valid) {
    // Map generic reason to bash-specific message
    const reason = result.reason?.includes('outside the sandbox')
      ? 'Working directory is outside the sandbox'
      : result.reason?.replace('Path validation error', 'cwd validation error') ?? 'Invalid working directory';
    return { valid: false, reason };
  }

  return { valid: true, resolvedPath: result.resolved };
}

/**
 * Execute a bash command
 */
export async function executeBash(
  input: BashInput,
  config: HubConfig
): Promise<ToolResult> {
  // Check if bash tool is enabled
  if (!config.tools.bash.enabled) {
    return {
      content: 'Bash tool is disabled',
      is_error: true,
    };
  }

  // Check blocked commands
  if (isCommandBlocked(input.command, getEffectiveBlocklist(config.tools.bash))) {
    return {
      content: 'Command is blocked by security policy',
      is_error: true,
    };
  }

  // Check allowed commands
  if (!isCommandAllowed(input.command, config.tools.bash.allowedCommands)) {
    return {
      content: 'Command is not in the allowed commands list',
      is_error: true,
    };
  }

  const timeout = input.timeout ?? 30000;

  // Determine the working directory - default to sandboxPath
  const requestedCwd = input.cwd ?? config.sandboxPath ?? process.cwd();

  // Validate the cwd is within the sandbox
  const cwdValidation = await validateCwd(requestedCwd, config);
  if (!cwdValidation.valid) {
    return {
      content: cwdValidation.reason ?? 'Invalid working directory',
      is_error: true,
    };
  }

  const cwd = cwdValidation.resolvedPath!;

  const result = await executeProcess(input.command, {
    cwd,
    timeout,
    runAsUser: config.tools.bash.runAsUser,
  });

  if (result.error) {
    return {
      content: result.error,
      is_error: true,
    };
  }

  const output = result.stdout + (result.stderr ? '\n' + result.stderr : '');

  if (result.exitCode !== 0) {
    return {
      content: output || `Command exited with code ${result.exitCode}`,
      is_error: true,
    };
  }

  return {
    content: output || '(no output)',
  };
}
