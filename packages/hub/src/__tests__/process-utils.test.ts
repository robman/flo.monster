/**
 * Tests for process-utils
 */

import { describe, it, expect } from 'vitest';
import { executeProcess, AGENT_ENV } from '../utils/process-utils.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('process-utils', () => {
  describe('executeProcess', () => {
    it('should execute a simple command', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'proc-test-'));
      try {
        const result = await executeProcess('echo hello', { cwd: dir, timeout: 5000 });
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe('hello');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('should capture stderr', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'proc-test-'));
      try {
        const result = await executeProcess('echo err >&2', { cwd: dir, timeout: 5000 });
        expect(result.stderr.trim()).toBe('err');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('should handle timeout', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'proc-test-'));
      try {
        const result = await executeProcess('sleep 30', { cwd: dir, timeout: 200 });
        expect(result.error).toContain('timed out');
        expect(result.exitCode).toBe(-1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 5000);

    it('should handle non-zero exit code', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'proc-test-'));
      try {
        const result = await executeProcess('exit 42', { cwd: dir, timeout: 5000 });
        expect(result.exitCode).toBe(42);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('should use custom env', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'proc-test-'));
      try {
        const result = await executeProcess('echo $MY_VAR', {
          cwd: dir,
          timeout: 5000,
          env: { ...AGENT_ENV, MY_VAR: 'test-value' },
        });
        expect(result.stdout.trim()).toBe('test-value');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('sudo wrapping', () => {
    // These tests verify the command wrapping logic without actually needing sudo
    // We test by checking the error message when sudo is not available

    it('should attempt sudo when runAsUser is set', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'proc-test-'));
      try {
        // Use a non-existent user to verify sudo wrapping is attempted
        const result = await executeProcess('echo hello', {
          cwd: dir,
          timeout: 5000,
          runAsUser: 'nonexistent-user-12345',
        });
        // Should fail because the user doesn't exist (or sudo isn't configured)
        // The key thing is it ATTEMPTED sudo wrapping
        expect(result.exitCode !== 0 || result.error !== undefined).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('should escape single quotes in command for sudo wrapping', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'proc-test-'));
      try {
        // Command with single quotes — should not cause syntax error even though sudo fails
        const result = await executeProcess("echo 'hello world'", {
          cwd: dir,
          timeout: 5000,
          runAsUser: 'nonexistent-user-12345',
        });
        // If it fails, it should be because of the user, not a quote escaping issue
        expect(result.exitCode !== 0 || result.error !== undefined).toBe(true);
        // Should NOT have a "syntax error" in stderr
        expect(result.stderr).not.toContain('syntax error');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('should not use sudo when runAsUser is not set', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'proc-test-'));
      try {
        const result = await executeProcess('echo hello', {
          cwd: dir,
          timeout: 5000,
          // No runAsUser
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe('hello');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('should handle timeout with sudo wrapping', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'proc-test-'));
      try {
        const result = await executeProcess('sleep 30', {
          cwd: dir,
          timeout: 200,
          runAsUser: 'nonexistent-user-12345',
        });
        // sudo may fail fast (nonexistent user exits immediately) or may timeout
        // Either way, the command should not succeed
        expect(result.exitCode).not.toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 5000);
  });

  describe('AGENT_ENV', () => {
    it('should have basic environment variables', () => {
      expect(AGENT_ENV.PATH).toBeDefined();
      expect(AGENT_ENV.HOME).toBeDefined();
      expect(AGENT_ENV.SHELL).toBe('/bin/sh');
    });

    it('should not contain sensitive variables', () => {
      expect(AGENT_ENV).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
      expect(AGENT_ENV).not.toHaveProperty('GITHUB_TOKEN');
      expect(AGENT_ENV).not.toHaveProperty('DATABASE_URL');
    });
  });
});
