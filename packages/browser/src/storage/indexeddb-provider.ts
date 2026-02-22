/**
 * IndexedDB storage provider with directory emulation.
 * Used as a fallback when OPFS is not fully supported.
 */

import type { AgentStorageProvider, StorageEntry } from './agent-storage.js';
import { StorageError } from './agent-storage.js';
import type { SerializedFile } from '@flo-monster/core';
import { normalizePath, getParentPath, getFileName } from './path-utils.js';

// Database configuration
const DB_NAME = 'flo-agent-files';
const DB_VERSION = 1;
const STORE_NAME = 'files';

/**
 * File entry structure stored in IndexedDB
 * Uses ArrayBuffer for content to ensure compatibility with fake-indexeddb in tests
 */
interface FileEntry {
  agentId: string;
  path: string;           // "subdir/file.txt"
  parentPath: string;     // "subdir" or "" for root
  type: 'file' | 'directory';
  content?: ArrayBuffer;  // ArrayBuffer for binary safety (only for files)
  size?: number;          // File size in bytes (only for files)
  created: number;
  modified: number;
}

/**
 * Binary file extensions - should use base64 encoding when exporting
 */
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg',
  'pdf', 'zip', 'tar', 'gz', 'rar', '7z',
  'mp3', 'wav', 'ogg', 'mp4', 'webm', 'avi',
  'woff', 'woff2', 'ttf', 'eot', 'otf',
  'bin', 'exe', 'dll', 'so', 'dylib',
  'wasm',
]);

/**
 * Check if a path is a binary file based on extension
 */
function isBinaryPath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Convert ArrayBuffer to Base64 string
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Convert Base64 string to ArrayBuffer
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Convert string to ArrayBuffer (UTF-8)
 */
function stringToArrayBuffer(str: string): ArrayBuffer {
  const encoder = new TextEncoder();
  return encoder.encode(str).buffer;
}

/**
 * Convert ArrayBuffer to string (UTF-8)
 */
function arrayBufferToString(buffer: ArrayBuffer): string {
  const decoder = new TextDecoder();
  return decoder.decode(buffer);
}

export class IndexedDBProvider implements AgentStorageProvider {
  readonly name = 'indexeddb' as const;

  private dbPromise: Promise<IDBDatabase> | null = null;

