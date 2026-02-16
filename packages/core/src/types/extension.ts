import type { ToolPlugin } from './tools.js';

/**
 * Extension config field types for user configuration
 */
export type ExtensionConfigFieldType = 'secret' | 'string' | 'number' | 'boolean';

export interface ExtensionConfigField {
  type: ExtensionConfigFieldType;
  label: string;
  required?: boolean;
  description?: string;
  default?: string | number | boolean;
}

/**
 * Context passed to extension tool handlers
 */
export interface ExtensionContext {
  /** Configuration values collected during extension installation */
  config: Record<string, unknown>;
  /** Log function that routes output to tool result */
  log: (...args: unknown[]) => void;
  /** Standard fetch function for HTTP requests */
  fetch: typeof fetch;
}

export interface Extension {
  id: string;
  name: string;
  version: string;
  description?: string;
  tools?: ToolPlugin[];
  systemPromptAddition?: string;
  config?: Record<string, ExtensionConfigField>;
}

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  entryUrl?: string;
  builtin?: boolean;
  config?: Record<string, ExtensionConfigField>;
}
