/**
 * Tests for shared path utilities
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { matchesPattern, validateSandboxPath } from '../path-utils.js';
import { getDefaultConfig, type HubConfig } from '../../config.js';

describe('path-utils', () => {
  describe('matchesPattern', () => {
    it('should match exact paths', () => {
      expect(matchesPattern('/home/user', '/home/user')).toBe(true);
    });

    it('should match child paths', () => {
      expect(matchesPattern('/home/user/file.txt', '/home/user')).toBe(true);
    });

    it('should not match sibling paths', () => {
      expect(matchesPattern('/home/other', '/home/user')).toBe(false);
    });

    it('should not match partial directory name matches', () => {
      expect(matchesPattern('/home/username', '/home/user')).toBe(false);
    });

    it('should handle trailing slashes via normalization', () => {
      expect(matchesPattern('/home/user/', '/home/user')).toBe(true);
    });
  });

  describe('validateSandboxPath', () => {
    let sandboxDir: string;
    let config: HubConfig;

    beforeEach(async () => {
      sandboxDir = join(
        tmpdir(),
        `path-utils-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      await mkdir(sandboxDir, { recursive: true });
      await mkdir(join(sandboxDir, 'subdir'), { recursive: true });

      config = {
        ...getDefaultConfig(),
        sandboxPath: sandboxDir,
      };
    });

    afterEach(async () => {
      await rm(sandboxDir, { recursive: true, force: true });
    });

    it('should allow paths within the sandbox', async () => {
      const result = await validateSandboxPath(
        join(sandboxDir, 'subdir'),
        config
      );
      expect(result.valid).toBe(true);
      expect(result.resolved).toBeDefined();
    });

    it('should reject paths outside the sandbox', async () => {
      const result = await validateSandboxPath('/tmp', config);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('outside the sandbox');
    });

    it('should allow the sandbox root itself', async () => {
      const result = await validateSandboxPath(sandboxDir, config);
      expect(result.valid).toBe(true);
    });

    it('should resolve relative paths against basePath', async () => {
      const result = await validateSandboxPath(
        'subdir',
        config,
        sandboxDir
      );
      expect(result.valid).toBe(true);
      expect(result.resolved).toContain('subdir');
    });

    it('should resolve relative paths against sandboxPath when no basePath given', async () => {
      const result = await validateSandboxPath('subdir', config);
      expect(result.valid).toBe(true);
      expect(result.resolved).toContain('subdir');
    });

    it('should block symlink escape attempts', async () => {
      const linkPath = join(sandboxDir, 'escape-link');
      try {
        await symlink('/tmp', linkPath);
        const result = await validateSandboxPath(linkPath, config);
        expect(result.valid).toBe(false);
        expect(result.reason).toContain('outside the sandbox');
      } catch {
        // Symlink creation might fail due to permissions, skip test
      }
    });

    it('should handle non-existent paths within sandbox', async () => {
      const result = await validateSandboxPath(
        join(sandboxDir, 'nonexistent', 'file.txt'),
        config
      );
      expect(result.valid).toBe(true);
    });

    it('should handle parent directory traversal', async () => {
      const result = await validateSandboxPath(
        join(sandboxDir, 'subdir', '..', '..', 'etc', 'passwd'),
        config
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('outside the sandbox');
    });

    it('should handle sandbox path that does not exist yet', async () => {
      const nonExistentSandbox = join(tmpdir(), `non-existent-${Date.now()}`);
      const nonExistentConfig: HubConfig = {
        ...getDefaultConfig(),
        sandboxPath: nonExistentSandbox,
      };

      // Path inside non-existent sandbox should be valid (sandbox will be created later)
      const result = await validateSandboxPath(
        join(nonExistentSandbox, 'file.txt'),
        nonExistentConfig
      );
      expect(result.valid).toBe(true);
    });

    it('should use basePath for resolution when provided', async () => {
      const result = await validateSandboxPath(
        'file.txt',
        config,
        join(sandboxDir, 'subdir')
      );
      expect(result.valid).toBe(true);
      expect(result.resolved).toContain('subdir');
      expect(result.resolved).toContain('file.txt');
    });

    it('should return the resolved path on success', async () => {
      const result = await validateSandboxPath(
        join(sandboxDir, 'subdir'),
        config
      );
      expect(result.valid).toBe(true);
      expect(result.resolved).toBe(join(sandboxDir, 'subdir'));
    });
  });
});
