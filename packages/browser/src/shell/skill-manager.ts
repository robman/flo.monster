import type { StoredSkill, SkillInvocationResult, HookRulesConfig, SkillDependency } from '@flo-monster/core';
import { parseSkillMd, substituteArguments, computeSkillHash, SkillStore } from '@flo-monster/core';
import type { SkillContext } from '@flo-monster/core';
import type { HookManager } from './hook-manager.js';

/**
 * Manages installed skills - installation, removal, invocation.
 * Wraps SkillStore internally for skill storage, visibility filtering,
 * and usage tracking. Adds browser-specific concerns: URL installation,
 * hook management, and skill invocation with argument substitution.
 */
export class SkillManager {
  private store: SkillStore;
  private activeSkillHookIds = new Map<string, string[]>();  // agentId -> hook registration IDs

  constructor() {
    this.store = new SkillStore();
  }

  /**
   * Install a skill from a URL (fetches SKILL.md)
   */
  async installFromUrl(url: string): Promise<StoredSkill> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch skill from ${url}: ${response.statusText}`);
    }
    const content = await response.text();
    const { manifest, instructions } = parseSkillMd(content);

    // Verify integrity if specified
    if (manifest.integrity) {
      const hash = await computeSkillHash(content);
      if (hash !== manifest.integrity) {
        throw new Error(`Integrity check failed for skill ${manifest.name}: expected ${manifest.integrity}, got ${hash}`);
      }
    }

    const skill: StoredSkill = {
      name: manifest.name,
      manifest,
      instructions,
      source: { type: 'url', url },
      installedAt: Date.now(),
    };

    this.store.register(skill);
    return skill;
  }

  /**
   * Install a builtin skill (from code, not URL)
   */
  installBuiltin(skill: StoredSkill): void {
    this.store.register(skill);
  }

  /**
   * Install system skills (bulk install for built-in reference skills)
   */
  installSystemSkills(skills: StoredSkill[]): void {
    this.store.registerSystemSkills(skills);
  }

  /**
   * Remove a skill by name
   * Returns true if skill was found and removed
   */
  removeSkill(name: string): boolean {
    return this.store.unregister(name);
  }

  /**
   * Get a skill by name
   */
  getSkill(name: string): StoredSkill | undefined {
    return this.store.get(name);
  }

  /**
   * List all installed skills
   */
  listSkills(): StoredSkill[] {
    return this.store.listAll();
  }

  /**
   * Check if a skill is installed
   */
  hasSkill(name: string): boolean {
    return this.store.has(name);
  }

  /**
   * Invoke a skill by name with arguments
   *
   * @param name - Skill name
   * @param args - Arguments string (from after /skill-name in user input)
   * @param agentId - Agent ID (for hook registration)
   * @param hookManager - Optional hook manager for registering skill-scoped hooks
   * @param runtime - 'browser' or 'hub' for runtime-specific overrides
   * @returns Invocation result with modified prompt, or null if skill not found
   */
  invokeSkill(
    name: string,
    args: string,
    agentId: string,
    hookManager?: HookManager,
    runtime: 'browser' | 'hub' = 'browser'
  ): SkillInvocationResult | null {
    const skill = this.store.get(name);
    if (!skill) {
      return null;
    }

    // Check if skill allows user invocation
    if (skill.manifest.userInvocable === false) {
      return null;
    }

    // Track skill usage for this agent
    this.store.trackUsage(agentId, name);

    // Substitute arguments in instructions
    const modifiedPrompt = substituteArguments(skill.instructions, args);

    // Register skill-scoped hooks if present
    if (hookManager && skill.manifest.hooks) {
      this.registerSkillHooks(agentId, skill.manifest.hooks, hookManager);
    }

    // Register auto-approve hook for allowedTools
    if (hookManager && skill.manifest.allowedTools?.length) {
      const toolPattern = skill.manifest.allowedTools.join('|');
      const autoApproveId = `skill-${name}-auto-approve-${agentId}`;
      hookManager.register({
        id: autoApproveId,
        type: 'pre_tool_use',
        priority: 1000,  // High priority - evaluated first
        matcher: { toolNamePattern: `^(${toolPattern})$` },
        callback: async () => ({ decision: 'allow', reason: `Auto-approved by skill ${name}` }),
      });
      // Track for cleanup
      const existingIds = this.activeSkillHookIds.get(agentId) || [];
      this.activeSkillHookIds.set(agentId, [...existingIds, autoApproveId]);
    }

    return {
      modifiedPrompt,
      allowedTools: skill.manifest.allowedTools,
    };
  }

  /**
   * Track that an agent used/loaded a skill (for dependency serialization)
   */
  trackUsage(agentId: string, name: string): void {
    this.store.trackUsage(agentId, name);
  }

  /**
   * Clean up skill hooks for an agent (call on agent_end)
   */
  cleanupAgentHooks(agentId: string, hookManager: HookManager): void {
    const hookIds = this.activeSkillHookIds.get(agentId);
    if (hookIds) {
      for (const id of hookIds) {
        hookManager.unregister(id);
      }
      this.activeSkillHookIds.delete(agentId);
    }
  }

  /**
   * Export skills for persistence
   */
  exportEntries(): StoredSkill[] {
    return this.store.exportUserSkills();
  }

  /**
   * Import skills from persistence
   */
  importEntries(skills: StoredSkill[]): void {
    this.store.importUserSkills(skills);
  }

  /**
   * Get list of user-invocable skills (for /help display)
   */
  listUserInvocableSkills(context?: SkillContext): StoredSkill[] {
    return this.store.listUserInvocable(context);
  }

  /**
   * Get list of agent-visible skills (system skills + user-invocable skills, for list_skills tool)
   */
  listAgentVisibleSkills(agentId?: string, context?: SkillContext): StoredSkill[] {
    return this.store.listAgentVisible(agentId, context);
  }

  /**
   * Get skill dependencies for an agent (for serialization)
   */
  getAgentSkillDependencies(agentId: string): SkillDependency[] {
    return this.store.getAgentDependencies(agentId);
  }

  /**
   * Clear skill usage tracking for an agent
   */
  clearAgentSkillUsage(agentId: string): void {
    return this.store.clearAgentUsage(agentId);
  }

  private registerSkillHooks(
    agentId: string,
    hooks: HookRulesConfig,
    hookManager: HookManager
  ): void {
    // Clear any existing hooks for this agent
    this.cleanupAgentHooks(agentId, hookManager);

    // Register the hooks and get their IDs
    const registeredIds = hookManager.registerFromConfig(hooks);

    // Store the IDs for later cleanup
    this.activeSkillHookIds.set(agentId, registeredIds);
  }
}
