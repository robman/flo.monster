/**
 * SkillStore — pure in-memory skill store with no I/O.
 *
 * Manages skill registration, per-agent visibility filtering,
 * per-agent enable/disable, usage tracking for serialization,
 * and bulk import/export for persistence.
 */

import type { StoredSkill } from '../types/skills.js';
import type { SkillDependency } from '../session/serialization.js';

export interface SkillContext {
  hasHub?: boolean;      // Agent has hub access
  hasBrowser?: boolean;  // Agent has browser access
}

export class SkillStore {
  private skills = new Map<string, StoredSkill>();
  private agentUsage = new Map<string, Set<string>>();      // agentId -> used skill names
  private agentDisabled = new Map<string, Set<string>>();    // agentId -> disabled skill names

  // --- Registration ---

  register(skill: StoredSkill): void {
    this.skills.set(skill.name, skill);
  }

  registerSystemSkills(skills: StoredSkill[]): void {
    for (const skill of skills) {
      this.skills.set(skill.name, skill);
    }
  }

  unregister(name: string): boolean {
    const skill = this.skills.get(name);
    if (skill?.source.type === 'builtin') {
      return false;  // Cannot unregister builtins
    }
    return this.skills.delete(name);
  }

  // --- Lookup ---

  get(name: string): StoredSkill | undefined {
    return this.skills.get(name);
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }

  listAll(): StoredSkill[] {
    return Array.from(this.skills.values());
  }

  // --- Agent-visible listing (for list_skills tool) ---
  // Filters: visibility rules + capability match + not disabled for agent
  listAgentVisible(agentId?: string, context?: SkillContext): StoredSkill[] {
    return this.listAll().filter(skill => {
      // Visibility: system skills OR user-invocable skills
      if (skill.manifest.category !== 'system' && skill.manifest.userInvocable === false) {
        return false;
      }

      // Capability filtering: if skill has requiredCapabilities, ALL must be satisfied
      if (skill.manifest.requiredCapabilities && context) {
        for (const cap of skill.manifest.requiredCapabilities) {
          if (cap === 'hub' && !context.hasHub) return false;
          if (cap === 'browser' && !context.hasBrowser) return false;
        }
      }

      // Per-agent disable check
      if (agentId && this.isDisabledForAgent(agentId, skill.name)) {
        return false;
      }

      return true;
    });
  }

  // --- User-invocable listing (for /help UI display) ---
  listUserInvocable(context?: SkillContext): StoredSkill[] {
    return this.listAll().filter(skill => {
      if (skill.manifest.userInvocable === false) return false;

      // Capability filtering
      if (skill.manifest.requiredCapabilities && context) {
        for (const cap of skill.manifest.requiredCapabilities) {
          if (cap === 'hub' && !context.hasHub) return false;
          if (cap === 'browser' && !context.hasBrowser) return false;
        }
      }

      return true;
    });
  }

  // --- Per-agent enable/disable ---

  disableForAgent(agentId: string, name: string): void {
    let disabled = this.agentDisabled.get(agentId);
    if (!disabled) {
      disabled = new Set();
      this.agentDisabled.set(agentId, disabled);
    }
    disabled.add(name);
  }

  enableForAgent(agentId: string, name: string): void {
    const disabled = this.agentDisabled.get(agentId);
    if (disabled) {
      disabled.delete(name);
      if (disabled.size === 0) this.agentDisabled.delete(agentId);
    }
  }

  isDisabledForAgent(agentId: string, name: string): boolean {
    return this.agentDisabled.get(agentId)?.has(name) ?? false;
  }

  // --- Per-agent usage tracking (for serialization) ---

  trackUsage(agentId: string, name: string): void {
    let used = this.agentUsage.get(agentId);
    if (!used) {
      used = new Set();
      this.agentUsage.set(agentId, used);
    }
    used.add(name);
  }

  getAgentDependencies(agentId: string): SkillDependency[] {
    const usedSkillNames = this.agentUsage.get(agentId);
    if (!usedSkillNames) return [];

    const deps: SkillDependency[] = [];
    for (const name of usedSkillNames) {
      const skill = this.skills.get(name);
      if (skill) {
        deps.push({
          name: skill.name,
          source: skill.source,
          inline: skill,
        });
      }
    }
    return deps;
  }

  clearAgentUsage(agentId: string): void {
    this.agentUsage.delete(agentId);
  }

  // --- Bulk operations for persistence ---

  exportUserSkills(): StoredSkill[] {
    return Array.from(this.skills.values()).filter(
      skill => skill.source.type !== 'builtin'
    );
  }

  importUserSkills(skills: StoredSkill[]): void {
    // Preserve builtins, clear user-installed ones
    const builtins = Array.from(this.skills.values()).filter(
      s => s.source.type === 'builtin'
    );
    this.skills.clear();
    for (const b of builtins) {
      this.skills.set(b.name, b);
    }
    for (const skill of skills) {
      this.skills.set(skill.name, skill);
    }
  }
}
