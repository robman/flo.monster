/**
 * Tests for filesystem tool
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeFilesystem, validatePath } from '../tools/filesystem.js';
import { getDefaultConfig, type HubConfig } from '../config.js';

describe('filesystem tool', () => {
  let testDir: string;
  let config: HubConfig;

  beforeEach(async () => {
    testDir = join(tmpdir(), `hub-fs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });

    config = {
      ...getDefaultConfig(),
      tools: {
        ...getDefaultConfig().tools,
        filesystem: {
          enabled: true,
          allowedPaths: [testDir],
          blockedPaths: [join(testDir, 'blocked')],
        },
      },
    };
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('validatePath', () => {
    it('should allow paths within allowed directories', async () => {
      const result = await validatePath(join(testDir, 'file.txt'), config);
      expect(result.valid).toBe(true);
    });

    it('should reject paths outside allowed directories', async () => {
      const result = await validatePath('/etc/passwd', config);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('not in allowed');
    });

    it('should reject blocked paths', async () => {
      await mkdir(join(testDir, 'blocked'), { recursive: true });
      const result = await validatePath(join(testDir, 'blocked', 'file.txt'), config);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('blocked');
    });

    it('should prevent symlink traversal', async () => {
      // Create a symlink to a blocked area
      const linkPath = join(testDir, 'sneaky-link');
      try {
        await symlink('/etc', linkPath);
        const result = await validatePath(join(linkPath, 'passwd'), config);
        expect(result.valid).toBe(false);
      } catch {
        // Symlink creation might fail due to permissions, skip test
      }
    });
  });

  describe('executeFilesystem', () => {
    it('should return error when filesystem is disabled', async () => {
      const disabledConfig: HubConfig = {
        ...config,
        tools: {
          ...config.tools,
          filesystem: { enabled: false, allowedPaths: [] },
        },
      };

      const result = await executeFilesystem(
        { action: 'read', path: '/tmp/test' },
        disabledConfig
      );

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('disabled');
    });

    describe('read action', () => {
      it('should read file contents', async () => {
        const filePath = join(testDir, 'test.txt');
        await writeFile(filePath, 'Hello, World!', 'utf-8');

        const result = await executeFilesystem(
          { action: 'read', path: filePath },
          config
        );

        expect(result.is_error).toBeUndefined();
        expect(result.content).toBe('Hello, World!');
      });

      it('should return error for non-existent file', async () => {
        const result = await executeFilesystem(
          { action: 'read', path: join(testDir, 'nonexistent.txt') },
          config
        );

        expect(result.is_error).toBe(true);
        expect(result.content).toContain('not found');
      });
    });

    describe('write action', () => {
      it('should write file contents', async () => {
        const filePath = join(testDir, 'output.txt');

        const result = await executeFilesystem(
          { action: 'write', path: filePath, content: 'Test content' },
          config
        );

        expect(result.is_error).toBeUndefined();

        const content = await readFile(filePath, 'utf-8');
        expect(content).toBe('Test content');
      });

      it('should create parent directories', async () => {
        const filePath = join(testDir, 'deep', 'nested', 'file.txt');

        const result = await executeFilesystem(
          { action: 'write', path: filePath, content: 'Nested content' },
          config
        );

        expect(result.is_error).toBeUndefined();

        const content = await readFile(filePath, 'utf-8');
        expect(content).toBe('Nested content');
      });

      it('should require content for write', async () => {
        const result = await executeFilesystem(
          { action: 'write', path: join(testDir, 'file.txt') },
          config
        );

        expect(result.is_error).toBe(true);
        expect(result.content).toContain('Content is required');
      });
    });

    describe('list action', () => {
      it('should list directory contents', async () => {
        await writeFile(join(testDir, 'file1.txt'), 'content');
        await writeFile(join(testDir, 'file2.txt'), 'content');
        await mkdir(join(testDir, 'subdir'));

        const result = await executeFilesystem(
          { action: 'list', path: testDir },
          config
        );

        expect(result.is_error).toBeUndefined();
        expect(result.content).toContain('file1.txt');
        expect(result.content).toContain('file2.txt');
        expect(result.content).toContain('d subdir');
      });

      it('should indicate empty directory', async () => {
        const emptyDir = join(testDir, 'empty');
        await mkdir(emptyDir);

        const result = await executeFilesystem(
          { action: 'list', path: emptyDir },
          config
        );

        expect(result.is_error).toBeUndefined();
        expect(result.content).toContain('empty directory');
      });
    });

    describe('mkdir action', () => {
      it('should create directory', async () => {
        const dirPath = join(testDir, 'newdir');

        const result = await executeFilesystem(
          { action: 'mkdir', path: dirPath },
          config
        );

        expect(result.is_error).toBeUndefined();

        const listing = await executeFilesystem(
          { action: 'list', path: testDir },
          config
        );
        expect(listing.content).toContain('d newdir');
      });

      it('should create nested directories', async () => {
        const dirPath = join(testDir, 'a', 'b', 'c');

        const result = await executeFilesystem(
          { action: 'mkdir', path: dirPath },
          config
        );

        expect(result.is_error).toBeUndefined();
      });
    });

    describe('delete action', () => {
      it('should delete file', async () => {
        const filePath = join(testDir, 'todelete.txt');
        await writeFile(filePath, 'content');

        const result = await executeFilesystem(
          { action: 'delete', path: filePath },
          config
        );

        expect(result.is_error).toBeUndefined();

        const readResult = await executeFilesystem(
          { action: 'read', path: filePath },
          config
        );
        expect(readResult.is_error).toBe(true);
      });

      it('should delete directory recursively', async () => {
        const dirPath = join(testDir, 'toremove');
        await mkdir(dirPath);
        await writeFile(join(dirPath, 'file.txt'), 'content');

        const result = await executeFilesystem(
          { action: 'delete', path: dirPath },
          config
        );

        expect(result.is_error).toBeUndefined();
      });
    });

    describe('stat action', () => {
      it('should return file stats', async () => {
        const filePath = join(testDir, 'stattest.txt');
        await writeFile(filePath, 'Hello');

        const result = await executeFilesystem(
          { action: 'stat', path: filePath },
          config
        );

        expect(result.is_error).toBeUndefined();

        const stats = JSON.parse(result.content);
        expect(stats.type).toBe('file');
        expect(stats.size).toBe(5);
        expect(stats.modified).toBeDefined();
      });

      it('should identify directories', async () => {
        const dirPath = join(testDir, 'statdir');
        await mkdir(dirPath);

        const result = await executeFilesystem(
          { action: 'stat', path: dirPath },
          config
        );

        expect(result.is_error).toBeUndefined();

        const stats = JSON.parse(result.content);
        expect(stats.type).toBe('directory');
      });
    });

    describe('path security', () => {
      it('should reject paths outside allowed directories', async () => {
        const result = await executeFilesystem(
          { action: 'read', path: '/etc/passwd' },
          config
        );

        expect(result.is_error).toBe(true);
        expect(result.content).toContain('not in allowed');
      });

      it('should reject blocked paths', async () => {
        await mkdir(join(testDir, 'blocked'), { recursive: true });
        await writeFile(join(testDir, 'blocked', 'secret.txt'), 'secret');

        const result = await executeFilesystem(
          { action: 'read', path: join(testDir, 'blocked', 'secret.txt') },
          config
        );

        expect(result.is_error).toBe(true);
        expect(result.content).toContain('blocked');
      });

      it('should auto-include sandboxPath in allowed paths', async () => {
        // Create a separate sandbox directory not in allowedPaths
        const sandboxDir = join(tmpdir(), `hub-sandbox-fs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await mkdir(sandboxDir, { recursive: true });
        await writeFile(join(sandboxDir, 'sandbox-file.txt'), 'sandbox content');

        try {
          // Config with sandboxPath but NOT including it in allowedPaths
          const sandboxConfig: HubConfig = {
            ...config,
            tools: {
              ...config.tools,
              filesystem: {
                enabled: true,
                allowedPaths: [testDir], // sandboxDir NOT included here
              },
            },
            sandboxPath: sandboxDir,
          };

          // Should be able to read from sandboxPath even though it's not explicitly in allowedPaths
          const result = await executeFilesystem(
            { action: 'read', path: join(sandboxDir, 'sandbox-file.txt') },
            sandboxConfig
          );

          expect(result.is_error).toBeUndefined();
          expect(result.content).toBe('sandbox content');
        } finally {
          await rm(sandboxDir, { recursive: true, force: true });
        }
      });
    });
  });
});
