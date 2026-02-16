/**
 * Tests for shared process execution utilities
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeProcess, AGENT_ENV } from '../process-utils.js';

describe('process-utils', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = join(tmpdir(), `process-utils-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  describe('AGENT_ENV', () => {
    it('should have PATH set', () => {
      expect(AGENT_ENV.PATH).toBeDefined();
      expect(AGENT_ENV.PATH.length).toBeGreaterThan(0);
    });

    it('should have HOME set', () => {
      expect(AGENT_ENV.HOME).toBeDefined();
    });

    it('should have USER set', () => {
      expect(AGENT_ENV.USER).toBeDefined();
    });

    it('should have SHELL set to /bin/sh', () => {
      expect(AGENT_ENV.SHELL).toBe('/bin/sh');
    });

    it('should have TERM set', () => {
      expect(AGENT_ENV.TERM).toBe('xterm-256color');
    });

    it('should have LANG set', () => {
      expect(AGENT_ENV.LANG).toBeDefined();
    });

    it('should not contain sensitive environment variables', () => {
      // AGENT_ENV should only have safe, predefined keys
      const allowedKeys = ['PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG'];
      for (const key of Object.keys(AGENT_ENV)) {
        expect(allowedKeys).toContain(key);
      }
    });
  });

  describe('executeProcess', () => {
    it('should execute a simple command and capture stdout', async () => {
      const result = await executeProcess('echo hello', {
        cwd: workDir,
        timeout: 5000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hello');
      expect(result.error).toBeUndefined();
    });

    it('should capture stderr', async () => {
      const result = await executeProcess('echo error >&2', {
        cwd: workDir,
        timeout: 5000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr.trim()).toBe('error');
    });

    it('should return non-zero exit code for failing commands', async () => {
      const result = await executeProcess('exit 42', {
        cwd: workDir,
        timeout: 5000,
      });

      expect(result.exitCode).toBe(42);
      expect(result.error).toBeUndefined();
    });

    it('should timeout long-running commands', async () => {
      const result = await executeProcess('sleep 10', {
        cwd: workDir,
        timeout: 100,
      });

      expect(result.exitCode).toBe(-1);
      expect(result.error).toContain('timed out');
      expect(result.error).toContain('100ms');
    }, 5000);

    it('should respect the working directory', async () => {
      const result = await executeProcess('pwd', {
        cwd: workDir,
        timeout: 5000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(workDir);
    });

    it('should use AGENT_ENV by default', async () => {
      const result = await executeProcess('echo $TERM', {
        cwd: workDir,
        timeout: 5000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('xterm-256color');
    });

    it('should accept custom environment variables', async () => {
      const result = await executeProcess('echo $MY_VAR', {
        cwd: workDir,
        timeout: 5000,
        env: { ...AGENT_ENV, MY_VAR: 'custom_value' },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('custom_value');
    });

    it('should capture both stdout and stderr', async () => {
      const result = await executeProcess('echo out && echo err >&2', {
        cwd: workDir,
        timeout: 5000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('out');
      expect(result.stderr.trim()).toBe('err');
    });

    it('should handle commands that produce no output', async () => {
      const result = await executeProcess('true', {
        cwd: workDir,
        timeout: 5000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
      expect(result.error).toBeUndefined();
    });

    it('should handle commands with special characters', async () => {
      const result = await executeProcess('echo "hello world" | wc -w', {
        cwd: workDir,
        timeout: 5000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('2');
    });

    it('should report error for invalid commands', async () => {
      const result = await executeProcess('nonexistent_command_xyz_12345', {
        cwd: workDir,
        timeout: 5000,
      });

      // Command not found typically gives exit code 127
      expect(result.exitCode).not.toBe(0);
    });
  });
});
