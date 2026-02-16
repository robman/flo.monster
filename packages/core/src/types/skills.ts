import type { HookRulesConfig } from './hooks.js';

/**
 * Skills manifest - metadata and configuration for a skill
 * Based on the Agent Skills standard (agentskills.io)
 */
export interface SkillManifest {
  /** Required: lowercase + hyphens name (e.g., 'commit', 'review-pr') */
  name: string;
  /** Required: helps agent decide when to use the skill */
  description: string;
  /** Optional: tools that are auto-approved when skill is active */
  allowedTools?: string[];
  /** Optional: skill-scoped hooks configuration */
  hooks?: HookRulesConfig;
  /** Optional: other skills required by this skill */
  dependencies?: string[];
  /** Optional: shown in UI (e.g., "[message]") */
  argumentHint?: string;
  /** Optional: if true, only user can invoke via slash command (model cannot auto-invoke) */
  disableModelInvocation?: boolean;
  /** Optional: if false, skill cannot be invoked via /command (default true) */
  userInvocable?: boolean;
  /** Optional: 'system' for built-in reference skills, 'user' for user-installed (default 'user') */
  category?: 'system' | 'user';
  /** Optional: integrity hash for verification (e.g., "sha256-abc123...") */
  integrity?: string;
  /** Optional: required capabilities for this skill to be visible.
   *  'hub' = agent must have hub access, 'browser' = agent must have browser access.
   *  If omitted, skill is always visible. */
  requiredCapabilities?: ('hub' | 'browser')[];
}

/**
 * Stored skill - includes manifest, instructions, and metadata
 */
export interface StoredSkill {
  name: string;
  manifest: SkillManifest;
  /** The instruction text (after YAML frontmatter) with $ARGUMENTS placeholders */
  instructions: string;
  /** Optional scripts bundled with the skill */
  scripts?: Record<string, string>;
  /** Where the skill came from */
  source: {
    type: 'builtin' | 'url' | 'local';
    url?: string;
  };
  /** When the skill was installed (timestamp) */
  installedAt: number;
}

/**
 * Result of invoking a skill
 */
export interface SkillInvocationResult {
  /** The modified prompt with $ARGUMENTS substituted */
  modifiedPrompt: string;
  /** Tools that are auto-approved for this skill invocation */
  allowedTools?: string[];
}
