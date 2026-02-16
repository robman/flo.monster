/**
 * Agent template types - reusable agent configurations as "apps"
 */

import type { NetworkPolicy } from './agent.js';
import type { SerializedFile } from '../session/serialization.js';

/**
 * Storage snapshot - key-value pairs captured from an agent's IndexedDB storage
 */
export interface StorageSnapshot {
  keys: Array<{ key: string; value: unknown }>;
  capturedAt: number;
}

/**
 * Reference to a skill for template dependencies
 */
export interface SkillReference {
  name: string;
  url?: string;
  required?: boolean;  // default true
}

/**
 * Reference to an extension for template dependencies
 */
export interface ExtensionReference {
  id: string;
  url?: string;
  required?: boolean;  // default true
}

/**
 * Agent template manifest - defines a reusable agent configuration
 */
export interface AgentTemplateManifest {
  /** Template name (displayed in UI) */
  name: string;
  /** Semantic version */
  version: string;
  /** Brief description of what the template does */
  description: string;

  /** Agent configuration defaults */
  config: {
    systemPrompt?: string;
    model?: string;
    maxTokens?: number;
    tokenBudget?: number;
    costBudgetUsd?: number;
    networkPolicy?: NetworkPolicy;
    tools?: string[];
  };

  /** Template dependencies */
  dependencies?: {
    skills?: SkillReference[];
    extensions?: ExtensionReference[];
  };

  /** Author information */
  author?: string;
  /** License identifier (e.g., MIT, Apache-2.0) */
  license?: string;
  /** Tags for categorization and search */
  tags?: string[];
  /** Icon URL or base64 data URI */
  icon?: string;

  /** Entry point customization */
  entryPoints?: {
    /** Path to srcdoc HTML file in zip (default: "srcdoc.html") */
    srcdoc?: string;
    /** Path to files directory in zip (default: "files/") */
    files?: string;
    /** Path to storage snapshot file in zip (e.g., 'storage/snapshot.json') */
    storage?: string;
  };
}

/**
 * Stored template in the template manager
 */
export interface StoredTemplate {
  manifest: AgentTemplateManifest;
  /** Custom srcdoc HTML (if provided) */
  srcdoc?: string;
  /** Initial OPFS files */
  files: SerializedFile[];
  /** Where this template was installed from */
  source: { type: 'builtin' | 'url' | 'local'; url?: string };
  /** When the template was installed */
  installedAt: number;
  /** Storage snapshot to restore when creating agent from template */
  storageSnapshot?: StorageSnapshot;
}
