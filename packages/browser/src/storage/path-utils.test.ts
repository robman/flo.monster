import { describe, it, expect } from 'vitest';
import { normalizePath, getParentPath, getFileName, validatePath } from './path-utils';

describe('path-utils', () => {
  describe('validatePath', () => {
    it('should accept valid paths', () => {
      expect(() => validatePath('')).not.toThrow();
      expect(() => validatePath('foo')).not.toThrow();
      expect(() => validatePath('foo/bar')).not.toThrow();
      expect(() => validatePath('foo/bar/baz.txt')).not.toThrow();
      expect(() => validatePath('.')).not.toThrow();
      expect(() => validatePath('./foo')).not.toThrow();
    });

    it('should reject paths with null bytes', () => {
      expect(() => validatePath('foo\0bar')).toThrow('Invalid path: null bytes are not allowed');
      expect(() => validatePath('\0')).toThrow('Invalid path: null bytes are not allowed');
      expect(() => validatePath('foo/bar\0/baz')).toThrow('Invalid path: null bytes are not allowed');
    });

    it('should reject paths with parent directory references', () => {
      expect(() => validatePath('..')).toThrow('Invalid path: parent directory references (..) are not allowed');
      expect(() => validatePath('../foo')).toThrow('Invalid path: parent directory references (..) are not allowed');
      expect(() => validatePath('foo/..')).toThrow('Invalid path: parent directory references (..) are not allowed');
      expect(() => validatePath('foo/../bar')).toThrow('Invalid path: parent directory references (..) are not allowed');
      expect(() => validatePath('foo/bar/../baz')).toThrow('Invalid path: parent directory references (..) are not allowed');
    });

    it('should allow ... (three dots) as it is not a parent reference', () => {
      expect(() => validatePath('...')).not.toThrow();
      expect(() => validatePath('foo/...')).not.toThrow();
      expect(() => validatePath('.../foo')).not.toThrow();
    });
  });

  describe('normalizePath', () => {
    it('should return empty string for root paths', () => {
      expect(normalizePath('')).toBe('');
      expect(normalizePath('/')).toBe('');
      expect(normalizePath('.')).toBe('');
      expect(normalizePath('./')).toBe('');
      expect(normalizePath('/.')).toBe('');
      expect(normalizePath('./.')).toBe('');
    });

    it('should remove leading and trailing slashes', () => {
      expect(normalizePath('/foo')).toBe('foo');
      expect(normalizePath('foo/')).toBe('foo');
      expect(normalizePath('/foo/')).toBe('foo');
      expect(normalizePath('/foo/bar/')).toBe('foo/bar');
    });

    it('should collapse multiple consecutive slashes', () => {
      expect(normalizePath('foo//bar')).toBe('foo/bar');
      expect(normalizePath('foo///bar')).toBe('foo/bar');
      expect(normalizePath('//foo//bar//')).toBe('foo/bar');
      expect(normalizePath('foo////bar////baz')).toBe('foo/bar/baz');
    });

    it('should remove . segments', () => {
      expect(normalizePath('./foo')).toBe('foo');
      expect(normalizePath('foo/./bar')).toBe('foo/bar');
      expect(normalizePath('./foo/./bar/.')).toBe('foo/bar');
      expect(normalizePath('foo/././bar')).toBe('foo/bar');
    });

    it('should handle complex normalization cases', () => {
      expect(normalizePath('///./foo/./bar//baz/./')).toBe('foo/bar/baz');
      expect(normalizePath('./././')).toBe('');
      expect(normalizePath('/./')).toBe('');
    });

    it('should preserve valid nested paths', () => {
      expect(normalizePath('foo/bar')).toBe('foo/bar');
      expect(normalizePath('foo/bar/baz')).toBe('foo/bar/baz');
      expect(normalizePath('a/b/c/d/e')).toBe('a/b/c/d/e');
    });

    it('should reject paths with null bytes', () => {
      expect(() => normalizePath('foo\0bar')).toThrow('Invalid path: null bytes are not allowed');
    });

    it('should reject paths with parent directory references', () => {
      expect(() => normalizePath('..')).toThrow('Invalid path: parent directory references (..) are not allowed');
      expect(() => normalizePath('foo/../bar')).toThrow('Invalid path: parent directory references (..) are not allowed');
      expect(() => normalizePath('/foo/..')).toThrow('Invalid path: parent directory references (..) are not allowed');
    });
  });

  describe('getParentPath', () => {
    it('should return empty string for root-level files', () => {
      expect(getParentPath('file.txt')).toBe('');
      expect(getParentPath('/file.txt')).toBe('');
      expect(getParentPath('./file.txt')).toBe('');
    });

    it('should return parent directory for nested paths', () => {
      expect(getParentPath('foo/bar.txt')).toBe('foo');
      expect(getParentPath('foo/bar/baz.txt')).toBe('foo/bar');
      expect(getParentPath('a/b/c/d.txt')).toBe('a/b/c');
    });

    it('should handle paths with leading/trailing slashes', () => {
      expect(getParentPath('/foo/bar.txt')).toBe('foo');
      expect(getParentPath('foo/bar.txt/')).toBe('foo');
      expect(getParentPath('/foo/bar/baz/')).toBe('foo/bar');
    });

    it('should handle paths with . segments', () => {
      expect(getParentPath('./foo/bar.txt')).toBe('foo');
      expect(getParentPath('foo/./bar/baz.txt')).toBe('foo/bar');
    });

    it('should return empty string for empty/root paths', () => {
      expect(getParentPath('')).toBe('');
      expect(getParentPath('/')).toBe('');
      expect(getParentPath('.')).toBe('');
    });
  });

  describe('getFileName', () => {
    it('should extract filename from simple paths', () => {
      expect(getFileName('file.txt')).toBe('file.txt');
      expect(getFileName('document.pdf')).toBe('document.pdf');
    });

    it('should extract filename from nested paths', () => {
      expect(getFileName('foo/bar/file.txt')).toBe('file.txt');
      expect(getFileName('a/b/c/document.pdf')).toBe('document.pdf');
    });

    it('should handle paths with leading/trailing slashes', () => {
      expect(getFileName('/file.txt')).toBe('file.txt');
      expect(getFileName('/foo/bar/file.txt')).toBe('file.txt');
      expect(getFileName('foo/bar/file.txt/')).toBe('file.txt');
    });

    it('should handle paths with . segments', () => {
      expect(getFileName('./file.txt')).toBe('file.txt');
      expect(getFileName('./foo/./bar/file.txt')).toBe('file.txt');
    });

    it('should return empty string for empty/root paths', () => {
      expect(getFileName('')).toBe('');
      expect(getFileName('/')).toBe('');
      expect(getFileName('.')).toBe('');
      expect(getFileName('./')).toBe('');
    });

    it('should handle directory names (no extension)', () => {
      expect(getFileName('foo/bar/baz')).toBe('baz');
      expect(getFileName('mydir')).toBe('mydir');
    });
  });
});
