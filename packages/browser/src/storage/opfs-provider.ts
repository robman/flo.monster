/**
 * OPFS (Origin Private File System) storage provider.
 * Provides isolated file storage for each agent using the browser's OPFS API.
 */

import type { AgentStorageProvider, StorageEntry } from './agent-storage.js';
import type { SerializedFile } from '@flo-monster/core';
import { StorageError } from './agent-storage.js';
import { normalizePath, getFileName, getParentPath } from './path-utils.js';

/**
 * Binary file extensions that should be encoded as base64
 */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico',
  '.pdf', '.zip', '.tar', '.gz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.wasm', '.bin'
]);

/**
 * Check if a file path represents a binary file based on extension
 */
function isBinaryFile(path: string): boolean {
  const lowerPath = path.toLowerCase();
  for (const ext of BINARY_EXTENSIONS) {
    if (lowerPath.endsWith(ext)) {
      return true;
    }
  }
  return false;
}

export class OPFSProvider implements AgentStorageProvider {
  readonly name = 'opfs' as const;

  /**
   * Get the OPFS root directory handle
   */
  private async getRoot(): Promise<FileSystemDirectoryHandle> {
    return navigator.storage.getDirectory();
  }

  /**
   * Get or create an agent's root directory
   */
  private async getAgentDir(agentId: string, create: boolean = false): Promise<FileSystemDirectoryHandle> {
    const root = await this.getRoot();
    const dirName = `agent-${agentId}`;
    try {
      return await root.getDirectoryHandle(dirName, { create });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'NotFoundError') {
        throw new StorageError(`Agent directory not found: ${agentId}`, 'NOT_FOUND');
      }
      throw this.wrapError(e, `Failed to get agent directory: ${agentId}`);
    }
  }

  /**
   * Navigate to a directory by path segments, optionally creating directories along the way
   */
  private async navigateToDir(
    root: FileSystemDirectoryHandle,
    segments: string[],
    create: boolean = false
  ): Promise<FileSystemDirectoryHandle> {
    let current = root;
    for (const segment of segments) {
      try {
        current = await current.getDirectoryHandle(segment, { create });
      } catch (e) {
        if (e instanceof DOMException && e.name === 'NotFoundError') {
          throw new StorageError(`Directory not found: ${segments.join('/')}`, 'NOT_FOUND');
        }
        if (e instanceof DOMException && e.name === 'TypeMismatchError') {
          throw new StorageError(`Path is not a directory: ${segments.join('/')}`, 'INVALID_PATH');
        }
        throw this.wrapError(e, `Failed to navigate to directory: ${segments.join('/')}`);
      }
    }
    return current;
  }

  /**
   * Get a file handle at the given path
   */
  private async getFileHandle(
    agentId: string,
    path: string,
    create: boolean = false
  ): Promise<FileSystemFileHandle> {
    const normalized = normalizePath(path);
    if (normalized === '') {
      throw new StorageError('Cannot get file handle for empty path', 'INVALID_PATH');
    }

    const agentDir = await this.getAgentDir(agentId, create);
    const parentPath = getParentPath(normalized);
    const fileName = getFileName(normalized);

    // Navigate to parent directory
    const parentDir = parentPath
      ? await this.navigateToDir(agentDir, parentPath.split('/'), create)
      : agentDir;

    try {
      return await parentDir.getFileHandle(fileName, { create });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'NotFoundError') {
        throw new StorageError(`File not found: ${path}`, 'NOT_FOUND');
      }
      if (e instanceof DOMException && e.name === 'TypeMismatchError') {
        throw new StorageError(`Path is a directory, not a file: ${path}`, 'INVALID_PATH');
      }
      throw this.wrapError(e, `Failed to get file handle: ${path}`);
    }
  }

  /**
   * Wrap an error in a StorageError with appropriate code
   */
  private wrapError(e: unknown, message: string): StorageError {
    if (e instanceof StorageError) {
      return e;
    }
    if (e instanceof DOMException) {
      if (e.name === 'QuotaExceededError') {
        return new StorageError(`${message}: Quota exceeded`, 'QUOTA_EXCEEDED');
      }
      if (e.name === 'NotFoundError') {
        return new StorageError(`${message}: Not found`, 'NOT_FOUND');
      }
      if (e.name === 'InvalidStateError' || e.name === 'TypeMismatchError') {
        return new StorageError(`${message}: Invalid path`, 'INVALID_PATH');
      }
    }
    const errMsg = e instanceof Error ? e.message : String(e);
    return new StorageError(`${message}: ${errMsg}`, 'UNKNOWN');
  }

  async readFile(agentId: string, path: string): Promise<string> {
    const fileHandle = await this.getFileHandle(agentId, path, false);
    try {
      const file = await fileHandle.getFile();
      return await file.text();
    } catch (e) {
      throw this.wrapError(e, `Failed to read file: ${path}`);
    }
  }

  async readFileBinary(agentId: string, path: string): Promise<ArrayBuffer> {
    const fileHandle = await this.getFileHandle(agentId, path, false);
    try {
      const file = await fileHandle.getFile();
      return await file.arrayBuffer();
    } catch (e) {
      throw this.wrapError(e, `Failed to read file: ${path}`);
    }
  }

  async writeFile(agentId: string, path: string, content: string | ArrayBuffer): Promise<void> {
    const fileHandle = await this.getFileHandle(agentId, path, true);
    try {
      const writable = await fileHandle.createWritable();
      try {
        await writable.write(content);
      } finally {
        await writable.close();
      }
    } catch (e) {
      throw this.wrapError(e, `Failed to write file: ${path}`);
    }
  }

  async deleteFile(agentId: string, path: string): Promise<void> {
    const normalized = normalizePath(path);
    if (normalized === '') {
      throw new StorageError('Cannot delete empty path', 'INVALID_PATH');
    }

    const agentDir = await this.getAgentDir(agentId, false);
    const parentPath = getParentPath(normalized);
    const fileName = getFileName(normalized);

    // Navigate to parent directory
    const parentDir = parentPath
      ? await this.navigateToDir(agentDir, parentPath.split('/'), false)
      : agentDir;

    try {
      await parentDir.removeEntry(fileName);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'NotFoundError') {
        throw new StorageError(`File not found: ${path}`, 'NOT_FOUND');
      }
      throw this.wrapError(e, `Failed to delete file: ${path}`);
    }
  }

  async mkdir(agentId: string, path: string): Promise<void> {
    const normalized = normalizePath(path);
    if (normalized === '') {
      // Creating the root is a no-op since it already exists
      await this.getAgentDir(agentId, true);
      return;
    }

    const agentDir = await this.getAgentDir(agentId, true);
    const segments = normalized.split('/');

    // Create all directories along the path
    await this.navigateToDir(agentDir, segments, true);
  }

  async listDir(agentId: string, path: string): Promise<StorageEntry[]> {
    const normalized = normalizePath(path);
    const agentDir = await this.getAgentDir(agentId, false);

    // Get the target directory
    const targetDir = normalized
      ? await this.navigateToDir(agentDir, normalized.split('/'), false)
      : agentDir;

    const entries: StorageEntry[] = [];

    try {
      // Use 'as any' to work around TypeScript lib types not including entries()
      for await (const handle of (targetDir as any).values()) {
        const name = handle.name as string;
        const entryPath = normalized ? `${normalized}/${name}` : name;
        const isDirectory = handle.kind === 'directory';

        const entry: StorageEntry = {
          path: entryPath,
          name,
          isDirectory,
        };

        // Get file metadata for files
        if (!isDirectory) {
          try {
            const file = await (handle as FileSystemFileHandle).getFile();
            entry.size = file.size;
            entry.lastModified = file.lastModified;
          } catch {
            // Ignore metadata errors - file might have been deleted
          }
        }

        entries.push(entry);
      }
    } catch (e) {
      throw this.wrapError(e, `Failed to list directory: ${path}`);
    }

    return entries;
  }

  async exists(agentId: string, path: string): Promise<boolean> {
    const normalized = normalizePath(path);

    try {
      const agentDir = await this.getAgentDir(agentId, false);

      if (normalized === '') {
        // Agent directory exists
        return true;
      }

      const segments = normalized.split('/');
      const parentSegments = segments.slice(0, -1);
      const targetName = segments[segments.length - 1];

      // Navigate to parent directory
      const parentDir = parentSegments.length > 0
        ? await this.navigateToDir(agentDir, parentSegments, false)
        : agentDir;

      // Check if target exists (as file or directory)
      try {
        await parentDir.getFileHandle(targetName);
        return true;
      } catch {
        try {
          await parentDir.getDirectoryHandle(targetName);
          return true;
        } catch {
          return false;
        }
      }
    } catch (e) {
      if (e instanceof StorageError && e.code === 'NOT_FOUND') {
        return false;
      }
      throw e;
    }
  }

  async isFile(agentId: string, path: string): Promise<boolean> {
    const normalized = normalizePath(path);
    if (normalized === '') {
      return false; // Root is a directory
    }

    try {
      const agentDir = await this.getAgentDir(agentId, false);
      const segments = normalized.split('/');
      const parentSegments = segments.slice(0, -1);
      const targetName = segments[segments.length - 1];

      const parentDir = parentSegments.length > 0
        ? await this.navigateToDir(agentDir, parentSegments, false)
        : agentDir;

      await parentDir.getFileHandle(targetName);
      return true;
    } catch {
      return false;
    }
  }

  async isDirectory(agentId: string, path: string): Promise<boolean> {
    const normalized = normalizePath(path);

    try {
      const agentDir = await this.getAgentDir(agentId, false);

      if (normalized === '') {
        return true; // Root is always a directory
      }

      const segments = normalized.split('/');
      const parentSegments = segments.slice(0, -1);
      const targetName = segments[segments.length - 1];

      const parentDir = parentSegments.length > 0
        ? await this.navigateToDir(agentDir, parentSegments, false)
        : agentDir;

      await parentDir.getDirectoryHandle(targetName);
      return true;
    } catch {
      return false;
    }
  }

  async deleteDir(agentId: string, path: string): Promise<void> {
    const normalized = normalizePath(path);
    if (normalized === '') {
      throw new StorageError('Cannot delete agent root directory, use clearAgent instead', 'INVALID_PATH');
    }

    const agentDir = await this.getAgentDir(agentId, false);
    const parentPath = getParentPath(normalized);
    const dirName = getFileName(normalized);

    const parentDir = parentPath
      ? await this.navigateToDir(agentDir, parentPath.split('/'), false)
      : agentDir;

    try {
      await parentDir.removeEntry(dirName, { recursive: true });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'NotFoundError') {
        throw new StorageError(`Directory not found: ${path}`, 'NOT_FOUND');
      }
      throw this.wrapError(e, `Failed to delete directory: ${path}`);
    }
  }

  /**
   * Recursively collect all files in a directory
   */
  private async collectFiles(
    dir: FileSystemDirectoryHandle,
    basePath: string,
    files: SerializedFile[],
    skipContextJson: boolean = false
  ): Promise<void> {
    // Use 'as any' to work around TypeScript lib types not including entries()
    for await (const handle of (dir as any).values()) {
      const name = handle.name as string;
      const entryPath = basePath ? `${basePath}/${name}` : name;

      if (handle.kind === 'directory') {
        await this.collectFiles(handle as FileSystemDirectoryHandle, entryPath, files, false);
      } else {
        // Skip context.json at root level
        if (skipContextJson && basePath === '' && name === 'context.json') {
          continue;
        }

        try {
          const file = await (handle as FileSystemFileHandle).getFile();
          const isBinary = isBinaryFile(name);

          if (isBinary) {
            const buffer = await file.arrayBuffer();
            const bytes = new Uint8Array(buffer);
            // Convert to base64
            let binary = '';
            for (let i = 0; i < bytes.length; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            files.push({
              path: entryPath,
              content: btoa(binary),
              encoding: 'base64',
            });
          } else {
            const text = await file.text();
            files.push({
              path: entryPath,
              content: text,
              encoding: 'utf8',
            });
          }
        } catch {
          // Skip files that can't be read
        }
      }
    }
  }

  async exportFiles(agentId: string): Promise<SerializedFile[]> {
    try {
      const agentDir = await this.getAgentDir(agentId, false);
      const files: SerializedFile[] = [];
      await this.collectFiles(agentDir, '', files, true);
      return files;
    } catch (e) {
      if (e instanceof StorageError && e.code === 'NOT_FOUND') {
        return [];
      }
      throw e;
    }
  }

  async importFiles(agentId: string, files: SerializedFile[]): Promise<void> {
    // Ensure agent directory exists
    await this.getAgentDir(agentId, true);

    for (const file of files) {
      if (file.encoding === 'base64') {
        // Decode base64 to ArrayBuffer
        const binary = atob(file.content);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        await this.writeFile(agentId, file.path, bytes.buffer);
      } else {
        await this.writeFile(agentId, file.path, file.content);
      }
    }
  }

  async clearAgent(agentId: string): Promise<void> {
    const root = await this.getRoot();
    const dirName = `agent-${agentId}`;

    try {
      await root.removeEntry(dirName, { recursive: true });
    } catch (e) {
      // Ignore if directory doesn't exist
      if (!(e instanceof DOMException && e.name === 'NotFoundError')) {
        throw this.wrapError(e, `Failed to clear agent: ${agentId}`);
      }
    }
  }

  async initAgent(agentId: string): Promise<void> {
    // Create agent directory
    await this.getAgentDir(agentId, true);

    // Initialize context.json with empty array if it doesn't exist
    const contextPath = 'context.json';
    const contextExists = await this.exists(agentId, contextPath);

    if (!contextExists) {
      await this.writeFile(agentId, contextPath, '[]');
    }
  }
}
