/**
 * Agent storage abstraction module.
 * Provides unified file storage for agents with OPFS and IndexedDB backends.
 */

// Core types and factory
export {
  type StorageEntry,
  type AgentStorageProvider,
  StorageError,
  getStorageProvider,
  supportsOPFSWritable,
  resetStorageProvider,
} from './agent-storage.js';

// Path utilities
export {
  normalizePath,
  getParentPath,
  getFileName,
  validatePath,
} from './path-utils.js';

// Provider implementations (for direct use when needed)
export { OPFSProvider } from './opfs-provider.js';
export { IndexedDBProvider } from './indexeddb-provider.js';
