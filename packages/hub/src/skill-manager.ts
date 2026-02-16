/**
 * Hub-side skill manager
 * Wraps SkillStore from @flo-monster/core for in-memory skill management.
 * Stores user-installed skills on the filesystem at ~/.flo-monster/skills/
 * System skills are registered from core on load().
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { StoredSkill } from '@flo-monster/core';
import { parseSkillMd, SkillStore, getSystemSkills } from '@flo-monster/core';
import type { SkillContext } from '@flo-monster/core';

const SKILLS_DIR = join(homedir(), '.flo-monster', 'skills');

/**
 * Ensure the skills directory exists
 */
function ensureSkillsDir(): void {
  if (!existsSync(SKILLS_DIR)) {
    mkdirSync(SKILLS_DIR, { recursive: true });
  }
}

/**
 * Get the path to a skill directory
 */
function getSkillPath(name: string): string {
  return join(SKILLS_DIR, name);
}

/**
 * Get the path to a skill's SKILL.md file
 */
function getSkillFilePath(name: string): string {
  return join(getSkillPath(name), 'SKILL.md');
}

export class HubSkillManager {
  private store: SkillStore;
  private loaded = false;

  constructor() {
    this.store = new SkillStore();
  }

  /**
   * Load system skills and all user-installed skills from the filesystem
   */
  load(): void {
    this.store = new SkillStore();
    this.loaded = false;

    // Register system skills first
    this.store.registerSystemSkills(getSystemSkills());

    // Then load user-installed skills from filesystem
    ensureSkillsDir();

    let filesystemCount = 0;
    try {
      const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillFile = getSkillFilePath(entry.name);
          if (existsSync(skillFile)) {
            try {
              const content = readFileSync(skillFile, 'utf-8');
              const { manifest, instructions } = parseSkillMd(content);

              this.store.register({
                name: manifest.name,
                manifest,
                instructions,
                source: { type: 'local' },
                installedAt: Date.now(),
              });
              filesystemCount++;
            } catch (err) {
              console.error(`[hub] Failed to load skill ${entry.name}:`, err);
            }
          }
        }
      }
    } catch (err) {
      console.error('[hub] Failed to load skills:', err);
    }

    this.loaded = true;
    const systemCount = getSystemSkills().length;
    console.log(`[hub] Loaded ${systemCount} system skills + ${filesystemCount} user skills from ${SKILLS_DIR}`);
  }

  /**
   * Ensure skills are loaded
   */
  private ensureLoaded(): void {
    if (!this.loaded) {
      this.load();
    }
  }

  /**
   * Install a skill from content (writes to filesystem + registers in store)
   */
  install(content: string): StoredSkill {
    this.ensureLoaded();

    const { manifest, instructions } = parseSkillMd(content);

    // Check if already exists
    if (this.store.has(manifest.name)) {
      throw new Error(`Skill "${manifest.name}" already exists`);
    }

    // Create skill directory and file
    const skillDir = getSkillPath(manifest.name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(getSkillFilePath(manifest.name), content, 'utf-8');

    const skill: StoredSkill = {
      name: manifest.name,
      manifest,
      instructions,
      source: { type: 'local' },
      installedAt: Date.now(),
    };

    this.store.register(skill);
    return skill;
  }

  /**
   * Remove a skill.
   * Returns false for builtin/system skills (cannot be removed) or if skill doesn't exist.
   */
  remove(name: string): boolean {
    this.ensureLoaded();

    if (!this.store.has(name)) {
      return false;
    }

    // Try to unregister — SkillStore.unregister() returns false for builtins
    const unregistered = this.store.unregister(name);
    if (!unregistered) {
      return false;
    }

    // Remove from filesystem
    const skillDir = getSkillPath(name);
    if (existsSync(skillDir)) {
      rmSync(skillDir, { recursive: true, force: true });
    }

    return true;
  }

  /**
   * Get a skill by name
   */
  getSkill(name: string): StoredSkill | undefined {
    this.ensureLoaded();
    return this.store.get(name);
  }

  /**
   * Check if a skill exists
   */
  hasSkill(name: string): boolean {
    this.ensureLoaded();
    return this.store.has(name);
  }

  /**
   * List all skills (including system skills)
   */
  listSkills(): StoredSkill[] {
    this.ensureLoaded();
    return this.store.listAll();
  }

  /**
   * List user-invocable skills (for /help display)
   */
  listUserInvocableSkills(): StoredSkill[] {
    this.ensureLoaded();
    return this.store.listUserInvocable();
  }

  /**
   * List agent-visible skills (system + user-invocable, filtered by capabilities)
   * Used by list_skills tool for agents
   */
  listAgentVisibleSkills(agentId?: string, context?: SkillContext): StoredSkill[] {
    this.ensureLoaded();
    return this.store.listAgentVisible(agentId, context);
  }

  /**
   * Track that an agent used a skill (for serialization of dependencies)
   */
  trackUsage(agentId: string, name: string): void {
    this.ensureLoaded();
    this.store.trackUsage(agentId, name);
  }

  /**
   * Get skill dependencies for an agent (used during persist)
   */
  getAgentDependencies(agentId: string): ReturnType<SkillStore['getAgentDependencies']> {
    this.ensureLoaded();
    return this.store.getAgentDependencies(agentId);
  }

  /**
   * Clear usage tracking for an agent (e.g., on agent removal)
   */
  clearAgentUsage(agentId: string): void {
    this.ensureLoaded();
    this.store.clearAgentUsage(agentId);
  }

  /**
   * Register a skill from session data (no filesystem write).
   * Used to restore per-agent skills from session.dependencies.
   */
  registerFromSession(skill: StoredSkill): void {
    this.ensureLoaded();
    this.store.register(skill);
  }

  /**
   * Get the skills directory path (for testing)
   */
  static getSkillsDir(): string {
    return SKILLS_DIR;
  }
}
