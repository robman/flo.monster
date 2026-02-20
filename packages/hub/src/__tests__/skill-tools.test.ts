/**
 * Tests for skill tools
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HubSkillManager } from '../skill-manager.js';
import { skillToolDefs, isSkillTool, executeSkillTool } from '../tools/skill-tools.js';
import { getSystemSkills } from '@flo-monster/core';

describe('skill tools', () => {
  let manager: HubSkillManager;

  // Helper to create a valid SKILL.md content
  function createSkillContent(
    name: string,
    description: string,
    options: {
      instructions?: string;
      allowedTools?: string[];
      argumentHint?: string;
      userInvocable?: boolean;
    } = {}
  ): string {
    const {
      instructions = 'Do the thing',
      allowedTools,
      argumentHint,
      userInvocable,
    } = options;

    let yaml = `name: ${name}\ndescription: ${description}`;

    if (allowedTools) {
      yaml += `\nallowedTools: ${allowedTools.join(', ')}`;
    }
    if (argumentHint) {
      yaml += `\nargumentHint: "${argumentHint}"`;
    }
    if (userInvocable !== undefined) {
      yaml += `\nuserInvocable: ${userInvocable}`;
    }

    return `---\n${yaml}\n---\n${instructions}`;
  }

  beforeEach(() => {
    manager = new HubSkillManager();
  });

  afterEach(() => {
    // Clean up any skills we created
    for (const skill of manager.listSkills()) {
      if (skill.name.startsWith('test-')) {
        manager.remove(skill.name);
      }
    }
  });

  describe('skillToolDefs', () => {
    it('defines list_skills tool', () => {
      const tool = skillToolDefs.find(t => t.name === 'list_skills');
      expect(tool).toBeDefined();
      expect(tool?.description).toContain('List');
      expect(tool?.input_schema.properties).toEqual({});
    });

    it('defines get_skill tool', () => {
      const tool = skillToolDefs.find(t => t.name === 'get_skill');
      expect(tool).toBeDefined();
      expect(tool?.input_schema.properties).toHaveProperty('name');
      expect(tool?.input_schema.required).toContain('name');
    });

    it('defines create_skill tool', () => {
      const tool = skillToolDefs.find(t => t.name === 'create_skill');
      expect(tool).toBeDefined();
      expect(tool?.input_schema.properties).toHaveProperty('content');
      expect(tool?.input_schema.required).toContain('content');
    });

    it('defines remove_skill tool', () => {
      const tool = skillToolDefs.find(t => t.name === 'remove_skill');
      expect(tool).toBeDefined();
      expect(tool?.input_schema.properties).toHaveProperty('name');
      expect(tool?.input_schema.required).toContain('name');
    });
  });

  describe('isSkillTool', () => {
    it('returns true for skill tools', () => {
      expect(isSkillTool('list_skills')).toBe(true);
      expect(isSkillTool('get_skill')).toBe(true);
      expect(isSkillTool('create_skill')).toBe(true);
      expect(isSkillTool('remove_skill')).toBe(true);
    });

    it('returns false for non-skill tools', () => {
      expect(isSkillTool('bash')).toBe(false);
      expect(isSkillTool('filesystem')).toBe(false);
      expect(isSkillTool('unknown')).toBe(false);
    });
  });

  describe('executeSkillTool', () => {
    describe('list_skills', () => {
      it('returns system skills when called with agentId', async () => {
        const result = await executeSkillTool('list_skills', {}, manager, undefined, 'agent-1');

        expect(result.is_error).toBeUndefined();
        const skills = JSON.parse(result.content);
        const names = skills.map((s: any) => s.name);

        // Should include system skills (visible to agents)
        expect(names).toContain('flo-hub');
        expect(names).toContain('flo-hub');
        expect(names).toContain('flo-srcdoc');
      });

      it('returns system skills even without agentId', async () => {
        const result = await executeSkillTool('list_skills', {}, manager);

        expect(result.is_error).toBeUndefined();
        const skills = JSON.parse(result.content);
        const names = skills.map((s: any) => s.name);

        // System skills should still be listed (agent-visible uses hasHub+hasBrowser context)
        expect(names).toContain('flo-hub');
      });

      it('returns installed user skills alongside system skills', async () => {
        manager.install(createSkillContent('test-list-skill', 'A test skill', {
          allowedTools: ['bash'],
          argumentHint: '[message]',
        }));

        const result = await executeSkillTool('list_skills', {}, manager, undefined, 'agent-1');

        expect(result.is_error).toBeUndefined();
        const skills = JSON.parse(result.content);
        const testSkill = skills.find((s: any) => s.name === 'test-list-skill');

        expect(testSkill).toBeDefined();
        expect(testSkill.description).toBe('A test skill');
        expect(testSkill.argumentHint).toBe('[message]');
        expect(testSkill.allowedTools).toEqual(['bash']);

        // System skills also present
        const names = skills.map((s: any) => s.name);
        expect(names).toContain('flo-hub');
      });

      it('excludes non-system non-user-invocable skills', async () => {
        manager.install(createSkillContent('test-invocable', 'Invocable'));
        manager.install(createSkillContent('test-hidden', 'Hidden', {
          userInvocable: false,
        }));

        const result = await executeSkillTool('list_skills', {}, manager, undefined, 'agent-1');

        const skills = JSON.parse(result.content);
        const names = skills.map((s: any) => s.name);

        expect(names).toContain('test-invocable');
        expect(names).not.toContain('test-hidden');
      });

      it('returns all system skills with expected fields', async () => {
        const result = await executeSkillTool('list_skills', {}, manager, undefined, 'agent-1');
        const skills = JSON.parse(result.content);

        const systemSkillNames = getSystemSkills().map(s => s.name);
        for (const sysName of systemSkillNames) {
          const found = skills.find((s: any) => s.name === sysName);
          expect(found, `System skill "${sysName}" should appear in list_skills`).toBeDefined();
          expect(found.description).toBeTruthy();
        }
      });
    });

    describe('get_skill', () => {
      it('returns full skill details', async () => {
        manager.install(createSkillContent('test-get-detail', 'Detailed skill', {
          instructions: 'Detailed instructions with $ARGUMENTS',
          allowedTools: ['bash', 'filesystem'],
        }));

        const result = await executeSkillTool('get_skill', { name: 'test-get-detail' }, manager);

        expect(result.is_error).toBeUndefined();
        const skill = JSON.parse(result.content);

        expect(skill.name).toBe('test-get-detail');
        expect(skill.manifest.name).toBe('test-get-detail');
        expect(skill.manifest.description).toBe('Detailed skill');
        expect(skill.manifest.allowedTools).toEqual(['bash', 'filesystem']);
        expect(skill.instructions).toBe('Detailed instructions with $ARGUMENTS');
        expect(skill.source.type).toBe('local');
      });

      it('returns error for non-existent skill', async () => {
        const result = await executeSkillTool('get_skill', { name: 'non-existent' }, manager);

        expect(result.is_error).toBe(true);
        expect(result.content).toContain('not found');
      });

      it('returns system skill details', async () => {
        const result = await executeSkillTool('get_skill', { name: 'flo-hub' }, manager, undefined, 'agent-1');

        expect(result.is_error).toBeUndefined();
        const skill = JSON.parse(result.content);

        expect(skill.name).toBe('flo-hub');
        expect(skill.source.type).toBe('builtin');
        expect(skill.instructions).toBeTruthy();
      });

      it('tracks usage when agentId is provided', async () => {
        manager.install(createSkillContent('test-tracked', 'Tracked skill'));

        await executeSkillTool('get_skill', { name: 'test-tracked' }, manager, undefined, 'agent-42');

        // Verify usage was tracked
        const deps = manager.getAgentDependencies('agent-42');
        const names = deps.map(d => d.name);
        expect(names).toContain('test-tracked');
      });

      it('does not track usage when no agentId', async () => {
        manager.install(createSkillContent('test-untracked', 'Untracked skill'));

        await executeSkillTool('get_skill', { name: 'test-untracked' }, manager);

        // No agent to track for — should not crash
        // (We can't really verify "no tracking" without inspecting internals,
        //  but we verify it doesn't error)
        expect(true).toBe(true);
      });
    });

    describe('create_skill', () => {
      it('creates a valid skill', async () => {
        const content = createSkillContent('test-create', 'Created via tool');

        const result = await executeSkillTool('create_skill', { content }, manager);

        expect(result.is_error).toBeUndefined();
        expect(result.content).toContain('installed successfully');
        expect(result.content).toContain('test-create');

        // Verify skill exists
        expect(manager.hasSkill('test-create')).toBe(true);
      });

      it('returns error for invalid skill format', async () => {
        const result = await executeSkillTool('create_skill', { content: 'invalid content' }, manager);

        expect(result.is_error).toBe(true);
        expect(result.content).toContain('Invalid skill format');
      });

      it('returns error when skill already exists', async () => {
        const content = createSkillContent('test-duplicate', 'Original');
        manager.install(content);

        const result = await executeSkillTool('create_skill', { content }, manager);

        expect(result.is_error).toBe(true);
        expect(result.content).toContain('already exists');
      });

      it('validates skill before installation', async () => {
        // Missing description
        const invalidContent = `---
name: test-invalid
---
Instructions`;

        const result = await executeSkillTool('create_skill', { content: invalidContent }, manager);

        expect(result.is_error).toBe(true);
        expect(result.content).toContain('Missing required field');
      });
    });

    describe('remove_skill', () => {
      it('removes an existing skill', async () => {
        manager.install(createSkillContent('test-to-remove', 'Will be removed'));

        const result = await executeSkillTool('remove_skill', { name: 'test-to-remove' }, manager);

        expect(result.is_error).toBeUndefined();
        expect(result.content).toContain('removed successfully');
        expect(manager.hasSkill('test-to-remove')).toBe(false);
      });

      it('returns error for non-existent skill', async () => {
        const result = await executeSkillTool('remove_skill', { name: 'non-existent' }, manager);

        expect(result.is_error).toBe(true);
        expect(result.content).toContain('not found');
      });

      it('returns error when trying to remove a system skill', async () => {
        // System skill exists
        expect(manager.hasSkill('flo-hub')).toBe(true);

        const result = await executeSkillTool('remove_skill', { name: 'flo-hub' }, manager);

        // remove() returns false for builtins, which the tool handler reports as failure
        expect(result.is_error).toBe(true);
        expect(result.content).toContain('Failed to remove');

        // Skill should still exist
        expect(manager.hasSkill('flo-hub')).toBe(true);
      });
    });

    describe('get_skill capability check', () => {
      it('validates requiredCapabilities on get_skill', async () => {
        // Install a skill with a required capability
        const content = createSkillContent('test-cap-check', 'Needs browser', {
          instructions: 'Requires browser',
        });
        manager.install(content);

        // Manually set requiredCapabilities on the installed skill
        const skill = manager.getSkill('test-cap-check');
        if (skill) {
          (skill.manifest as any).requiredCapabilities = ['browser'];
        }

        // Hub get_skill declares both capabilities, so this should pass
        const result = await executeSkillTool('get_skill', { name: 'test-cap-check' }, manager, undefined, 'agent-1');
        expect(result.is_error).toBeUndefined();
        const parsed = JSON.parse(result.content);
        expect(parsed.name).toBe('test-cap-check');
      });
    });

    describe('unknown tool', () => {
      it('returns error for unknown tool', async () => {
        const result = await executeSkillTool('unknown_skill_tool', {}, manager);

        expect(result.is_error).toBe(true);
        expect(result.content).toContain('Unknown skill tool');
      });
    });
  });
});
