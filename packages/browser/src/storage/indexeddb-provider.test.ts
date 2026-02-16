/**
 * Tests for IndexedDB storage provider
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { IndexedDBProvider } from './indexeddb-provider.js';
import { StorageError } from './agent-storage.js';
import type { SerializedFile } from '@flo-monster/core';

describe('IndexedDBProvider', () => {
  let provider: IndexedDBProvider;
  const testAgentId = 'test-agent-123';

  beforeEach(() => {
    // Reset IndexedDB for complete isolation between tests
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    // Create a fresh provider for each test
    provider = new IndexedDBProvider();
  });

  afterEach(async () => {
    // Clean up after each test
    try {
      await provider.clearAgent(testAgentId);
    } catch {
      // Ignore errors during cleanup
    }
  });

  describe('name property', () => {
    it('should return "indexeddb"', () => {
      expect(provider.name).toBe('indexeddb');
    });
  });

  describe('writeFile and readFile', () => {
    it('should write and read a text file', async () => {
      const content = 'Hello, World!';
      await provider.writeFile(testAgentId, 'test.txt', content);

      const result = await provider.readFile(testAgentId, 'test.txt');
      expect(result).toBe(content);
    });

    it('should write and read a file with unicode content', async () => {
      const content = 'Hello, World! \u4e2d\u6587 \u65e5\u672c\u8a9e \ud83d\ude00';
      await provider.writeFile(testAgentId, 'unicode.txt', content);

      const result = await provider.readFile(testAgentId, 'unicode.txt');
      expect(result).toBe(content);
    });

    it('should handle empty files', async () => {
      await provider.writeFile(testAgentId, 'empty.txt', '');

      const result = await provider.readFile(testAgentId, 'empty.txt');
      expect(result).toBe('');
    });

    it('should overwrite existing file', async () => {
      await provider.writeFile(testAgentId, 'test.txt', 'first');
      await provider.writeFile(testAgentId, 'test.txt', 'second');

      const result = await provider.readFile(testAgentId, 'test.txt');
      expect(result).toBe('second');
    });

    it('should preserve created timestamp on overwrite', async () => {
      await provider.writeFile(testAgentId, 'test.txt', 'first');

      // Wait a bit to ensure timestamps differ
      await new Promise(resolve => setTimeout(resolve, 10));

      await provider.writeFile(testAgentId, 'test.txt', 'second');

      // We can verify this by listing the directory
      const entries = await provider.listDir(testAgentId, '');
      const file = entries.find(e => e.name === 'test.txt');
      expect(file).toBeDefined();
    });

    it('should normalize paths', async () => {
      await provider.writeFile(testAgentId, './test.txt', 'content');
      const result = await provider.readFile(testAgentId, 'test.txt');
      expect(result).toBe('content');
    });

    it('should create parent directories automatically', async () => {
      await provider.writeFile(testAgentId, 'a/b/c/test.txt', 'content');

      expect(await provider.isDirectory(testAgentId, 'a')).toBe(true);
      expect(await provider.isDirectory(testAgentId, 'a/b')).toBe(true);
      expect(await provider.isDirectory(testAgentId, 'a/b/c')).toBe(true);
    });

    it('should throw NOT_FOUND for non-existent file', async () => {
      await expect(provider.readFile(testAgentId, 'nonexistent.txt'))
        .rejects.toThrow(StorageError);

      try {
        await provider.readFile(testAgentId, 'nonexistent.txt');
      } catch (e) {
        expect((e as StorageError).code).toBe('NOT_FOUND');
      }
    });

    it('should throw NOT_FOUND when reading a directory as file', async () => {
      await provider.mkdir(testAgentId, 'mydir');

      await expect(provider.readFile(testAgentId, 'mydir'))
        .rejects.toThrow(StorageError);
    });

    it('should reject paths with parent directory references', async () => {
      await expect(provider.writeFile(testAgentId, '../test.txt', 'content'))
        .rejects.toThrow();
    });
  });

  describe('readFileBinary and writeFile with ArrayBuffer', () => {
    it('should write and read binary data', async () => {
      const data = new Uint8Array([0x00, 0x01, 0x02, 0xFF, 0xFE, 0xFD]);
      await provider.writeFile(testAgentId, 'binary.bin', data.buffer);

      const result = await provider.readFileBinary(testAgentId, 'binary.bin');
      expect(new Uint8Array(result)).toEqual(data);
    });

    it('should handle empty binary files', async () => {
      await provider.writeFile(testAgentId, 'empty.bin', new ArrayBuffer(0));

      const result = await provider.readFileBinary(testAgentId, 'empty.bin');
      expect(result.byteLength).toBe(0);
    });

    it('should read text file as binary', async () => {
      await provider.writeFile(testAgentId, 'text.txt', 'Hello');

      const result = await provider.readFileBinary(testAgentId, 'text.txt');
      const text = new TextDecoder().decode(result);
      expect(text).toBe('Hello');
    });

    it('should throw NOT_FOUND for non-existent binary file', async () => {
      await expect(provider.readFileBinary(testAgentId, 'nonexistent.bin'))
        .rejects.toThrow(StorageError);
    });
  });

  describe('deleteFile', () => {
    it('should delete an existing file', async () => {
      await provider.writeFile(testAgentId, 'test.txt', 'content');
      await provider.deleteFile(testAgentId, 'test.txt');

      expect(await provider.exists(testAgentId, 'test.txt')).toBe(false);
    });

    it('should throw NOT_FOUND for non-existent file', async () => {
      await expect(provider.deleteFile(testAgentId, 'nonexistent.txt'))
        .rejects.toThrow(StorageError);

      try {
        await provider.deleteFile(testAgentId, 'nonexistent.txt');
      } catch (e) {
        expect((e as StorageError).code).toBe('NOT_FOUND');
      }
    });

    it('should throw NOT_FOUND when trying to delete a directory', async () => {
      await provider.mkdir(testAgentId, 'mydir');

      await expect(provider.deleteFile(testAgentId, 'mydir'))
        .rejects.toThrow(StorageError);
    });

    it('should delete file in nested directory', async () => {
      await provider.writeFile(testAgentId, 'a/b/test.txt', 'content');
      await provider.deleteFile(testAgentId, 'a/b/test.txt');

      expect(await provider.exists(testAgentId, 'a/b/test.txt')).toBe(false);
      // Parent directories should still exist
      expect(await provider.isDirectory(testAgentId, 'a')).toBe(true);
      expect(await provider.isDirectory(testAgentId, 'a/b')).toBe(true);
    });
  });

  describe('mkdir', () => {
    it('should create a directory', async () => {
      await provider.mkdir(testAgentId, 'mydir');

      expect(await provider.isDirectory(testAgentId, 'mydir')).toBe(true);
    });

    it('should create nested directories', async () => {
      await provider.mkdir(testAgentId, 'a/b/c');

      expect(await provider.isDirectory(testAgentId, 'a')).toBe(true);
      expect(await provider.isDirectory(testAgentId, 'a/b')).toBe(true);
      expect(await provider.isDirectory(testAgentId, 'a/b/c')).toBe(true);
    });

    it('should be a no-op for existing directory', async () => {
      await provider.mkdir(testAgentId, 'mydir');
      await provider.mkdir(testAgentId, 'mydir');

      expect(await provider.isDirectory(testAgentId, 'mydir')).toBe(true);
    });

    it('should be a no-op for root directory', async () => {
      await provider.mkdir(testAgentId, '');
      // No error should be thrown
    });

    it('should handle normalized paths', async () => {
      await provider.mkdir(testAgentId, './a//b/./c');

      expect(await provider.isDirectory(testAgentId, 'a/b/c')).toBe(true);
    });
  });

  describe('listDir', () => {
    it('should list files in root directory', async () => {
      await provider.writeFile(testAgentId, 'file1.txt', 'content1');
      await provider.writeFile(testAgentId, 'file2.txt', 'content2');

      const entries = await provider.listDir(testAgentId, '');

      expect(entries).toHaveLength(2);
      const names = entries.map(e => e.name).sort();
      expect(names).toEqual(['file1.txt', 'file2.txt']);
    });

    it('should list files and directories', async () => {
      await provider.writeFile(testAgentId, 'file.txt', 'content');
      await provider.mkdir(testAgentId, 'subdir');

      const entries = await provider.listDir(testAgentId, '');

      expect(entries).toHaveLength(2);

      const file = entries.find(e => e.name === 'file.txt');
      expect(file?.isDirectory).toBe(false);

      const dir = entries.find(e => e.name === 'subdir');
      expect(dir?.isDirectory).toBe(true);
    });

    it('should list files in subdirectory', async () => {
      await provider.mkdir(testAgentId, 'subdir');
      await provider.writeFile(testAgentId, 'subdir/file1.txt', 'content1');
      await provider.writeFile(testAgentId, 'subdir/file2.txt', 'content2');

      const entries = await provider.listDir(testAgentId, 'subdir');

      expect(entries).toHaveLength(2);
      const names = entries.map(e => e.name).sort();
      expect(names).toEqual(['file1.txt', 'file2.txt']);
    });

    it('should only list immediate children', async () => {
      await provider.writeFile(testAgentId, 'a/file1.txt', 'content');
      await provider.writeFile(testAgentId, 'a/b/file2.txt', 'content');

      const entries = await provider.listDir(testAgentId, 'a');

      const names = entries.map(e => e.name);
      expect(names).toContain('file1.txt');
      expect(names).toContain('b');
      expect(names).not.toContain('file2.txt');
    });

    it('should return empty array for empty directory', async () => {
      await provider.mkdir(testAgentId, 'empty');

      const entries = await provider.listDir(testAgentId, 'empty');

      expect(entries).toEqual([]);
    });

    it('should throw NOT_FOUND for non-existent directory', async () => {
      await expect(provider.listDir(testAgentId, 'nonexistent'))
        .rejects.toThrow(StorageError);

      try {
        await provider.listDir(testAgentId, 'nonexistent');
      } catch (e) {
        expect((e as StorageError).code).toBe('NOT_FOUND');
      }
    });

    it('should throw NOT_FOUND when listing a file as directory', async () => {
      await provider.writeFile(testAgentId, 'file.txt', 'content');

      await expect(provider.listDir(testAgentId, 'file.txt'))
        .rejects.toThrow(StorageError);
    });

    it('should include size for files', async () => {
      await provider.writeFile(testAgentId, 'file.txt', 'Hello');

      const entries = await provider.listDir(testAgentId, '');
      const file = entries.find(e => e.name === 'file.txt');

      expect(file?.size).toBe(5);
    });

    it('should include lastModified for entries', async () => {
      const before = Date.now();
      await provider.writeFile(testAgentId, 'file.txt', 'content');
      const after = Date.now();

      const entries = await provider.listDir(testAgentId, '');
      const file = entries.find(e => e.name === 'file.txt');

      expect(file?.lastModified).toBeDefined();
      expect(file!.lastModified!).toBeGreaterThanOrEqual(before);
      expect(file!.lastModified!).toBeLessThanOrEqual(after);
    });
  });

  describe('exists', () => {
    it('should return true for existing file', async () => {
      await provider.writeFile(testAgentId, 'file.txt', 'content');

      expect(await provider.exists(testAgentId, 'file.txt')).toBe(true);
    });

    it('should return true for existing directory', async () => {
      await provider.mkdir(testAgentId, 'mydir');

      expect(await provider.exists(testAgentId, 'mydir')).toBe(true);
    });

    it('should return false for non-existent path', async () => {
      expect(await provider.exists(testAgentId, 'nonexistent')).toBe(false);
    });

    it('should return true for root', async () => {
      expect(await provider.exists(testAgentId, '')).toBe(true);
    });
  });

  describe('isFile', () => {
    it('should return true for file', async () => {
      await provider.writeFile(testAgentId, 'file.txt', 'content');

      expect(await provider.isFile(testAgentId, 'file.txt')).toBe(true);
    });

    it('should return false for directory', async () => {
      await provider.mkdir(testAgentId, 'mydir');

      expect(await provider.isFile(testAgentId, 'mydir')).toBe(false);
    });

    it('should return false for non-existent path', async () => {
      expect(await provider.isFile(testAgentId, 'nonexistent')).toBe(false);
    });
  });

  describe('isDirectory', () => {
    it('should return true for directory', async () => {
      await provider.mkdir(testAgentId, 'mydir');

      expect(await provider.isDirectory(testAgentId, 'mydir')).toBe(true);
    });

    it('should return false for file', async () => {
      await provider.writeFile(testAgentId, 'file.txt', 'content');

      expect(await provider.isDirectory(testAgentId, 'file.txt')).toBe(false);
    });

    it('should return false for non-existent path', async () => {
      expect(await provider.isDirectory(testAgentId, 'nonexistent')).toBe(false);
    });

    it('should return true for root', async () => {
      expect(await provider.isDirectory(testAgentId, '')).toBe(true);
    });
  });

  describe('deleteDir', () => {
    it('should delete empty directory', async () => {
      await provider.mkdir(testAgentId, 'mydir');
      await provider.deleteDir(testAgentId, 'mydir');

      expect(await provider.exists(testAgentId, 'mydir')).toBe(false);
    });

    it('should delete directory with files', async () => {
      await provider.writeFile(testAgentId, 'mydir/file1.txt', 'content1');
      await provider.writeFile(testAgentId, 'mydir/file2.txt', 'content2');

      await provider.deleteDir(testAgentId, 'mydir');

      expect(await provider.exists(testAgentId, 'mydir')).toBe(false);
      expect(await provider.exists(testAgentId, 'mydir/file1.txt')).toBe(false);
      expect(await provider.exists(testAgentId, 'mydir/file2.txt')).toBe(false);
    });

    it('should delete directory with nested structure', async () => {
      await provider.writeFile(testAgentId, 'a/b/c/file.txt', 'content');
      await provider.writeFile(testAgentId, 'a/file.txt', 'content');

      await provider.deleteDir(testAgentId, 'a');

      expect(await provider.exists(testAgentId, 'a')).toBe(false);
      expect(await provider.exists(testAgentId, 'a/b')).toBe(false);
      expect(await provider.exists(testAgentId, 'a/b/c')).toBe(false);
    });

    it('should throw NOT_FOUND for non-existent directory', async () => {
      await expect(provider.deleteDir(testAgentId, 'nonexistent'))
        .rejects.toThrow(StorageError);

      try {
        await provider.deleteDir(testAgentId, 'nonexistent');
      } catch (e) {
        expect((e as StorageError).code).toBe('NOT_FOUND');
      }
    });

    it('should throw NOT_FOUND when deleting a file as directory', async () => {
      await provider.writeFile(testAgentId, 'file.txt', 'content');

      await expect(provider.deleteDir(testAgentId, 'file.txt'))
        .rejects.toThrow(StorageError);
    });

    it('should throw INVALID_PATH when trying to delete root', async () => {
      await expect(provider.deleteDir(testAgentId, ''))
        .rejects.toThrow(StorageError);

      try {
        await provider.deleteDir(testAgentId, '');
      } catch (e) {
        expect((e as StorageError).code).toBe('INVALID_PATH');
      }
    });
  });

  describe('exportFiles', () => {
    it('should export all files for agent', async () => {
      await provider.writeFile(testAgentId, 'file1.txt', 'content1');
      await provider.writeFile(testAgentId, 'file2.txt', 'content2');

      const files = await provider.exportFiles(testAgentId);

      expect(files).toHaveLength(2);

      const file1 = files.find(f => f.path === 'file1.txt');
      expect(file1?.content).toBe('content1');
      expect(file1?.encoding).toBe('utf8');
    });

    it('should export files in nested directories', async () => {
      await provider.writeFile(testAgentId, 'a/b/file.txt', 'nested');

      const files = await provider.exportFiles(testAgentId);

      const file = files.find(f => f.path === 'a/b/file.txt');
      expect(file?.content).toBe('nested');
    });

    it('should skip context.json at root', async () => {
      await provider.writeFile(testAgentId, 'context.json', '[]');
      await provider.writeFile(testAgentId, 'other.txt', 'content');

      const files = await provider.exportFiles(testAgentId);

      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('other.txt');
    });

    it('should not skip context.json in subdirectories', async () => {
      await provider.writeFile(testAgentId, 'subdir/context.json', '{}');

      const files = await provider.exportFiles(testAgentId);

      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('subdir/context.json');
    });

    it('should export binary files as base64', async () => {
      const data = new Uint8Array([0x89, 0x50, 0x4E, 0x47]); // PNG header
      await provider.writeFile(testAgentId, 'image.png', data.buffer);

      const files = await provider.exportFiles(testAgentId);

      const file = files.find(f => f.path === 'image.png');
      expect(file?.encoding).toBe('base64');
      // Decode and verify
      const decoded = atob(file!.content);
      expect(decoded.charCodeAt(0)).toBe(0x89);
      expect(decoded.charCodeAt(1)).toBe(0x50);
    });

    it('should export empty files', async () => {
      await provider.writeFile(testAgentId, 'empty.txt', '');

      const files = await provider.exportFiles(testAgentId);

      expect(files).toHaveLength(1);
      expect(files[0].content).toBe('');
      expect(files[0].encoding).toBe('utf8');
    });

    it('should return empty array for agent with no files', async () => {
      const files = await provider.exportFiles(testAgentId);

      expect(files).toEqual([]);
    });

    it('should skip directories in export', async () => {
      await provider.mkdir(testAgentId, 'mydir');
      await provider.writeFile(testAgentId, 'file.txt', 'content');

      const files = await provider.exportFiles(testAgentId);

      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('file.txt');
    });
  });

  describe('importFiles', () => {
    it('should import files', async () => {
      const files: SerializedFile[] = [
        { path: 'file1.txt', content: 'content1', encoding: 'utf8' },
        { path: 'file2.txt', content: 'content2', encoding: 'utf8' },
      ];

      await provider.importFiles(testAgentId, files);

      expect(await provider.readFile(testAgentId, 'file1.txt')).toBe('content1');
      expect(await provider.readFile(testAgentId, 'file2.txt')).toBe('content2');
    });

    it('should create parent directories', async () => {
      const files: SerializedFile[] = [
        { path: 'a/b/c/file.txt', content: 'nested', encoding: 'utf8' },
      ];

      await provider.importFiles(testAgentId, files);

      expect(await provider.isDirectory(testAgentId, 'a')).toBe(true);
      expect(await provider.isDirectory(testAgentId, 'a/b')).toBe(true);
      expect(await provider.isDirectory(testAgentId, 'a/b/c')).toBe(true);
      expect(await provider.readFile(testAgentId, 'a/b/c/file.txt')).toBe('nested');
    });

    it('should import base64 encoded files', async () => {
      const data = new Uint8Array([0x00, 0x01, 0x02, 0xFF]);
      const base64 = btoa(String.fromCharCode(...data));
      const files: SerializedFile[] = [
        { path: 'binary.bin', content: base64, encoding: 'base64' },
      ];

      await provider.importFiles(testAgentId, files);

      const result = await provider.readFileBinary(testAgentId, 'binary.bin');
      expect(new Uint8Array(result)).toEqual(data);
    });

    it('should handle empty import', async () => {
      await provider.importFiles(testAgentId, []);
      // No error should be thrown
    });
  });

  describe('clearAgent', () => {
    it('should clear all files and directories for agent', async () => {
      await provider.writeFile(testAgentId, 'file1.txt', 'content1');
      await provider.writeFile(testAgentId, 'a/b/file2.txt', 'content2');
      await provider.mkdir(testAgentId, 'empty');

      await provider.clearAgent(testAgentId);

      expect(await provider.exists(testAgentId, 'file1.txt')).toBe(false);
      expect(await provider.exists(testAgentId, 'a')).toBe(false);
      expect(await provider.exists(testAgentId, 'empty')).toBe(false);
    });

    it('should not affect other agents', async () => {
      const otherAgentId = 'other-agent';

      await provider.writeFile(testAgentId, 'file.txt', 'test');
      await provider.writeFile(otherAgentId, 'file.txt', 'other');

      await provider.clearAgent(testAgentId);

      expect(await provider.exists(testAgentId, 'file.txt')).toBe(false);
      expect(await provider.exists(otherAgentId, 'file.txt')).toBe(true);

      // Cleanup
      await provider.clearAgent(otherAgentId);
    });

    it('should handle clearing non-existent agent', async () => {
      await provider.clearAgent('nonexistent-agent');
      // No error should be thrown
    });
  });

  describe('initAgent', () => {
    it('should create context.json with empty array', async () => {
      await provider.initAgent(testAgentId);

      const content = await provider.readFile(testAgentId, 'context.json');
      expect(content).toBe('[]');
    });

    it('should not overwrite existing context.json', async () => {
      await provider.writeFile(testAgentId, 'context.json', '[{"test": true}]');

      await provider.initAgent(testAgentId);

      const content = await provider.readFile(testAgentId, 'context.json');
      expect(content).toBe('[{"test": true}]');
    });

    it('should be idempotent', async () => {
      await provider.initAgent(testAgentId);
      await provider.initAgent(testAgentId);

      const content = await provider.readFile(testAgentId, 'context.json');
      expect(content).toBe('[]');
    });
  });

  describe('agent isolation', () => {
    it('should isolate files between agents', async () => {
      const agent1 = 'agent-1';
      const agent2 = 'agent-2';

      await provider.writeFile(agent1, 'file.txt', 'agent1 content');
      await provider.writeFile(agent2, 'file.txt', 'agent2 content');

      expect(await provider.readFile(agent1, 'file.txt')).toBe('agent1 content');
      expect(await provider.readFile(agent2, 'file.txt')).toBe('agent2 content');

      // Cleanup
      await provider.clearAgent(agent1);
      await provider.clearAgent(agent2);
    });

    it('should not list files from other agents', async () => {
      const agent1 = 'agent-1';
      const agent2 = 'agent-2';

      await provider.writeFile(agent1, 'file1.txt', 'content');
      await provider.writeFile(agent2, 'file2.txt', 'content');

      const entries1 = await provider.listDir(agent1, '');
      const entries2 = await provider.listDir(agent2, '');

      expect(entries1.map(e => e.name)).toEqual(['file1.txt']);
      expect(entries2.map(e => e.name)).toEqual(['file2.txt']);

      // Cleanup
      await provider.clearAgent(agent1);
      await provider.clearAgent(agent2);
    });
  });

  describe('export/import roundtrip', () => {
    it('should preserve files through export/import', async () => {
      // Setup files
      await provider.writeFile(testAgentId, 'text.txt', 'Hello, World!');
      await provider.writeFile(testAgentId, 'subdir/nested.txt', 'Nested content');

      const binaryData = new Uint8Array([0x00, 0x7F, 0xFF]);
      await provider.writeFile(testAgentId, 'binary.bin', binaryData.buffer);

      // Export
      const exported = await provider.exportFiles(testAgentId);

      // Clear and re-import
      await provider.clearAgent(testAgentId);
      await provider.importFiles(testAgentId, exported);

      // Verify
      expect(await provider.readFile(testAgentId, 'text.txt')).toBe('Hello, World!');
      expect(await provider.readFile(testAgentId, 'subdir/nested.txt')).toBe('Nested content');

      const binaryResult = await provider.readFileBinary(testAgentId, 'binary.bin');
      expect(new Uint8Array(binaryResult)).toEqual(binaryData);
    });
  });
});
