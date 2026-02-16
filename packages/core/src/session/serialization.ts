/**
 * Session serialization for agent persistence
 */

import type { AgentConfig } from '../types/agent.js';
import type { StoredSkill } from '../types/skills.js';
import type { HookRulesConfig } from '../types/hooks.js';
import type { ExtensionManifest } from '../types/extension.js';

/**
 * Serialized file from OPFS
 */
export interface SerializedFile {
  path: string;
  content: string;  // Base64 for binary files
  encoding: 'utf8' | 'base64';
}

/**
 * Serialized DOM state for capturing agent viewport
 */
export interface SerializedDomState {
  viewportHtml: string;      // innerHTML of #agent-viewport or body
  bodyAttrs?: Record<string, string>;  // Body element attributes (style, class, etc.)
  headHtml?: string;         // innerHTML of <head> (styles, meta, title)
  htmlAttrs?: Record<string, string>;  // <html> element attributes (lang, dir, etc.)
  listeners: SerializedListener[];
  capturedAt: number;
}

/**
 * Serialized event listener registration
 */
export interface SerializedListener {
  selector: string;
  events: string[];
  workerId: string;
  options?: { debounce?: number };
}

/**
 * Session dependencies for skills, extensions, and hooks
 */
export interface SessionDependencies {
  skills: SkillDependency[];
  extensions: ExtensionDependency[];
  hooks?: HookRulesConfig;
}

/**
 * Skill dependency reference
 */
export interface SkillDependency {
  name: string;
  source: { type: 'builtin' | 'url' | 'local'; url?: string };
  inline?: StoredSkill;  // Fallback if resolution fails
}

/**
 * Extension dependency reference
 */
export interface ExtensionDependency {
  id: string;
  source: { type: 'builtin' | 'url'; url?: string };
  inline?: { manifest: ExtensionManifest; systemPromptAddition?: string };
}

/**
 * Session metadata
 */
export interface SessionMetadata {
  createdAt: number;
  serializedAt: number;
  totalTokens: number;
  totalCost: number;
}

/**
 * Serialized session for persistence
 */
export interface SerializedSession {
  version: 1 | 2;
  agentId: string;
  config: AgentConfig;
  conversation: unknown[];  // Message history
  storage: Record<string, unknown>;
  files?: SerializedFile[];  // OPFS contents
  subagents?: SerializedSession[];  // Full tree for hierarchical agents
  metadata: SessionMetadata;

  // v2 fields
  dependencies?: SessionDependencies;
  domState?: SerializedDomState;
}

/**
 * Serialize an agent session for persistence
 */
export function serializeSession(
  agentId: string,
  config: AgentConfig,
  conversation: unknown[],
  storage: Record<string, unknown>,
  metadata: { createdAt: number; totalTokens: number; totalCost: number },
  options?: {
    files?: SerializedFile[];
    subagents?: SerializedSession[];
    dependencies?: SessionDependencies;
    domState?: SerializedDomState;
  },
): SerializedSession {
  return {
    version: 2,
    agentId,
    config,
    conversation,
    storage,
    files: options?.files,
    subagents: options?.subagents,
    metadata: {
      createdAt: metadata.createdAt,
      serializedAt: Date.now(),
      totalTokens: metadata.totalTokens,
      totalCost: metadata.totalCost,
    },
    dependencies: options?.dependencies,
    domState: options?.domState,
  };
}

/**
 * Deserialize a session back to its components
 */
export function deserializeSession(session: SerializedSession): {
  agentId: string;
  config: AgentConfig;
  conversation: unknown[];
  storage: Record<string, unknown>;
  files?: SerializedFile[];
  subagents?: SerializedSession[];
  metadata: SessionMetadata;
  dependencies?: SessionDependencies;
  domState?: SerializedDomState;
} {
  return {
    agentId: session.agentId,
    config: session.config,
    conversation: session.conversation,
    storage: session.storage,
    files: session.files,
    subagents: session.subagents,
    metadata: session.metadata,
    dependencies: session.dependencies,
    domState: session.domState,
  };
}

