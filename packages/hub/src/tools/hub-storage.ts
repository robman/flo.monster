/**
 * Hub-side storage store that mirrors the browser-side storage tool API.
 * Provides key-value storage for hub agents without requiring a browser connection.
 */

import type { ToolDef, ToolResult } from './index.js';

type ChangeCallback = (key: string, value: unknown, action: 'set' | 'delete') => void;

export interface StorageLimits {
  maxKeys: number;       // Max number of keys per agent (default 1000)
  maxValueSize: number;  // Max bytes per value (default 1MB)
  maxTotalSize: number;  // Max total bytes per agent (default 10MB)
}

const DEFAULT_STORAGE_LIMITS: StorageLimits = {
  maxKeys: 1000,
  maxValueSize: 1_000_000,     // 1MB
  maxTotalSize: 10_000_000,    // 10MB
};

export class HubAgentStorageStore {
  private data: Record<string, unknown>;
  private listeners: Set<ChangeCallback> = new Set();
  private limits: StorageLimits;

  constructor(initial?: Record<string, unknown>, limits?: Partial<StorageLimits>) {
    this.data = initial ? { ...initial } : {};
    this.limits = { ...DEFAULT_STORAGE_LIMITS, ...limits };
  }

  get(key: string): unknown {
    return this.data[key];
  }

  set(key: string, value: unknown): { error?: string } {
    // Check key count limit
    if (!(key in this.data) && Object.keys(this.data).length >= this.limits.maxKeys) {
      return { error: `Storage limit exceeded: max ${this.limits.maxKeys} keys` };
    }

    // Check value size limit
    const valueSize = this.estimateSize(value);
    if (valueSize > this.limits.maxValueSize) {
      return { error: `Storage limit exceeded: value size ${valueSize} bytes exceeds max ${this.limits.maxValueSize}` };
    }

    // Check total size limit (approximate — subtract old value if replacing)
    const oldSize = key in this.data ? this.estimateSize(this.data[key]) : 0;
    const newTotal = this.estimateTotalSize() - oldSize + valueSize;
    if (newTotal > this.limits.maxTotalSize) {
      return { error: `Storage limit exceeded: total size would be ${newTotal} bytes (max ${this.limits.maxTotalSize})` };
    }

    this.data[key] = value;
    this.fireChange(key, value, 'set');
    return {};
  }

  delete(key: string): boolean {
    const existed = key in this.data;
    const value = this.data[key];
    delete this.data[key];
    this.fireChange(key, value, 'delete');
    return existed;
  }

  list(): string[] {
    return Object.keys(this.data);
  }

  getAll(): Record<string, unknown> {
    return { ...this.data };
  }

  onChange(cb: ChangeCallback): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  serialize(): Record<string, unknown> {
    return { ...this.data };
  }

  private estimateSize(value: unknown): number {
    return JSON.stringify(value)?.length ?? 0;
  }

  private estimateTotalSize(): number {
    let total = 0;
    for (const v of Object.values(this.data)) {
      total += this.estimateSize(v);
    }
    return total;
  }

  private fireChange(key: string, value: unknown, action: 'set' | 'delete'): void {
    for (const cb of this.listeners) {
      cb(key, value, action);
    }
  }
}

export const hubStorageToolDef: ToolDef = {
  name: 'storage',
  description: 'Key-value storage for persistent data. Store and retrieve data that persists across agent restarts.',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['get', 'set', 'delete', 'list'],
        description: 'Storage action to perform',
      },
      key: {
        type: 'string',
        description: 'Storage key (required for get, set, delete)',
      },
      value: {
        type: 'object',
        description: 'Value to store (any JSON type, required for set)',
      },
    },
    required: ['action'] as const,
  },
};

export function executeHubStorage(
  input: { action: string; key?: string; value?: unknown },
  store: HubAgentStorageStore,
): ToolResult {
  switch (input.action) {
    case 'get': {
      if (!input.key) {
        return { content: 'Missing required parameter: key', is_error: true };
      }
      const value = store.get(input.key);
      if (value === undefined) {
        return { content: 'Key not found' };
      }
      return { content: JSON.stringify(value) };
    }
    case 'set': {
      if (!input.key) {
        return { content: 'Missing required parameter: key', is_error: true };
      }
      const result = store.set(input.key, input.value);
      if (result.error) {
        return { content: result.error, is_error: true };
      }
      return { content: 'Value stored' };
    }
    case 'delete': {
      if (!input.key) {
        return { content: 'Missing required parameter: key', is_error: true };
      }
      const existed = store.delete(input.key);
      return { content: existed ? 'Key deleted' : 'Key not found' };
    }
    case 'list': {
      return { content: JSON.stringify(store.list()) };
    }
    default: {
      return { content: `Unknown storage action: ${input.action}`, is_error: true };
    }
  }
}