  /**
   * Open the IndexedDB database, creating it if necessary
   */
  private openDB(): Promise<IDBDatabase> {
    if (this.dbPromise) {
      return this.dbPromise;
    }

    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        reject(new Error(`Failed to open IndexedDB: ${request.error?.message}`));
      };

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Create object store with compound key [agentId, path]
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, {
            keyPath: ['agentId', 'path'],
          });

          // Index for listing all entries for an agent
          store.createIndex('byAgent', 'agentId', { unique: false });

          // Index for directory listing (parent path queries)
          store.createIndex('byAgentParent', ['agentId', 'parentPath'], {
            unique: false,
          });
        }
      };
    });

    return this.dbPromise;
  }

  /**
   * Get a single entry by agentId and path
   */
  private async getEntry(agentId: string, path: string): Promise<FileEntry | undefined> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get([agentId, path]);

      request.onsuccess = () => resolve(request.result as FileEntry | undefined);
      request.onerror = () => reject(new Error(`Failed to get entry: ${request.error?.message}`));
    });
  }

  /**
   * Put a single entry into the store
   */
  private async putEntry(entry: FileEntry): Promise<void> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(entry);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(new Error(`Failed to put entry: ${request.error?.message}`));
    });
  }

  /**
   * Delete a single entry from the store
   */
  private async deleteEntry(agentId: string, path: string): Promise<void> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete([agentId, path]);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(new Error(`Failed to delete entry: ${request.error?.message}`));
    });
  }

  /**
   * Query entries by parent path (for directory listing)
   */
  private async queryByParent(agentId: string, parentPath: string): Promise<FileEntry[]> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('byAgentParent');
      const request = index.getAll([agentId, parentPath]);

      request.onsuccess = () => resolve(request.result as FileEntry[]);
      request.onerror = () => reject(new Error(`Failed to query by parent: ${request.error?.message}`));
    });
  }

  /**
   * Query all entries for an agent
   */
  private async queryByAgent(agentId: string): Promise<FileEntry[]> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('byAgent');
      const request = index.getAll(agentId);

      request.onsuccess = () => resolve(request.result as FileEntry[]);
      request.onerror = () => reject(new Error(`Failed to query by agent: ${request.error?.message}`));
    });
  }

  /**
   * Ensure all parent directories exist for a path
   */
  private async ensureParentDirs(agentId: string, path: string): Promise<void> {
    const parentPath = getParentPath(path);
    if (parentPath === '') {
      return; // Root level, no parent dirs needed
    }

    // Build list of directories to create
    const dirsToCreate: string[] = [];
    let currentPath = parentPath;

    while (currentPath !== '') {
      const entry = await this.getEntry(agentId, currentPath);
      if (entry?.type === 'directory') {
        break; // Found existing directory, no need to go further
      }
      dirsToCreate.unshift(currentPath);
      currentPath = getParentPath(currentPath);
    }

    // Create directories from root to leaf
    const now = Date.now();
    for (const dirPath of dirsToCreate) {
      const entry: FileEntry = {
        agentId,
        path: dirPath,
        parentPath: getParentPath(dirPath),
        type: 'directory',
        created: now,
        modified: now,
      };
      await this.putEntry(entry);
    }
  }

  async readFile(agentId: string, path: string): Promise<string> {
    const normalizedPath = normalizePath(path);
    const entry = await this.getEntry(agentId, normalizedPath);

    if (!entry) {
      throw new StorageError(`File not found: ${normalizedPath}`, 'NOT_FOUND');
    }

    if (entry.type !== 'file') {
      throw new StorageError(`Not a file: ${normalizedPath}`, 'NOT_FOUND');
    }

    if (!entry.content || entry.content.byteLength === 0) {
      return '';
    }

    return arrayBufferToString(entry.content);
  }

  async readFileBinary(agentId: string, path: string): Promise<ArrayBuffer> {
    const normalizedPath = normalizePath(path);
    const entry = await this.getEntry(agentId, normalizedPath);

    if (!entry) {
      throw new StorageError(`File not found: ${normalizedPath}`, 'NOT_FOUND');
    }

    if (entry.type !== 'file') {
      throw new StorageError(`Not a file: ${normalizedPath}`, 'NOT_FOUND');
    }

    if (!entry.content) {
      return new ArrayBuffer(0);
    }

    // Return a copy to prevent mutation
    return entry.content.slice(0);
  }

  async writeFile(agentId: string, path: string, content: string | ArrayBuffer): Promise<void> {
    const normalizedPath = normalizePath(path);

    // Ensure parent directories exist
    await this.ensureParentDirs(agentId, normalizedPath);

    // Convert content to ArrayBuffer
    let buffer: ArrayBuffer;
    if (typeof content === 'string') {
      buffer = stringToArrayBuffer(content);
    } else {
      // Make a copy to avoid issues with detached buffers
      buffer = content.slice(0);
    }

    const now = Date.now();
    const existingEntry = await this.getEntry(agentId, normalizedPath);

    const entry: FileEntry = {
      agentId,
      path: normalizedPath,
      parentPath: getParentPath(normalizedPath),
      type: 'file',
      content: buffer,
      size: buffer.byteLength,
      created: existingEntry?.created ?? now,
      modified: now,
    };

    await this.putEntry(entry);
  }

  async deleteFile(agentId: string, path: string): Promise<void> {
    const normalizedPath = normalizePath(path);
    const entry = await this.getEntry(agentId, normalizedPath);

    if (!entry) {
      throw new StorageError(`File not found: ${normalizedPath}`, 'NOT_FOUND');
    }

    if (entry.type !== 'file') {
      throw new StorageError(`Not a file: ${normalizedPath}`, 'NOT_FOUND');
    }

    await this.deleteEntry(agentId, normalizedPath);
  }

  async mkdir(agentId: string, path: string): Promise<void> {
    const normalizedPath = normalizePath(path);

    if (normalizedPath === '') {
      return; // Root directory always exists conceptually
    }

    // Check if already exists
    const existing = await this.getEntry(agentId, normalizedPath);
    if (existing?.type === 'directory') {
      return; // Already exists, no-op
    }

    // Ensure parent directories exist
    await this.ensureParentDirs(agentId, normalizedPath);

    const now = Date.now();
    const entry: FileEntry = {
      agentId,
      path: normalizedPath,
      parentPath: getParentPath(normalizedPath),
      type: 'directory',
      created: now,
      modified: now,
    };

    await this.putEntry(entry);
  }

  async listDir(agentId: string, path: string): Promise<StorageEntry[]> {
    const normalizedPath = normalizePath(path);

    // If not root, verify directory exists
    if (normalizedPath !== '') {
      const dirEntry = await this.getEntry(agentId, normalizedPath);
      if (!dirEntry) {
        throw new StorageError(`Directory not found: ${normalizedPath}`, 'NOT_FOUND');
      }
      if (dirEntry.type !== 'directory') {
        throw new StorageError(`Not a directory: ${normalizedPath}`, 'NOT_FOUND');
      }
    }

    // Query children
    const entries = await this.queryByParent(agentId, normalizedPath);

    // Convert to StorageEntry format
    return entries.map((entry) => {
      const result: StorageEntry = {
        path: entry.path,
        name: getFileName(entry.path),
        isDirectory: entry.type === 'directory',
        lastModified: entry.modified,
      };

      if (entry.type === 'file') {
        result.size = entry.size ?? 0;
      }

      return result;
    });
  }

  async exists(agentId: string, path: string): Promise<boolean> {
    const normalizedPath = normalizePath(path);

    if (normalizedPath === '') {
      return true; // Root always exists
    }

    const entry = await this.getEntry(agentId, normalizedPath);
    return entry !== undefined;
  }

  async isFile(agentId: string, path: string): Promise<boolean> {
    const normalizedPath = normalizePath(path);
    const entry = await this.getEntry(agentId, normalizedPath);
    return entry?.type === 'file';
  }

  async isDirectory(agentId: string, path: string): Promise<boolean> {
    const normalizedPath = normalizePath(path);

    if (normalizedPath === '') {
      return true; // Root is always a directory
    }

    const entry = await this.getEntry(agentId, normalizedPath);
    return entry?.type === 'directory';
  }

  async deleteDir(agentId: string, path: string): Promise<void> {
    const normalizedPath = normalizePath(path);

    if (normalizedPath === '') {
      throw new StorageError('Cannot delete root directory', 'INVALID_PATH');
    }

    const entry = await this.getEntry(agentId, normalizedPath);
    if (!entry) {
      throw new StorageError(`Directory not found: ${normalizedPath}`, 'NOT_FOUND');
    }

    if (entry.type !== 'directory') {
      throw new StorageError(`Not a directory: ${normalizedPath}`, 'NOT_FOUND');
    }

    // Get all entries for this agent and filter those under this directory
    const allEntries = await this.queryByAgent(agentId);
    const pathPrefix = normalizedPath + '/';

    // Collect paths to delete (this directory and all children)
    const pathsToDelete: string[] = [normalizedPath];

    for (const e of allEntries) {
      if (e.path.startsWith(pathPrefix)) {
        pathsToDelete.push(e.path);
      }
    }

    // Delete all entries
    for (const p of pathsToDelete) {
      await this.deleteEntry(agentId, p);
    }
  }

  async exportFiles(agentId: string): Promise<SerializedFile[]> {
    const allEntries = await this.queryByAgent(agentId);
    const result: SerializedFile[] = [];

    for (const entry of allEntries) {
      // Skip directories
      if (entry.type !== 'file') {
        continue;
      }

      if (!entry.content || entry.content.byteLength === 0) {
        // Empty file
        result.push({
          path: entry.path,
          content: '',
          encoding: 'utf8',
        });
        continue;
      }

      // Determine encoding based on file extension
      if (isBinaryPath(entry.path)) {
        result.push({
          path: entry.path,
          content: arrayBufferToBase64(entry.content),
          encoding: 'base64',
        });
      } else {
        result.push({
          path: entry.path,
          content: arrayBufferToString(entry.content),
          encoding: 'utf8',
        });
      }
    }

    return result;
  }

  async importFiles(agentId: string, files: SerializedFile[]): Promise<void> {
    for (const file of files) {
      const normalizedPath = normalizePath(file.path);

      // Ensure parent directories exist
      await this.ensureParentDirs(agentId, normalizedPath);

      // Convert content to ArrayBuffer
      let buffer: ArrayBuffer;
      if (file.encoding === 'base64') {
        buffer = base64ToArrayBuffer(file.content);
      } else {
        buffer = stringToArrayBuffer(file.content);
      }

      const now = Date.now();
      const entry: FileEntry = {
        agentId,
        path: normalizedPath,
        parentPath: getParentPath(normalizedPath),
        type: 'file',
        content: buffer,
        size: buffer.byteLength,
        created: now,
        modified: now,
      };

      await this.putEntry(entry);
    }
  }

  async clearAgent(agentId: string): Promise<void> {
    const allEntries = await this.queryByAgent(agentId);

    for (const entry of allEntries) {
      await this.deleteEntry(agentId, entry.path);
    }
  }

  async initAgent(agentId: string): Promise<void> {
    // Initialize context.json with empty array
    const contextPath = 'context.json';
    const existing = await this.getEntry(agentId, contextPath);

    if (!existing) {
      await this.writeFile(agentId, contextPath, '[]');
    }
  }
}