/**
 * Migrate a v1 session to v2 format
 */
export function migrateSessionV1ToV2(session: SerializedSession): SerializedSession {
  if (session.version === 2) {
    return session;
  }
  return {
    ...session,
    version: 2,
    dependencies: {
      skills: [],
      extensions: [],
    },
  };
}

/**
 * Validate that an unknown value is a valid SerializedSession
 */
export function validateSession(data: unknown): data is SerializedSession {
  if (!data || typeof data !== 'object') {
    return false;
  }

  const obj = data as Record<string, unknown>;

  // Check version (accept both v1 and v2)
  if (obj.version !== 1 && obj.version !== 2) {
    return false;
  }

  // Check required string fields
  if (typeof obj.agentId !== 'string' || obj.agentId.length === 0) {
    return false;
  }

  // Check config is an object
  if (!obj.config || typeof obj.config !== 'object') {
    return false;
  }

  // Check conversation is an array
  if (!Array.isArray(obj.conversation)) {
    return false;
  }

  // Check storage is an object
  if (!obj.storage || typeof obj.storage !== 'object' || Array.isArray(obj.storage)) {
    return false;
  }

  // Check metadata is present and has required fields
  if (!obj.metadata || typeof obj.metadata !== 'object') {
    return false;
  }

  const meta = obj.metadata as Record<string, unknown>;
  if (typeof meta.createdAt !== 'number' ||
      typeof meta.serializedAt !== 'number' ||
      typeof meta.totalTokens !== 'number' ||
      typeof meta.totalCost !== 'number') {
    return false;
  }

  // Files are optional but if present must be an array
  if (obj.files !== undefined && !Array.isArray(obj.files)) {
    return false;
  }

  // Validate each file if present
  if (obj.files) {
    for (const file of obj.files) {
      if (!file || typeof file !== 'object') return false;
      const f = file as Record<string, unknown>;
      if (typeof f.path !== 'string') return false;
      if (typeof f.content !== 'string') return false;
      if (f.encoding !== 'utf8' && f.encoding !== 'base64') return false;
    }
  }

  // Subagents are optional but if present must be an array of valid sessions
  if (obj.subagents !== undefined) {
    if (!Array.isArray(obj.subagents)) {
      return false;
    }
    for (const sub of obj.subagents) {
      if (!validateSession(sub)) {
        return false;
      }
    }
  }

  // v2-specific optional fields validation
  if (obj.version === 2) {
    // dependencies is optional but if present must be valid
    if (obj.dependencies !== undefined) {
      if (!obj.dependencies || typeof obj.dependencies !== 'object') {
        return false;
      }
      const deps = obj.dependencies as Record<string, unknown>;
      if (!Array.isArray(deps.skills) || !Array.isArray(deps.extensions)) {
        return false;
      }
      // Validate skill dependencies
      for (const skill of deps.skills) {
        if (!skill || typeof skill !== 'object') return false;
        const s = skill as Record<string, unknown>;
        if (typeof s.name !== 'string') return false;
        if (!s.source || typeof s.source !== 'object') return false;
        const source = s.source as Record<string, unknown>;
        if (source.type !== 'builtin' && source.type !== 'url' && source.type !== 'local') {
          return false;
        }
      }
      // Validate extension dependencies
      for (const ext of deps.extensions) {
        if (!ext || typeof ext !== 'object') return false;
        const e = ext as Record<string, unknown>;
        if (typeof e.id !== 'string') return false;
        if (!e.source || typeof e.source !== 'object') return false;
        const source = e.source as Record<string, unknown>;
        if (source.type !== 'builtin' && source.type !== 'url') {
          return false;
        }
      }
    }

    // domState is optional but if present must be valid
    if (obj.domState !== undefined) {
      if (!obj.domState || typeof obj.domState !== 'object') {
        return false;
      }
      const dom = obj.domState as Record<string, unknown>;
      if (typeof dom.viewportHtml !== 'string') return false;
      if (!Array.isArray(dom.listeners)) return false;
      if (typeof dom.capturedAt !== 'number') return false;
    }
  }

  return true;
}
