import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSkillToolsPlugins, isSkillToolName } from './skill-tools-plugin.js';
import { SkillManager } from '../../shell/skill-manager.js';
import type { PersistenceLayer, AppSettings } from '../../shell/persistence.js';
import type { StoredSkill } from '@flo-monster/core';

// Mock PersistenceLayer
function createMockPersistence(settings: Partial<AppSettings> = {}): PersistenceLayer {
  const mockSettings: AppSettings = {
    defaultModel: 'claude-sonnet-4-20250514',
    enabledExtensions: [],
    ...settings,
  };

  return {
    getSettings: vi.fn(() => Promise.resolve(mockSettings)),
    saveSettings: vi.fn(() => Promise.resolve()),
  } as unknown as PersistenceLayer;
}

// Sample skill content in SKILL.md format
const sampleSkillContent = `---
name: test-skill
description: A test skill for unit testing
argumentHint: "[test argument]"
---

# Test Skill

This is a test skill.
Your argument is: $ARGUMENTS
`;

// Sample invalid skill content
const invalidSkillContent = `
This is not valid SKILL.md format
No YAML frontmatter
`;

describe('createSkillToolsPlugins', () => {
  let skillManager: SkillManager;
  let persistence: PersistenceLayer;
  let showApprovalDialog: ReturnType<typeof vi.fn>;
  let showConfirmDialog: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    skillManager = new SkillManager();
    persistence = createMockPersistence();
    showApprovalDialog = vi.fn();
    showConfirmDialog = vi.fn();
  });

  it('should create four plugins', () => {
    const plugins = createSkillToolsPlugins({
      skillManager,
      persistence,
      showApprovalDialog,
      showConfirmDialog,
    });

    expect(plugins).toHaveLength(4);
    const names = plugins.map(p => p.definition.name);
    expect(names).toContain('list_skills');
    expect(names).toContain('get_skill');
    expect(names).toContain('create_skill');
    expect(names).toContain('remove_skill');
  });

  describe('list_skills plugin', () => {
    it('should return empty array when no skills', async () => {
      const plugins = createSkillToolsPlugins({
        skillManager,
        persistence,
        showApprovalDialog,
        showConfirmDialog,
      });
      const listPlugin = plugins.find(p => p.definition.name === 'list_skills')!;

      const result = await listPlugin.execute({}, {
        agentId: 'test',
        agentConfig: { id: 'test', name: 'Test', model: 'test', tools: [], maxTokens: 1000 },
      });

      expect(result.is_error).toBeUndefined();
      const parsed = JSON.parse(result.content as string);
      expect(parsed).toEqual([]);
    });

    it('should return installed skills with category', async () => {
      const testSkill: StoredSkill = {
        name: 'my-skill',
        manifest: {
          name: 'my-skill',
          description: 'My test skill',
          argumentHint: '[arg]',
        },
        instructions: 'Do something with $ARGUMENTS',
        source: { type: 'local' },
        installedAt: Date.now(),
      };
      skillManager.installBuiltin(testSkill);

      const plugins = createSkillToolsPlugins({
        skillManager,
        persistence,
        showApprovalDialog,
        showConfirmDialog,
      });
      const listPlugin = plugins.find(p => p.definition.name === 'list_skills')!;

      const result = await listPlugin.execute({}, {
        agentId: 'test',
        agentConfig: { id: 'test', name: 'Test', model: 'test', tools: [], maxTokens: 1000 },
      });

      expect(result.is_error).toBeUndefined();
      const parsed = JSON.parse(result.content as string);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].name).toBe('my-skill');
      expect(parsed[0].description).toBe('My test skill');
      expect(parsed[0].argumentHint).toBe('[arg]');
      expect(parsed[0].category).toBe('user');
    });

    it('should return system skills with category marker', async () => {
      const systemSkill: StoredSkill = {
        name: 'flo-hub',
        manifest: {
          name: 'flo-hub',
          description: 'Core patterns',
          category: 'system',
          userInvocable: false,
        },
        instructions: 'Cookbook content',
        source: { type: 'builtin' },
        installedAt: 0,
      };
      skillManager.installBuiltin(systemSkill);

      const plugins = createSkillToolsPlugins({
        skillManager,
        persistence,
        showApprovalDialog,
        showConfirmDialog,
      });
      const listPlugin = plugins.find(p => p.definition.name === 'list_skills')!;

      const result = await listPlugin.execute({}, {
        agentId: 'test',
        agentConfig: { id: 'test', name: 'Test', model: 'test', tools: [], maxTokens: 1000 },
      });

      const parsed = JSON.parse(result.content as string);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].name).toBe('flo-hub');
      expect(parsed[0].category).toBe('system');
    });

    it('should return both system and user skills', async () => {
      skillManager.installBuiltin({
        name: 'flo-hub',
        manifest: { name: 'flo-hub', description: 'System ref', category: 'system', userInvocable: false },
        instructions: 'System content',
        source: { type: 'builtin' },
        installedAt: 0,
      });
      skillManager.installBuiltin({
        name: 'my-command',
        manifest: { name: 'my-command', description: 'User command' },
        instructions: 'Command content',
        source: { type: 'local' },
        installedAt: 1,
      });

      const plugins = createSkillToolsPlugins({
        skillManager,
        persistence,
        showApprovalDialog,
        showConfirmDialog,
      });
      const listPlugin = plugins.find(p => p.definition.name === 'list_skills')!;

      const result = await listPlugin.execute({}, {
        agentId: 'test',
        agentConfig: { id: 'test', name: 'Test', model: 'test', tools: [], maxTokens: 1000 },
      });

      const parsed = JSON.parse(result.content as string);
      expect(parsed).toHaveLength(2);
      const names = parsed.map((s: { name: string }) => s.name);
      expect(names).toContain('flo-hub');
      expect(names).toContain('my-command');
    });
  });

  describe('get_skill plugin', () => {
    it('should return error when skill not found', async () => {
      const plugins = createSkillToolsPlugins({
        skillManager,
        persistence,
        showApprovalDialog,
        showConfirmDialog,
      });
      const getPlugin = plugins.find(p => p.definition.name === 'get_skill')!;

      const result = await getPlugin.execute({ name: 'nonexistent' }, {
        agentId: 'test',
        agentConfig: { id: 'test', name: 'Test', model: 'test', tools: [], maxTokens: 1000 },
      });

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('not found');
    });

    it('should return skill details when found', async () => {
      const testSkill: StoredSkill = {
        name: 'my-skill',
        manifest: {
          name: 'my-skill',
          description: 'My test skill',
        },
        instructions: 'Do something',
        source: { type: 'local' },
        installedAt: Date.now(),
      };
      skillManager.installBuiltin(testSkill);

      const plugins = createSkillToolsPlugins({
        skillManager,
        persistence,
        showApprovalDialog,
        showConfirmDialog,
      });
      const getPlugin = plugins.find(p => p.definition.name === 'get_skill')!;

      const result = await getPlugin.execute({ name: 'my-skill' }, {
        agentId: 'test',
        agentConfig: { id: 'test', name: 'Test', model: 'test', tools: [], maxTokens: 1000 },
      });

      expect(result.is_error).toBeUndefined();
      const parsed = JSON.parse(result.content as string);
      expect(parsed.name).toBe('my-skill');
      expect(parsed.manifest.description).toBe('My test skill');
      expect(parsed.instructions).toBe('Do something');
    });

    it('should return error when name is missing', async () => {
      const plugins = createSkillToolsPlugins({
        skillManager,
        persistence,
        showApprovalDialog,
        showConfirmDialog,
      });
      const getPlugin = plugins.find(p => p.definition.name === 'get_skill')!;

      const result = await getPlugin.execute({}, {
        agentId: 'test',
        agentConfig: { id: 'test', name: 'Test', model: 'test', tools: [], maxTokens: 1000 },
      });

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('Missing required parameter');
    });
  });

  describe('create_skill plugin', () => {
    it('should return error for invalid skill format', async () => {
      const plugins = createSkillToolsPlugins({
        skillManager,
        persistence,
        showApprovalDialog,
        showConfirmDialog,
      });
      const createPlugin = plugins.find(p => p.definition.name === 'create_skill')!;

      const result = await createPlugin.execute({ content: invalidSkillContent }, {
        agentId: 'test',
        agentConfig: { id: 'test', name: 'Test', model: 'test', tools: [], maxTokens: 1000 },
      });

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('Invalid skill format');
    });

    it('should return error when skill already exists', async () => {
      const testSkill: StoredSkill = {
        name: 'test-skill',
        manifest: {
          name: 'test-skill',
          description: 'Existing skill',
        },
        instructions: 'Existing instructions',
        source: { type: 'local' },
        installedAt: Date.now(),
      };
      skillManager.installBuiltin(testSkill);

      const plugins = createSkillToolsPlugins({
        skillManager,
        persistence,
        showApprovalDialog,
        showConfirmDialog,
      });
      const createPlugin = plugins.find(p => p.definition.name === 'create_skill')!;

      const result = await createPlugin.execute({ content: sampleSkillContent }, {
        agentId: 'test',
        agentConfig: { id: 'test', name: 'Test', model: 'test', tools: [], maxTokens: 1000 },
      });

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('already exists');
    });

    it('should return rejection message when user rejects', async () => {
      showApprovalDialog.mockResolvedValue(false);

      const plugins = createSkillToolsPlugins({
        skillManager,
        persistence,
        showApprovalDialog,
        showConfirmDialog,
      });
      const createPlugin = plugins.find(p => p.definition.name === 'create_skill')!;

      const result = await createPlugin.execute({ content: sampleSkillContent }, {
        agentId: 'test',
        agentConfig: { id: 'test', name: 'Test', model: 'test', tools: [], maxTokens: 1000 },
      });

      expect(result.is_error).toBeUndefined();
      expect(result.content).toContain('rejected');
      expect(showApprovalDialog).toHaveBeenCalledWith({
        name: 'test-skill',
        description: 'A test skill for unit testing',
        content: sampleSkillContent,
      });
    });

    it('should install skill when user approves', async () => {
      showApprovalDialog.mockResolvedValue(true);

      const plugins = createSkillToolsPlugins({
        skillManager,
        persistence,
        showApprovalDialog,
        showConfirmDialog,
      });
      const createPlugin = plugins.find(p => p.definition.name === 'create_skill')!;

      const result = await createPlugin.execute({ content: sampleSkillContent }, {
        agentId: 'test',
        agentConfig: { id: 'test', name: 'Test', model: 'test', tools: [], maxTokens: 1000 },
      });

      expect(result.is_error).toBeUndefined();
      expect(result.content).toContain('installed successfully');
      expect(skillManager.hasSkill('test-skill')).toBe(true);
      expect(persistence.saveSettings).toHaveBeenCalled();
    });

    it('should return error when content is missing', async () => {
      const plugins = createSkillToolsPlugins({
        skillManager,
        persistence,
        showApprovalDialog,
        showConfirmDialog,
      });
      const createPlugin = plugins.find(p => p.definition.name === 'create_skill')!;

      const result = await createPlugin.execute({}, {
        agentId: 'test',
        agentConfig: { id: 'test', name: 'Test', model: 'test', tools: [], maxTokens: 1000 },
      });

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('Missing required parameter');
    });
  });

  describe('remove_skill plugin', () => {
    it('should return error when skill not found', async () => {
      const plugins = createSkillToolsPlugins({
        skillManager,
        persistence,
        showApprovalDialog,
        showConfirmDialog,
      });
      const removePlugin = plugins.find(p => p.definition.name === 'remove_skill')!;

      const result = await removePlugin.execute({ name: 'nonexistent' }, {
        agentId: 'test',
        agentConfig: { id: 'test', name: 'Test', model: 'test', tools: [], maxTokens: 1000 },
      });

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('not found');
    });

    it('should return error when trying to remove builtin skill', async () => {
      const builtinSkill: StoredSkill = {
        name: 'builtin-skill',
        manifest: {
          name: 'builtin-skill',
          description: 'A builtin skill',
        },
        instructions: 'Builtin instructions',
        source: { type: 'builtin' },
        installedAt: Date.now(),
      };
      skillManager.installBuiltin(builtinSkill);

      const plugins = createSkillToolsPlugins({
        skillManager,
        persistence,
        showApprovalDialog,
        showConfirmDialog,
      });
      const removePlugin = plugins.find(p => p.definition.name === 'remove_skill')!;

      const result = await removePlugin.execute({ name: 'builtin-skill' }, {
        agentId: 'test',
        agentConfig: { id: 'test', name: 'Test', model: 'test', tools: [], maxTokens: 1000 },
      });

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('Cannot remove builtin');
    });

    it('should return cancellation message when user cancels', async () => {
      showConfirmDialog.mockResolvedValue(false);

      const localSkill: StoredSkill = {
        name: 'local-skill',
        manifest: {
          name: 'local-skill',
          description: 'A local skill',
        },
        instructions: 'Local instructions',
        source: { type: 'local' },
        installedAt: Date.now(),
      };
      skillManager.installBuiltin(localSkill);

      const plugins = createSkillToolsPlugins({
        skillManager,
        persistence,
        showApprovalDialog,
        showConfirmDialog,
      });
      const removePlugin = plugins.find(p => p.definition.name === 'remove_skill')!;

      const result = await removePlugin.execute({ name: 'local-skill' }, {
        agentId: 'test',
        agentConfig: { id: 'test', name: 'Test', model: 'test', tools: [], maxTokens: 1000 },
      });

      expect(result.is_error).toBeUndefined();
      expect(result.content).toContain('cancelled');
      expect(skillManager.hasSkill('local-skill')).toBe(true);
    });

    it('should remove skill when user confirms', async () => {
      showConfirmDialog.mockResolvedValue(true);

      const localSkill: StoredSkill = {
        name: 'local-skill',
        manifest: {
          name: 'local-skill',
          description: 'A local skill',
        },
        instructions: 'Local instructions',
        source: { type: 'local' },
        installedAt: Date.now(),
      };
      skillManager.installBuiltin(localSkill);

      const plugins = createSkillToolsPlugins({
        skillManager,
        persistence,
        showApprovalDialog,
        showConfirmDialog,
      });
      const removePlugin = plugins.find(p => p.definition.name === 'remove_skill')!;

      const result = await removePlugin.execute({ name: 'local-skill' }, {
        agentId: 'test',
        agentConfig: { id: 'test', name: 'Test', model: 'test', tools: [], maxTokens: 1000 },
      });

      expect(result.is_error).toBeUndefined();
      expect(result.content).toContain('removed successfully');
      expect(skillManager.hasSkill('local-skill')).toBe(false);
      expect(persistence.saveSettings).toHaveBeenCalled();
    });

    it('should return error when name is missing', async () => {
      const plugins = createSkillToolsPlugins({
        skillManager,
        persistence,
        showApprovalDialog,
        showConfirmDialog,
      });
      const removePlugin = plugins.find(p => p.definition.name === 'remove_skill')!;

      const result = await removePlugin.execute({}, {
        agentId: 'test',
        agentConfig: { id: 'test', name: 'Test', model: 'test', tools: [], maxTokens: 1000 },
      });

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('Missing required parameter');
    });
  });
});

describe('isSkillToolName', () => {
  it('should return true for skill tool names', () => {
    expect(isSkillToolName('list_skills')).toBe(true);
    expect(isSkillToolName('get_skill')).toBe(true);
    expect(isSkillToolName('create_skill')).toBe(true);
    expect(isSkillToolName('remove_skill')).toBe(true);
  });

  it('should return false for non-skill tool names', () => {
    expect(isSkillToolName('runjs')).toBe(false);
    expect(isSkillToolName('dom')).toBe(false);
    expect(isSkillToolName('fetch')).toBe(false);
    expect(isSkillToolName('not_a_tool')).toBe(false);
  });
});
