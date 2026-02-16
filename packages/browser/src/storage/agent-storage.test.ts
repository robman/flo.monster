import { describe, it, expect } from 'vitest';
import { StorageError } from './agent-storage';

describe('agent-storage', () => {
  describe('StorageError', () => {
    it('should create error with NOT_FOUND code', () => {
      const error = new StorageError('File not found: test.txt', 'NOT_FOUND');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(StorageError);
      expect(error.message).toBe('File not found: test.txt');
      expect(error.code).toBe('NOT_FOUND');
      expect(error.name).toBe('StorageError');
    });

    it('should create error with ALREADY_EXISTS code', () => {
      const error = new StorageError('Directory already exists: data', 'ALREADY_EXISTS');

      expect(error.message).toBe('Directory already exists: data');
      expect(error.code).toBe('ALREADY_EXISTS');
      expect(error.name).toBe('StorageError');
    });

    it('should create error with INVALID_PATH code', () => {
      const error = new StorageError('Invalid path: ../escape', 'INVALID_PATH');

      expect(error.message).toBe('Invalid path: ../escape');
      expect(error.code).toBe('INVALID_PATH');
      expect(error.name).toBe('StorageError');
    });

    it('should create error with QUOTA_EXCEEDED code', () => {
      const error = new StorageError('Storage quota exceeded', 'QUOTA_EXCEEDED');

      expect(error.message).toBe('Storage quota exceeded');
      expect(error.code).toBe('QUOTA_EXCEEDED');
      expect(error.name).toBe('StorageError');
    });

    it('should create error with UNKNOWN code', () => {
      const error = new StorageError('An unexpected error occurred', 'UNKNOWN');

      expect(error.message).toBe('An unexpected error occurred');
      expect(error.code).toBe('UNKNOWN');
      expect(error.name).toBe('StorageError');
    });

    it('should be throwable and catchable', () => {
      const throwError = (): void => {
        throw new StorageError('Test error', 'NOT_FOUND');
      };

      expect(throwError).toThrow(StorageError);
      expect(throwError).toThrow('Test error');
    });

    it('should have correct stack trace', () => {
      const error = new StorageError('Stack trace test', 'UNKNOWN');

      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('StorageError');
    });

    it('should be distinguishable from regular Error', () => {
      const storageError = new StorageError('Storage error', 'NOT_FOUND');
      const regularError = new Error('Regular error');

      expect(storageError instanceof StorageError).toBe(true);
      expect(regularError instanceof StorageError).toBe(false);
    });
  });
});
