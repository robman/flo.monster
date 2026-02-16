import { describe, it, expect } from 'vitest';
import {
  listSkillsToolDef,
  getSkillToolDef,
  createSkillToolDef,
  removeSkillToolDef,
  SKILL_TOOL_DEFS,
  getSkillToolDefinitions,
  SKILL_TOOL_NAMES,
  isSkillTool,
} from './skill-tools.js';

describe('skill tool definitions', () => {
  describe('listSkillsToolDef', () => {
    it('should have correct name', () => {
      expect(listSkillsToolDef.name).toBe('list_skills');
    });

    it('should have a description', () => {
      expect(listSkillsToolDef.description).toBeTruthy();
      expect(listSkillsToolDef.description.length).toBeGreaterThan(10);
    });

    it('should have valid input_schema with no required properties', () => {
      expect(listSkillsToolDef.input_schema).toBeDefined();
      expect(listSkillsToolDef.input_schema.type).toBe('object');
      expect(listSkillsToolDef.input_schema.required).toEqual([]);
    });
  });

  describe('getSkillToolDef', () => {
    it('should have correct name', () => {
      expect(getSkillToolDef.name).toBe('get_skill');
    });

    it('should have a description', () => {
      expect(getSkillToolDef.description).toBeTruthy();
      expect(getSkillToolDef.description.length).toBeGreaterThan(10);
    });

    it('should have valid input_schema with name property', () => {
      expect(getSkillToolDef.input_schema).toBeDefined();
      expect(getSkillToolDef.input_schema.type).toBe('object');
      expect(getSkillToolDef.input_schema.properties).toHaveProperty('name');
      expect(getSkillToolDef.input_schema.required).toContain('name');
    });
  });

  describe('createSkillToolDef', () => {
    it('should have correct name', () => {
      expect(createSkillToolDef.name).toBe('create_skill');
    });

    it('should have a description', () => {
      expect(createSkillToolDef.description).toBeTruthy();
      expect(createSkillToolDef.description.length).toBeGreaterThan(10);
    });

    it('should have valid input_schema with content property', () => {
      expect(createSkillToolDef.input_schema).toBeDefined();
      expect(createSkillToolDef.input_schema.type).toBe('object');
      expect(createSkillToolDef.input_schema.properties).toHaveProperty('content');
      expect(createSkillToolDef.input_schema.required).toContain('content');
    });
  });

  describe('removeSkillToolDef', () => {
    it('should have correct name', () => {
      expect(removeSkillToolDef.name).toBe('remove_skill');
    });

    it('should have a description', () => {
      expect(removeSkillToolDef.description).toBeTruthy();
      expect(removeSkillToolDef.description.length).toBeGreaterThan(10);
    });

    it('should have valid input_schema with name property', () => {
      expect(removeSkillToolDef.input_schema).toBeDefined();
      expect(removeSkillToolDef.input_schema.type).toBe('object');
      expect(removeSkillToolDef.input_schema.properties).toHaveProperty('name');
      expect(removeSkillToolDef.input_schema.required).toContain('name');
    });
  });

  describe('SKILL_TOOL_DEFS', () => {
    it('should contain all four tool definitions', () => {
      expect(SKILL_TOOL_DEFS).toHaveLength(4);
      const names = SKILL_TOOL_DEFS.map(d => d.name);
      expect(names).toContain('list_skills');
      expect(names).toContain('get_skill');
      expect(names).toContain('create_skill');
      expect(names).toContain('remove_skill');
    });
  });

  describe('getSkillToolDefinitions', () => {
    it('should return a copy of the tool definitions', () => {
      const defs = getSkillToolDefinitions();
      expect(defs).toHaveLength(4);
      expect(defs).not.toBe(SKILL_TOOL_DEFS);
      expect(defs).toEqual(SKILL_TOOL_DEFS);
    });
  });

  describe('SKILL_TOOL_NAMES', () => {
    it('should contain all skill tool names', () => {
      expect(SKILL_TOOL_NAMES).toEqual([
        'list_skills',
        'get_skill',
        'create_skill',
        'remove_skill',
      ]);
    });
  });

  describe('isSkillTool', () => {
    it('should return true for skill tool names', () => {
      expect(isSkillTool('list_skills')).toBe(true);
      expect(isSkillTool('get_skill')).toBe(true);
      expect(isSkillTool('create_skill')).toBe(true);
      expect(isSkillTool('remove_skill')).toBe(true);
    });

    it('should return false for non-skill tool names', () => {
      expect(isSkillTool('runjs')).toBe(false);
      expect(isSkillTool('dom')).toBe(false);
      expect(isSkillTool('fetch')).toBe(false);
      expect(isSkillTool('not_a_tool')).toBe(false);
    });
  });
});
