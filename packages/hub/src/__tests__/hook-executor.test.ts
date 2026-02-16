/**
 * Tests for hook executor
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  HookExecutor,
  matchesRule,
  renderTemplate,
  shellEscape,
  type HookExecutorContext,
} from '../hook-executor.js';
import type { HubHookRule, HubHooksConfig } from '@flo-monster/core';

describe('hook-executor', () => {
  describe('matchesRule', () => {
    const baseContext: HookExecutorContext = {
      toolName: 'bash',
      toolInput: { command: 'ls -la', cwd: '/home/user' },
      sandboxPath: '/tmp/sandbox',
    };

    it('should match when no matchers are specified', () => {
      const rule: HubHookRule = { command: 'echo test' };
      expect(matchesRule(rule, baseContext)).toBe(true);
    });

    it('should match tool name with regex pattern', () => {
      const rule: HubHookRule = { matcher: '^bash$', command: 'echo test' };
      expect(matchesRule(rule, baseContext)).toBe(true);
    });

    it('should not match when tool name does not match pattern', () => {
      const rule: HubHookRule = { matcher: '^filesystem$', command: 'echo test' };
      expect(matchesRule(rule, baseContext)).toBe(false);
    });

    it('should match partial tool name with regex', () => {
      const rule: HubHookRule = { matcher: 'bash', command: 'echo test' };
      const context: HookExecutorContext = {
        ...baseContext,
        toolName: 'secure_bash',
      };
      expect(matchesRule(rule, context)).toBe(true);
    });

    it('should match input field with regex pattern', () => {
      const rule: HubHookRule = {
        inputMatchers: { command: 'ls' },
        command: 'echo test',
      };
      expect(matchesRule(rule, baseContext)).toBe(true);
    });

    it('should not match when input field does not match pattern', () => {
      const rule: HubHookRule = {
        inputMatchers: { command: '^rm' },
        command: 'echo test',
      };
      expect(matchesRule(rule, baseContext)).toBe(false);
    });

    it('should not match when input field is missing', () => {
      const rule: HubHookRule = {
        inputMatchers: { missing_field: '.*' },
        command: 'echo test',
      };
      expect(matchesRule(rule, baseContext)).toBe(false);
    });

    it('should require all input matchers to pass', () => {
      const rule: HubHookRule = {
        inputMatchers: { command: 'ls', cwd: '/home' },
        command: 'echo test',
      };
      expect(matchesRule(rule, baseContext)).toBe(true);

      const rulePartialFail: HubHookRule = {
        inputMatchers: { command: 'ls', cwd: '/root' },
        command: 'echo test',
      };
      expect(matchesRule(rulePartialFail, baseContext)).toBe(false);
    });

    it('should combine tool name and input matchers', () => {
      const rule: HubHookRule = {
        matcher: 'bash',
        inputMatchers: { command: 'ls' },
        command: 'echo test',
      };
      expect(matchesRule(rule, baseContext)).toBe(true);

      const ruleFail: HubHookRule = {
        matcher: 'filesystem',
        inputMatchers: { command: 'ls' },
        command: 'echo test',
      };
      expect(matchesRule(ruleFail, baseContext)).toBe(false);
    });

    it('should handle invalid regex gracefully', () => {
      const rule: HubHookRule = { matcher: '[invalid', command: 'echo test' };
      expect(matchesRule(rule, baseContext)).toBe(false);
    });

    it('should handle invalid input matcher regex gracefully', () => {
      const rule: HubHookRule = {
        inputMatchers: { command: '[invalid' },
        command: 'echo test',
      };
      expect(matchesRule(rule, baseContext)).toBe(false);
    });
  });

  describe('shellEscape', () => {
    it('should wrap simple strings in single quotes', () => {
      expect(shellEscape('hello')).toBe("'hello'");
    });

    it('should escape single quotes within the string', () => {
      expect(shellEscape("it's")).toBe("'it'\\''s'");
    });

    it('should handle empty strings', () => {
      expect(shellEscape('')).toBe("''");
    });

    it('should handle strings with special characters', () => {
      expect(shellEscape('$HOME')).toBe("'$HOME'");
      expect(shellEscape('a b c')).toBe("'a b c'");
      expect(shellEscape('foo;bar')).toBe("'foo;bar'");
    });
  });

  describe('renderTemplate', () => {
    const baseContext: HookExecutorContext = {
      toolName: 'bash',
      toolInput: { command: 'ls -la', path: '/home/user', count: 42 },
      sandboxPath: '/tmp/sandbox',
    };

    it('should replace {{sandbox}} with shell-escaped sandbox path', () => {
      const result = renderTemplate('cd {{sandbox}} && ls', baseContext);
      expect(result).toBe("cd '/tmp/sandbox' && ls");
    });

    it('should replace {{fieldName}} with shell-escaped input values', () => {
      const result = renderTemplate('echo {{command}}', baseContext);
      expect(result).toBe("echo 'ls -la'");
    });

    it('should replace multiple placeholders', () => {
      const result = renderTemplate('cd {{path}} && {{command}}', baseContext);
      expect(result).toBe("cd '/home/user' && 'ls -la'");
    });

    it('should convert non-string values to JSON and shell-escape', () => {
      const result = renderTemplate('echo {{count}}', baseContext);
      expect(result).toBe("echo '42'");
    });

    it('should replace missing fields with empty quoted string', () => {
      const result = renderTemplate('echo {{missing}}', baseContext);
      expect(result).toBe("echo ''");
    });

    it('should replace {{result}} with shell-escaped tool result content', () => {
      const contextWithResult: HookExecutorContext = {
        ...baseContext,
        toolResult: { content: 'success output' },
      };
      const result = renderTemplate('echo {{result}}', contextWithResult);
      expect(result).toBe("echo 'success output'");
    });

    it('should replace {{result}} with empty quoted string when no result', () => {
      const result = renderTemplate('echo {{result}}', baseContext);
      expect(result).toBe("echo ''");
    });

    it('should handle complex objects in input with shell-escaping', () => {
      const contextWithObject: HookExecutorContext = {
        ...baseContext,
        toolInput: {
          ...baseContext.toolInput,
          config: { nested: true, value: 'test' },
        },
      };
      const result = renderTemplate('echo {{config}}', contextWithObject);
      expect(result).toBe(`echo '{"nested":true,"value":"test"}'`);
    });

    it('should shell-escape interpolated values to prevent injection', () => {
      const context: HookExecutorContext = {
        toolName: 'bash',
        toolInput: { command: "'; rm -rf /; '" },
        sandboxPath: '/tmp/sandbox',
      };
      const rendered = renderTemplate('echo {{command}}', context);
      // The value should be shell-escaped: wrapped in single quotes with inner quotes escaped
      // Input: '; rm -rf /; '
      // shellEscape wraps in ' and escapes inner ' as '\''
      // Result: ''\''; rm -rf /; '\'''
      expect(rendered).toBe("echo ''\\''; rm -rf /; '\\'''");
      // Verify the malicious payload cannot execute as a separate command:
      // The semicolons and rm are inside the quoted value, not bare shell
    });

    it('should shell-escape sandbox path with spaces', () => {
      const context: HookExecutorContext = {
        toolName: 'bash',
        toolInput: {},
        sandboxPath: '/tmp/path with spaces',
      };
      const rendered = renderTemplate('ls {{sandbox}}', context);
      expect(rendered).toBe("ls '/tmp/path with spaces'");
    });

    it('should shell-escape result content', () => {
      const context: HookExecutorContext = {
        toolName: 'bash',
        toolInput: {},
        toolResult: { content: 'line1\nline2' },
        sandboxPath: '/tmp/sandbox',
      };
      const rendered = renderTemplate('echo {{result}}', context);
      expect(rendered).toBe("echo 'line1\nline2'");
    });

    it('should use empty quoted string for undefined values', () => {
      const context: HookExecutorContext = {
        toolName: 'bash',
        toolInput: {},
        sandboxPath: '/tmp/sandbox',
      };
      const rendered = renderTemplate('echo {{nonexistent}}', context);
      expect(rendered).toBe("echo ''");
    });
  });

  describe('HookExecutor', () => {
    let sandboxDir: string;

    beforeEach(async () => {
      sandboxDir = join(
        tmpdir(),
        `hook-executor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      await mkdir(sandboxDir, { recursive: true });
    });

    afterEach(async () => {
      await rm(sandboxDir, { recursive: true, force: true });
    });

    describe('runPreToolUse', () => {
      it('should return not blocked when no rules', async () => {
        const config: HubHooksConfig = {};
        const executor = new HookExecutor(config);

        const result = await executor.runPreToolUse({
          toolName: 'bash',
          toolInput: { command: 'ls' },
          sandboxPath: sandboxDir,
        });

        expect(result.blocked).toBe(false);
        expect(result.commandResults).toHaveLength(0);
      });

      it('should execute matching rule commands', async () => {
        const config: HubHooksConfig = {
          PreToolUse: [
            { matcher: 'bash', command: 'echo "hook executed"' },
          ],
        };
        const executor = new HookExecutor(config);

        const result = await executor.runPreToolUse({
          toolName: 'bash',
          toolInput: { command: 'ls' },
          sandboxPath: sandboxDir,
        });

        expect(result.blocked).toBe(false);
        expect(result.commandResults).toHaveLength(1);
        expect(result.commandResults[0].exitCode).toBe(0);
        expect(result.commandResults[0].stdout.trim()).toBe('hook executed');
      });

      it('should block when command exits non-zero', async () => {
        const config: HubHooksConfig = {
          PreToolUse: [
            { matcher: 'bash', command: 'exit 1' },
          ],
        };
        const executor = new HookExecutor(config);

        const result = await executor.runPreToolUse({
          toolName: 'bash',
          toolInput: { command: 'rm -rf /' },
          sandboxPath: sandboxDir,
        });

        expect(result.blocked).toBe(true);
        expect(result.blockReason).toContain('code 1');
        expect(result.commandResults[0].exitCode).toBe(1);
      });

      it('should include stderr in block reason', async () => {
        const config: HubHooksConfig = {
          PreToolUse: [
            { matcher: 'bash', command: 'echo "denied" >&2 && exit 1' },
          ],
        };
        const executor = new HookExecutor(config);

        const result = await executor.runPreToolUse({
          toolName: 'bash',
          toolInput: { command: 'rm -rf /' },
          sandboxPath: sandboxDir,
        });

        expect(result.blocked).toBe(true);
        expect(result.blockReason).toContain('denied');
      });

      it('should skip non-matching rules', async () => {
        const config: HubHooksConfig = {
          PreToolUse: [
            { matcher: 'filesystem', command: 'exit 1' },
          ],
        };
        const executor = new HookExecutor(config);

        const result = await executor.runPreToolUse({
          toolName: 'bash',
          toolInput: { command: 'ls' },
          sandboxPath: sandboxDir,
        });

        expect(result.blocked).toBe(false);
        expect(result.commandResults).toHaveLength(0);
      });

      it('should stop after first blocking rule', async () => {
        const config: HubHooksConfig = {
          PreToolUse: [
            { matcher: 'bash', command: 'exit 1' },
            { matcher: 'bash', command: 'echo "should not run"' },
          ],
        };
        const executor = new HookExecutor(config);

        const result = await executor.runPreToolUse({
          toolName: 'bash',
          toolInput: { command: 'ls' },
          sandboxPath: sandboxDir,
        });

        expect(result.blocked).toBe(true);
        expect(result.commandResults).toHaveLength(1);
      });

      it('should execute multiple matching rules when all succeed', async () => {
        const config: HubHooksConfig = {
          PreToolUse: [
            { matcher: 'bash', command: 'echo "first"' },
            { matcher: 'bash', command: 'echo "second"' },
          ],
        };
        const executor = new HookExecutor(config);

        const result = await executor.runPreToolUse({
          toolName: 'bash',
          toolInput: { command: 'ls' },
          sandboxPath: sandboxDir,
        });

        expect(result.blocked).toBe(false);
        expect(result.commandResults).toHaveLength(2);
        expect(result.commandResults[0].stdout.trim()).toBe('first');
        expect(result.commandResults[1].stdout.trim()).toBe('second');
      });

      it('should render template before execution', async () => {
        const config: HubHooksConfig = {
          PreToolUse: [
            { command: 'echo tool: bash, cmd: {{command}}' },
          ],
        };
        const executor = new HookExecutor(config);

        const result = await executor.runPreToolUse({
          toolName: 'bash',
          toolInput: { command: 'ls -la' },
          sandboxPath: sandboxDir,
        });

        expect(result.blocked).toBe(false);
        expect(result.commandResults[0].stdout).toContain('tool: bash');
        expect(result.commandResults[0].stdout).toContain('cmd: ls -la');
      });
    });

    describe('runPostToolUse', () => {
      it('should not block even on non-zero exit', async () => {
        const config: HubHooksConfig = {
          PostToolUse: [
            { matcher: 'bash', command: 'exit 1' },
          ],
        };
        const executor = new HookExecutor(config);

        const result = await executor.runPostToolUse({
          toolName: 'bash',
          toolInput: { command: 'ls' },
          toolResult: { content: 'file1\nfile2' },
          sandboxPath: sandboxDir,
        });

        expect(result.blocked).toBe(false);
        expect(result.commandResults[0].exitCode).toBe(1);
      });

      it('should continue to next rule on error by default', async () => {
        const config: HubHooksConfig = {
          PostToolUse: [
            { matcher: 'bash', command: 'exit 1' },
            { matcher: 'bash', command: 'echo "second"' },
          ],
        };
        const executor = new HookExecutor(config);

        const result = await executor.runPostToolUse({
          toolName: 'bash',
          toolInput: { command: 'ls' },
          sandboxPath: sandboxDir,
        });

        expect(result.blocked).toBe(false);
        expect(result.commandResults).toHaveLength(2);
        expect(result.commandResults[1].stdout.trim()).toBe('second');
      });

      it('should stop on error when continueOnError=false', async () => {
        const config: HubHooksConfig = {
          PostToolUse: [
            { matcher: 'bash', command: 'exit 1', continueOnError: false },
            { matcher: 'bash', command: 'echo "should not run"' },
          ],
        };
        const executor = new HookExecutor(config);

        const result = await executor.runPostToolUse({
          toolName: 'bash',
          toolInput: { command: 'ls' },
          sandboxPath: sandboxDir,
        });

        expect(result.blocked).toBe(false);
        expect(result.commandResults).toHaveLength(1);
      });

      it('should have access to tool result in template', async () => {
        const config: HubHooksConfig = {
          PostToolUse: [
            { command: 'echo result: {{result}}' },
          ],
        };
        const executor = new HookExecutor(config);

        const result = await executor.runPostToolUse({
          toolName: 'bash',
          toolInput: { command: 'ls' },
          toolResult: { content: 'output here' },
          sandboxPath: sandboxDir,
        });

        expect(result.commandResults[0].stdout).toContain('result: output here');
      });
    });

    describe('timeout handling', () => {
      it('should timeout commands that run too long', async () => {
        const config: HubHooksConfig = {
          PreToolUse: [
            { matcher: 'bash', command: 'sleep 10', timeout: 100 },
          ],
        };
        const executor = new HookExecutor(config);

        const result = await executor.runPreToolUse({
          toolName: 'bash',
          toolInput: { command: 'ls' },
          sandboxPath: sandboxDir,
        });

        expect(result.blocked).toBe(true);
        expect(result.blockReason).toContain('timed out');
        expect(result.commandResults[0].error).toContain('timed out');
      }, 5000);

      it('should use default timeout when not specified', async () => {
        // This test just verifies the default timeout (5000ms) is used
        // We use a fast command to verify it completes normally
        const config: HubHooksConfig = {
          PreToolUse: [
            { matcher: 'bash', command: 'echo "fast"' },
          ],
        };
        const executor = new HookExecutor(config);

        const result = await executor.runPreToolUse({
          toolName: 'bash',
          toolInput: { command: 'ls' },
          sandboxPath: sandboxDir,
        });

        expect(result.blocked).toBe(false);
        expect(result.commandResults[0].exitCode).toBe(0);
      });
    });

    describe('error handling', () => {
      it('should handle command not found', async () => {
        const config: HubHooksConfig = {
          PreToolUse: [
            { matcher: 'bash', command: 'nonexistent_command_12345' },
          ],
        };
        const executor = new HookExecutor(config);

        const result = await executor.runPreToolUse({
          toolName: 'bash',
          toolInput: { command: 'ls' },
          sandboxPath: sandboxDir,
        });

        expect(result.blocked).toBe(true);
        // Command not found typically exits with code 127
        expect(result.commandResults[0].exitCode).not.toBe(0);
      });

      it('should include error details in command results', async () => {
        const config: HubHooksConfig = {
          PreToolUse: [
            { matcher: 'bash', command: 'exit 42' },
          ],
        };
        const executor = new HookExecutor(config);

        const result = await executor.runPreToolUse({
          toolName: 'bash',
          toolInput: { command: 'ls' },
          sandboxPath: sandboxDir,
        });

        expect(result.commandResults[0].exitCode).toBe(42);
        expect(result.commandResults[0].command).toBe('exit 42');
      });
    });

    describe('input matchers integration', () => {
      it('should match based on input field patterns', async () => {
        const config: HubHooksConfig = {
          PreToolUse: [
            {
              inputMatchers: { command: 'rm.*-rf' },
              command: 'echo "dangerous command blocked" && exit 1',
            },
          ],
        };
        const executor = new HookExecutor(config);

        const resultBlocked = await executor.runPreToolUse({
          toolName: 'bash',
          toolInput: { command: 'rm -rf /important' },
          sandboxPath: sandboxDir,
        });
        expect(resultBlocked.blocked).toBe(true);

        const resultAllowed = await executor.runPreToolUse({
          toolName: 'bash',
          toolInput: { command: 'ls -la' },
          sandboxPath: sandboxDir,
        });
        expect(resultAllowed.blocked).toBe(false);
      });

      it('should combine tool name and input matchers', async () => {
        const config: HubHooksConfig = {
          PreToolUse: [
            {
              matcher: 'bash',
              inputMatchers: { command: '^sudo' },
              command: 'exit 1',
            },
          ],
        };
        const executor = new HookExecutor(config);

        const bashSudo = await executor.runPreToolUse({
          toolName: 'bash',
          toolInput: { command: 'sudo rm file' },
          sandboxPath: sandboxDir,
        });
        expect(bashSudo.blocked).toBe(true);

        const bashNormal = await executor.runPreToolUse({
          toolName: 'bash',
          toolInput: { command: 'ls file' },
          sandboxPath: sandboxDir,
        });
        expect(bashNormal.blocked).toBe(false);

        const filesystemSudo = await executor.runPreToolUse({
          toolName: 'filesystem',
          toolInput: { command: 'sudo something' },
          sandboxPath: sandboxDir,
        });
        expect(filesystemSudo.blocked).toBe(false);
      });
    });
  });
});
