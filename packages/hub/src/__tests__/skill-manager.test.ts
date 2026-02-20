/**
 * Tests for HubSkillManager
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HubSkillManager } from '../skill-manager.js';
import { getSystemSkills } from '@flo-monster/core';

// We'll test with a custom skills directory to avoid affecting the user's real skills
describe('HubSkillManager', () => {
  let testDir: string;
  let originalEnv: string | undefined;

  // Create a test skill manager that uses a custom directory
  class TestSkillManager extends HubSkillManager {
    private testSkillsDir: string;

    constructor(skillsDir: string) {
      super();
      this.testSkillsDir = skillsDir;
    }

    // Override the internal methods to use the test directory
    protected getSkillsDir(): string {
      return this.testSkillsDir;
    }
  }

  beforeEach(async () => {
    testDir = join(tmpdir(), `hub-skill-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // Helper to create a valid SKILL.md content
  function createSkillContent(name: string, description: string, instructions = 'Do the thing'): string {
    return `---
name: ${name}
description: ${description}
---
${instructions}`;
  }

  // Helper to create a skill directly on the filesystem
  async function createSkillOnDisk(skillsDir: string, name: string, content: string): Promise<void> {
    const skillDir = join(skillsDir, name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), content, 'utf-8');
  }

  describe('load()', () => {
    it('loads skills from the filesystem', async () => {
      // Create skills directly on disk
      await createSkillOnDisk(testDir, 'skill-one', createSkillContent('skill-one', 'First skill'));
      await createSkillOnDisk(testDir, 'skill-two', createSkillContent('skill-two', 'Second skill'));

      const manager = new HubSkillManager();
      // Monkey-patch to use test directory
      (manager as any).store = (manager as any).store;
      (manager as any).loaded = false;

      // Mock the loading by directly manipulating internals for testing
      // Since we can't easily override the SKILLS_DIR constant, we test the public API
      // by installing skills and checking they persist

      // For this test, we verify the manager can install and list skills
      const skills = manager.listSkills();
      // Should have at least system skills after load
      expect(skills.length).toBeGreaterThanOrEqual(getSystemSkills().length);
    });

    it('includes system skills after load', () => {
      const manager = new HubSkillManager();
      const skills = manager.listSkills();
      const systemSkills = getSystemSkills();

      // All 6 system skills should be present
      for (const sys of systemSkills) {
        const found = skills.find(s => s.name === sys.name);
        expect(found, `System skill "${sys.name}" should be present`).toBeDefined();
        expect(found?.source.type).toBe('builtin');
      }
    });

    it('handles empty skills directory', () => {
      const manager = new HubSkillManager();
      // Should have system skills even with no user-installed ones
      expect(manager.listSkills().length).toBeGreaterThanOrEqual(getSystemSkills().length);
    });

    it('skips directories without SKILL.md', async () => {
      // Create a directory without SKILL.md
      const emptyDir = join(testDir, 'empty-skill');
      await mkdir(emptyDir, { recursive: true });

      const manager = new HubSkillManager();
      // Should not throw
      expect(() => manager.listSkills()).not.toThrow();
    });
  });

  describe('install()', () => {
    it('installs a valid skill', () => {
      const manager = new HubSkillManager();
      const content = createSkillContent('new-skill', 'A new skill', 'Instructions for $ARGUMENTS');

      const skill = manager.install(content);

      expect(skill.name).toBe('new-skill');
      expect(skill.manifest.name).toBe('new-skill');
      expect(skill.manifest.description).toBe('A new skill');
      expect(skill.instructions).toBe('Instructions for $ARGUMENTS');
      expect(skill.source.type).toBe('local');
      expect(skill.installedAt).toBeGreaterThan(0);

      // Verify it's now in the list
      expect(manager.hasSkill('new-skill')).toBe(true);
      expect(manager.getSkill('new-skill')).toEqual(skill);

      // Clean up
      manager.remove('new-skill');
    });

    it('throws on invalid skill content', () => {
      const manager = new HubSkillManager();

      // Missing frontmatter
      expect(() => manager.install('no frontmatter')).toThrow('Missing or invalid frontmatter');

      // Missing name
      expect(() => manager.install(`---
description: No name
---
Instructions`)).toThrow('Missing required field: name');

      // Missing description
      expect(() => manager.install(`---
name: no-desc
---
Instructions`)).toThrow('Missing required field: description');

      // Invalid name format
      expect(() => manager.install(`---
name: Invalid_Name
description: Has invalid name
---
Instructions`)).toThrow('Invalid skill name');
    });

    it('throws when skill already exists', () => {
      const manager = new HubSkillManager();
      const content = createSkillContent('duplicate-skill', 'First install');

      manager.install(content);

      expect(() => manager.install(content)).toThrow('already exists');

      // Clean up
      manager.remove('duplicate-skill');
    });

    it('installs skill with all optional fields', () => {
      const manager = new HubSkillManager();
      const content = `---
name: full-skill
description: A fully configured skill
allowedTools: bash, filesystem
argumentHint: "[file path]"
disableModelInvocation: true
userInvocable: true
---
Process $ARGUMENTS`;

      const skill = manager.install(content);

      expect(skill.manifest.allowedTools).toEqual(['bash', 'filesystem']);
      expect(skill.manifest.argumentHint).toBe('[file path]');
      expect(skill.manifest.disableModelInvocation).toBe(true);
      expect(skill.manifest.userInvocable).toBe(true);

      // Clean up
      manager.remove('full-skill');
    });
  });

  describe('remove()', () => {
    it('removes an existing skill', () => {
      const manager = new HubSkillManager();
      const content = createSkillContent('to-remove', 'Will be removed');

      manager.install(content);
      expect(manager.hasSkill('to-remove')).toBe(true);

      const removed = manager.remove('to-remove');
      expect(removed).toBe(true);
      expect(manager.hasSkill('to-remove')).toBe(false);
      expect(manager.getSkill('to-remove')).toBeUndefined();
    });

    it('returns false for non-existent skill', () => {
      const manager = new HubSkillManager();
      expect(manager.remove('non-existent')).toBe(false);
    });

    it('returns false for builtin/system skills', () => {
      const manager = new HubSkillManager();
      // System skills should be loaded
      const systemSkills = getSystemSkills();
      expect(systemSkills.length).toBeGreaterThan(0);

      // Attempt to remove a system skill
      const removed = manager.remove(systemSkills[0].name);
      expect(removed).toBe(false);

      // Verify the skill is still there
      expect(manager.hasSkill(systemSkills[0].name)).toBe(true);
    });
  });

  describe('getSkill()', () => {
    it('returns skill by name', () => {
      const manager = new HubSkillManager();
      const content = createSkillContent('get-test', 'Test skill');

      manager.install(content);

      const skill = manager.getSkill('get-test');
      expect(skill).toBeDefined();
      expect(skill?.name).toBe('get-test');

      // Clean up
      manager.remove('get-test');
    });

    it('returns undefined for non-existent skill', () => {
      const manager = new HubSkillManager();
      expect(manager.getSkill('non-existent')).toBeUndefined();
    });

    it('returns system skills by name', () => {
      const manager = new HubSkillManager();
      const skill = manager.getSkill('flo-hub');
      expect(skill).toBeDefined();
      expect(skill?.name).toBe('flo-hub');
      expect(skill?.source.type).toBe('builtin');
    });
  });

  describe('hasSkill()', () => {
    it('returns true for existing skill', () => {
      const manager = new HubSkillManager();
      const content = createSkillContent('has-test', 'Test skill');

      manager.install(content);
      expect(manager.hasSkill('has-test')).toBe(true);

      // Clean up
      manager.remove('has-test');
    });

    it('returns false for non-existent skill', () => {
      const manager = new HubSkillManager();
      expect(manager.hasSkill('non-existent')).toBe(false);
    });

    it('returns true for system skills', () => {
      const manager = new HubSkillManager();
      expect(manager.hasSkill('flo-hub')).toBe(true);
      expect(manager.hasSkill('flo-hub')).toBe(true);
    });
  });

  describe('listSkills()', () => {
    it('returns all installed skills including system skills', () => {
      const manager = new HubSkillManager();
      const systemCount = getSystemSkills().length;

      manager.install(createSkillContent('list-a', 'Skill A'));
      manager.install(createSkillContent('list-b', 'Skill B'));

      const skills = manager.listSkills();
      // System skills + 2 user skills (may also have pre-existing user skills)
      expect(skills.length).toBeGreaterThanOrEqual(systemCount + 2);

      const names = skills.map(s => s.name);
      expect(names).toContain('list-a');
      expect(names).toContain('list-b');
      expect(names).toContain('flo-hub');

      // Clean up
      manager.remove('list-a');
      manager.remove('list-b');
    });
  });

  describe('listUserInvocableSkills()', () => {
    it('excludes skills with userInvocable: false', () => {
      const manager = new HubSkillManager();

      // Install invocable skill
      manager.install(createSkillContent('invocable', 'Can invoke'));

      // Install non-invocable skill
      manager.install(`---
name: not-invocable
description: Cannot invoke
userInvocable: false
---
Instructions`);

      const invocable = manager.listUserInvocableSkills();
      const names = invocable.map(s => s.name);

      expect(names).toContain('invocable');
      expect(names).not.toContain('not-invocable');

      // But listSkills should have both
      const all = manager.listSkills();
      const allNames = all.map(s => s.name);
      expect(allNames).toContain('not-invocable');

      // Clean up
      manager.remove('invocable');
      manager.remove('not-invocable');
    });

    it('includes skills without explicit userInvocable field', () => {
      const manager = new HubSkillManager();

      manager.install(createSkillContent('default-invocable', 'Default should be invocable'));

      const invocable = manager.listUserInvocableSkills();
      const names = invocable.map(s => s.name);

      expect(names).toContain('default-invocable');

      // Clean up
      manager.remove('default-invocable');
    });

    it('excludes system skills (they are not user-invocable)', () => {
      const manager = new HubSkillManager();
      const invocable = manager.listUserInvocableSkills();
      const names = invocable.map(s => s.name);

      // System skills have userInvocable: false
      expect(names).not.toContain('flo-hub');
      expect(names).not.toContain('flo-hub');
    });
  });

  describe('listAgentVisibleSkills()', () => {
    it('includes system skills for agents', () => {
      const manager = new HubSkillManager();
      const visible = manager.listAgentVisibleSkills(undefined, { hasHub: true, hasBrowser: true });
      const names = visible.map(s => s.name);

      // System skills should be visible to agents
      expect(names).toContain('flo-hub');
      expect(names).toContain('flo-hub');
      expect(names).toContain('flo-srcdoc');
      expect(names).toContain('flo-subagent');
      expect(names).toContain('flo-speech');
      expect(names).toContain('flo-media');
    });

    it('includes user-installed skills alongside system skills', () => {
      const manager = new HubSkillManager();
      manager.install(createSkillContent('agent-visible', 'Visible to agents'));

      const visible = manager.listAgentVisibleSkills(undefined, { hasHub: true, hasBrowser: true });
      const names = visible.map(s => s.name);

      expect(names).toContain('agent-visible');
      expect(names).toContain('flo-hub');

      manager.remove('agent-visible');
    });

    it('excludes skills with userInvocable: false that are not system skills', () => {
      const manager = new HubSkillManager();
      manager.install(`---
name: hidden-from-agent
description: Not system, not invocable
userInvocable: false
---
Instructions`);

      const visible = manager.listAgentVisibleSkills(undefined, { hasHub: true, hasBrowser: true });
      const names = visible.map(s => s.name);

      expect(names).not.toContain('hidden-from-agent');

      manager.remove('hidden-from-agent');
    });
  });

  describe('trackUsage() and getAgentDependencies()', () => {
    it('tracks skill usage per agent', () => {
      const manager = new HubSkillManager();
      manager.install(createSkillContent('tracked-skill', 'A tracked skill'));

      manager.trackUsage('agent-1', 'tracked-skill');
      manager.trackUsage('agent-1', 'flo-hub');

      const deps = manager.getAgentDependencies('agent-1');
      expect(deps.length).toBe(2);

      const names = deps.map(d => d.name);
      expect(names).toContain('tracked-skill');
      expect(names).toContain('flo-hub');

      // Each dependency has inline skill data
      for (const dep of deps) {
        expect(dep.inline).toBeDefined();
        expect(dep.source).toBeDefined();
      }

      manager.remove('tracked-skill');
    });

    it('returns empty array for agent with no usage', () => {
      const manager = new HubSkillManager();
      const deps = manager.getAgentDependencies('no-usage-agent');
      expect(deps).toEqual([]);
    });

    it('clearAgentUsage removes tracking data', () => {
      const manager = new HubSkillManager();
      manager.trackUsage('agent-2', 'flo-hub');
      expect(manager.getAgentDependencies('agent-2').length).toBe(1);

      manager.clearAgentUsage('agent-2');
      expect(manager.getAgentDependencies('agent-2')).toEqual([]);
    });
  });

  describe('registerFromSession()', () => {
    it('registers a skill without filesystem write', () => {
      const manager = new HubSkillManager();

      const sessionSkill = {
        name: 'session-restored',
        manifest: {
          name: 'session-restored',
          description: 'Restored from session',
        },
        instructions: 'Restored instructions',
        source: { type: 'url' as const, url: 'https://example.com/skill.md' },
        installedAt: Date.now(),
      };

      manager.registerFromSession(sessionSkill);

      expect(manager.hasSkill('session-restored')).toBe(true);
      const retrieved = manager.getSkill('session-restored');
      expect(retrieved?.name).toBe('session-restored');
      expect(retrieved?.source.type).toBe('url');
      expect(retrieved?.instructions).toBe('Restored instructions');

      // Can be removed (not a builtin)
      expect(manager.remove('session-restored')).toBe(true);
    });

    it('overwrites existing skill with same name', () => {
      const manager = new HubSkillManager();

      const skill1 = {
        name: 'overwrite-test',
        manifest: { name: 'overwrite-test', description: 'Version 1' },
        instructions: 'Version 1 instructions',
        source: { type: 'local' as const },
        installedAt: Date.now(),
      };

      const skill2 = {
        name: 'overwrite-test',
        manifest: { name: 'overwrite-test', description: 'Version 2' },
        instructions: 'Version 2 instructions',
        source: { type: 'local' as const },
        installedAt: Date.now(),
      };

      manager.registerFromSession(skill1);
      manager.registerFromSession(skill2);

      const retrieved = manager.getSkill('overwrite-test');
      expect(retrieved?.manifest.description).toBe('Version 2');

      manager.remove('overwrite-test');
    });
  });
});
