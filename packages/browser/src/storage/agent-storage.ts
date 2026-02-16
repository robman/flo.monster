/**
 * Storage abstraction interface for agent file operations.
 * Supports OPFS (primary) with IndexedDB fallback for browsers without full OPFS support.
 */

import type { SerializedFile } from '@flo-monster/core';

/**
 * Represents a file or directory entry in storage.
 */
export interface StorageEntry {
  /** Relative path from agent root, e.g., "subdir/file.txt" */
  path: string;
  /** Just the filename or directory name, e.g., "file.txt" */
  name: string;
  /** True if this entry is a directory */
  isDirectory: boolean;
  /** File size in bytes (undefined for directories) */
  size?: number;
  /** Last modification timestamp in milliseconds (undefined if not available) */
  lastModified?: number;
}

/**
 * Error class for storage operations with structured error codes.
 */
export class StorageError extends Error {
  constructor(
    message: string,
    public readonly code: 'NOT_FOUND' | 'ALREADY_EXISTS' | 'INVALID_PATH' | 'QUOTA_EXCEEDED' | 'UNKNOWN'
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

/**
 * Interface for agent storage providers.
 * Each agent gets an isolated storage space identified by agentId.
 */
export interface AgentStorageProvider {
  /** Provider name for logging and debugging */
  readonly name: 'opfs' | 'indexeddb';

  /**
   * Read a file as a UTF-8 string.
   * @throws StorageError with code 'NOT_FOUND' if file does not exist
   */
  readFile(agentId: string, path: string): Promise<string>;

  /**
   * Read a file as binary data.
   * @throws StorageError with code 'NOT_FOUND' if file does not exist
   */
  readFileBinary(agentId: string, path: string): Promise<ArrayBuffer>;

  /**
   * Write content to a file. Creates parent directories if needed.
   * @param content - String content (written as UTF-8) or binary ArrayBuffer
   * @throws StorageError with code 'QUOTA_EXCEEDED' if storage is full
   */
  writeFile(agentId: string, path: string, content: string | ArrayBuffer): Promise<void>;

  /**
   * Delete a file.
   * @throws StorageError with code 'NOT_FOUND' if file does not exist
   */
  deleteFile(agentId: string, path: string): Promise<void>;

  /**
   * Create a directory. Creates parent directories if needed.
   * No-op if directory already exists.
   */
  mkdir(agentId: string, path: string): Promise<void>;

  /**
   * List entries in a directory.
   * @returns Array of StorageEntry objects for immediate children
   * @throws StorageError with code 'NOT_FOUND' if directory does not exist
   */
  listDir(agentId: string, path: string): Promise<StorageEntry[]>;

  /**
   * Check if a path exists (file or directory).
   */
  exists(agentId: string, path: string): Promise<boolean>;

  /**
   * Check if a path exists and is a file.
   */
  isFile(agentId: string, path: string): Promise<boolean>;

  /**
   * Check if a path exists and is a directory.
   */
  isDirectory(agentId: string, path: string): Promise<boolean>;

  /**
   * Delete a directory and all its contents recursively.
   * @throws StorageError with code 'NOT_FOUND' if directory does not exist
   */
  deleteDir(agentId: string, path: string): Promise<void>;

  /**
   * Export all files for an agent as serialized format.
   * Used for session persistence.
   */
  exportFiles(agentId: string): Promise<SerializedFile[]>;

  /**
   * Import files from serialized format.
   * Used for session restoration.
   */
  importFiles(agentId: string, files: SerializedFile[]): Promise<void>;

  /**
   * Clear all storage for an agent.
   */
  clearAgent(agentId: string): Promise<void>;

  /**
   * Initialize storage for an agent.
   * Creates the agent's root directory if it doesn't exist.
   */
  initAgent(agentId: string): Promise<void>;
}

// Cache for OPFS support check
let opfsSupported: boolean | null = null;

/**
 * Check if OPFS with createWritable() is supported.
 * This is required for the OPFS provider to work properly.
 * Results are cached after the first call.
 */
export async function supportsOPFSWritable(): Promise<boolean> {
  // Return cached result if available
  if (opfsSupported !== null) {
    return opfsSupported;
  }

  try {
    // Check if navigator.storage.getDirectory exists
    if (typeof navigator === 'undefined' ||
        !navigator.storage ||
        typeof navigator.storage.getDirectory !== 'function') {
      opfsSupported = false;
      return false;
    }

    // Get OPFS root
    const root = await navigator.storage.getDirectory();

    // Try to create a test file to check for createWritable support
    const testFileName = `.opfs-test-${Date.now()}`;
    const testHandle = await root.getFileHandle(testFileName, { create: true });

    // Check if createWritable is available
    if (typeof testHandle.createWritable !== 'function') {
      // Clean up
      await root.removeEntry(testFileName);
      opfsSupported = false;
      return false;
    }

    // Try to actually use createWritable to ensure it works
    const writable = await testHandle.createWritable();
    await writable.write('test');
    await writable.close();

    // Clean up the test file
    await root.removeEntry(testFileName);

    opfsSupported = true;
    return true;
  } catch {
    // Any error means OPFS is not fully supported
    opfsSupported = false;
    return false;
  }
}

// Cached provider instance
let cachedProvider: AgentStorageProvider | null = null;

/**
 * Get the appropriate storage provider for the current environment.
 * Uses OPFS if available, falls back to IndexedDB otherwise.
 * The provider is cached after first initialization.
 */
export async function getStorageProvider(): Promise<AgentStorageProvider> {
  if (cachedProvider) {
    return cachedProvider;
  }

  if (await supportsOPFSWritable()) {
    console.log('[AgentStorage] Using OPFS provider');
    // Import dynamically to avoid loading unused code
    const { OPFSProvider } = await import('./opfs-provider.js');
    cachedProvider = new OPFSProvider();
  } else {
    console.log('[AgentStorage] Using IndexedDB provider');
    const { IndexedDBProvider } = await import('./indexeddb-provider.js');
    cachedProvider = new IndexedDBProvider();
  }

  return cachedProvider;
}

/**
 * Reset the cached provider (useful for testing).
 */
export function resetStorageProvider(): void {
  cachedProvider = null;
  opfsSupported = null;
}
