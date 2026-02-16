/**
 * Tests for DeclarativeHookEvaluator
 */

import { describe, it, expect, vi } from 'vitest';
import { DeclarativeHookEvaluator } from '../declarative-hook-evaluator.js';
import type { HookRulesConfig } from '@flo-monster/core';

describe('DeclarativeHookEvaluator', () => {
  describe('evaluatePreToolUse', () => {
    it('returns default when no PreToolUse rules', () => {
      const evaluator = new DeclarativeHookEvaluator({});
      const result = evaluator.evaluatePreToolUse('bash', { command: 'ls' });
      expect(result).toEqual({ decision: 'default' });
    });

    it('deny rule blocks matching tool', () => {
      const config: HookRulesConfig = {
        PreToolUse: [{
          matcher: '^bash$',
          hooks: [{ type: 'action', action: 'deny', reason: 'bash is blocked' }],
        }],
      };
      const evaluator = new DeclarativeHookEvaluator(config);

      const result = evaluator.evaluatePreToolUse('bash', { command: 'ls' });
      expect(result.decision).toBe('deny');
      expect(result.reason).toBe('bash is blocked');
    });

    it('allow rule passes matching tool', () => {
      const config: HookRulesConfig = {
        PreToolUse: [{
          matcher: '^runjs$',
          hooks: [{ type: 'action', action: 'allow', reason: 'runjs allowed' }],
        }],
      };
      const evaluator = new DeclarativeHookEvaluator(config);

      const result = evaluator.evaluatePreToolUse('runjs', { code: '1+1' });
      expect(result.decision).toBe('allow');
      expect(result.reason).toBe('runjs allowed');
    });

    it('log rule continues (returns default when no other actions)', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const config: HookRulesConfig = {
        PreToolUse: [{
          hooks: [{ type: 'action', action: 'log' }],
        }],
      };
      const evaluator = new DeclarativeHookEvaluator(config);

      const result = evaluator.evaluatePreToolUse('bash', { command: 'ls' });
      expect(result.decision).toBe('default');
      expect(consoleSpy).toHaveBeenCalledWith('[hub:hook:PreToolUse] bash');

      consoleSpy.mockRestore();
    });

    it('script action skipped with warning', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const config: HookRulesConfig = {
        PreToolUse: [{
          hooks: [{ type: 'action', action: 'script', script: 'return { decision: "deny" }' }],
        }],
      };
      const evaluator = new DeclarativeHookEvaluator(config);

      const result = evaluator.evaluatePreToolUse('bash', {});
      expect(result.decision).toBe('default');
      expect(warnSpy).toHaveBeenCalledWith('[hub] Script hooks not supported on hub, skipping');

      warnSpy.mockRestore();
    });

    it('matcher regex works for tool names', () => {
      const config: HookRulesConfig = {
        PreToolUse: [{
          matcher: '^(bash|filesystem)$',
          hooks: [{ type: 'action', action: 'deny', reason: 'System tools blocked' }],
        }],
      };
      const evaluator = new DeclarativeHookEvaluator(config);

      expect(evaluator.evaluatePreToolUse('bash', {}).decision).toBe('deny');
      expect(evaluator.evaluatePreToolUse('filesystem', {}).decision).toBe('deny');
      expect(evaluator.evaluatePreToolUse('runjs', {}).decision).toBe('default');
    });

    it('inputMatchers work for field-level regex matching', () => {
      const config: HookRulesConfig = {
        PreToolUse: [{
          matcher: '^write_file$',
          inputMatchers: { path: '\\.py$' },
          hooks: [{ type: 'action', action: 'deny', reason: 'Python files blocked' }],
        }],
      };
      const evaluator = new DeclarativeHookEvaluator(config);

      // Should deny Python files
      expect(evaluator.evaluatePreToolUse('write_file', { path: 'test.py' }).decision).toBe('deny');

      // Should allow JS files
      expect(evaluator.evaluatePreToolUse('write_file', { path: 'test.js' }).decision).toBe('default');

      // Should not match non-string values
      expect(evaluator.evaluatePreToolUse('write_file', { path: 123 }).decision).toBe('default');

      // Should not match missing fields
      expect(evaluator.evaluatePreToolUse('write_file', {}).decision).toBe('default');
    });

    it('no-match returns default', () => {
      const config: HookRulesConfig = {
        PreToolUse: [{
          matcher: '^bash$',
          hooks: [{ type: 'action', action: 'deny' }],
        }],
      };
      const evaluator = new DeclarativeHookEvaluator(config);

      const result = evaluator.evaluatePreToolUse('runjs', { code: '1+1' });
      expect(result.decision).toBe('default');
    });

    it('multiple rules: first deny wins', () => {
      const config: HookRulesConfig = {
        PreToolUse: [
          {
            matcher: '^bash$',
            hooks: [{ type: 'action', action: 'deny', reason: 'Rule 1' }],
          },
          {
            matcher: '^bash$',
            hooks: [{ type: 'action', action: 'allow', reason: 'Rule 2' }],
          },
        ],
      };
      const evaluator = new DeclarativeHookEvaluator(config);

      const result = evaluator.evaluatePreToolUse('bash', {});
      expect(result.decision).toBe('deny');
      expect(result.reason).toBe('Rule 1');
    });

    it('log then deny in same rule: deny wins', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const config: HookRulesConfig = {
        PreToolUse: [{
          hooks: [
            { type: 'action', action: 'log' },
            { type: 'action', action: 'deny', reason: 'After log' },
          ],
        }],
      };
      const evaluator = new DeclarativeHookEvaluator(config);

      const result = evaluator.evaluatePreToolUse('bash', {});
      expect(result.decision).toBe('deny');
      expect(result.reason).toBe('After log');
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('rule without matcher matches all tools', () => {
      const config: HookRulesConfig = {
        PreToolUse: [{
          hooks: [{ type: 'action', action: 'deny', reason: 'All blocked' }],
        }],
      };
      const evaluator = new DeclarativeHookEvaluator(config);

      expect(evaluator.evaluatePreToolUse('bash', {}).decision).toBe('deny');
      expect(evaluator.evaluatePreToolUse('runjs', {}).decision).toBe('deny');
      expect(evaluator.evaluatePreToolUse('dom', {}).decision).toBe('deny');
    });

    it('multiple inputMatchers must all match', () => {
      const config: HookRulesConfig = {
        PreToolUse: [{
          inputMatchers: {
            path: '\\.py$',
            content: 'import os',
          },
          hooks: [{ type: 'action', action: 'deny', reason: 'Dangerous' }],
        }],
      };
      const evaluator = new DeclarativeHookEvaluator(config);

      // Both match -> deny
      expect(evaluator.evaluatePreToolUse('write_file', {
        path: 'test.py',
        content: 'import os\nos.system("rm -rf /")',
      }).decision).toBe('deny');

      // Only path matches -> default
      expect(evaluator.evaluatePreToolUse('write_file', {
        path: 'test.py',
        content: 'print("hello")',
      }).decision).toBe('default');
    });
  });

  describe('evaluatePostToolUse', () => {
    it('logs for matching rules', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const config: HookRulesConfig = {
        PostToolUse: [{
          matcher: '^bash$',
          hooks: [{ type: 'action', action: 'log' }],
        }],
      };
      const evaluator = new DeclarativeHookEvaluator(config);

      evaluator.evaluatePostToolUse('bash', { command: 'ls' });
      expect(consoleSpy).toHaveBeenCalledWith(
        '[hub:hook:PostToolUse] bash',
        { command: 'ls' },
      );

      consoleSpy.mockRestore();
    });

    it('does nothing for non-matching rules', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const config: HookRulesConfig = {
        PostToolUse: [{
          matcher: '^bash$',
          hooks: [{ type: 'action', action: 'log' }],
        }],
      };
      const evaluator = new DeclarativeHookEvaluator(config);

      evaluator.evaluatePostToolUse('runjs', { code: '1+1' });
      expect(consoleSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('does nothing when no PostToolUse rules', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const evaluator = new DeclarativeHookEvaluator({});
      evaluator.evaluatePostToolUse('bash', {});
      expect(consoleSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('getConfig', () => {
    it('returns the config', () => {
      const config: HookRulesConfig = {
        PreToolUse: [{
          matcher: '^bash$',
          hooks: [{ type: 'action', action: 'deny' }],
        }],
      };
      const evaluator = new DeclarativeHookEvaluator(config);
      expect(evaluator.getConfig()).toBe(config);
    });
  });
});
