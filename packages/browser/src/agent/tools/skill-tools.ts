import type { ToolDef } from '@flo-monster/core';

/**
 * Skill tool definitions - these tools allow agents to interact with the skill system.
 * The actual execution happens in the shell context via createSkillToolsPlugin.
 */

/**
 * Lists all user-invocable skills
 * Returns: Array of { name, description, argumentHint?, allowedTools? }
 */
export const listSkillsToolDef: ToolDef = {
  name: 'list_skills',
  description: 'List all available skills — system reference skills (API docs, patterns, guides) and user-invocable /command skills',
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

/**
 * Gets full details of a skill including instructions
 * Input: { name: string }
 * Returns: Full skill details or error if not found
 */
export const getSkillToolDef: ToolDef = {
  name: 'get_skill',
  description: 'Get full details of a skill including its instructions',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'The skill name (without the / prefix)',
      },
    },
    required: ['name'],
  },
};

/**
 * Creates a new skill (requires user approval)
 * Input: { content: string } - SKILL.md format content
 * Returns: Success message or rejection reason
 */
export const createSkillToolDef: ToolDef = {
  name: 'create_skill',
  description: 'Create a new skill. The content should be in SKILL.md format with YAML frontmatter. Requires user approval before installation.',
  input_schema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'The skill content in SKILL.md format (YAML frontmatter + instructions)',
      },
    },
    required: ['content'],
  },
};

/**
 * Removes an installed skill (requires user confirmation)
 * Input: { name: string }
 * Returns: Success message or error
 */
export const removeSkillToolDef: ToolDef = {
  name: 'remove_skill',
  description: 'Remove an installed skill. Requires user confirmation. Cannot remove builtin skills.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'The skill name to remove (without the / prefix)',
      },
    },
    required: ['name'],
  },
};

/**
 * All skill tool definitions
 */
export const SKILL_TOOL_DEFS: ToolDef[] = [
  listSkillsToolDef,
  getSkillToolDef,
  createSkillToolDef,
  removeSkillToolDef,
];

/**
 * Returns all skill tool definitions.
 */
export function getSkillToolDefinitions(): ToolDef[] {
  return [...SKILL_TOOL_DEFS];
}

/**
 * Skill tool names for identification
 */
export const SKILL_TOOL_NAMES = ['list_skills', 'get_skill', 'create_skill', 'remove_skill'] as const;
export type SkillToolName = typeof SKILL_TOOL_NAMES[number];

/**
 * Check if a tool name is a skill tool
 */
export function isSkillTool(name: string): name is SkillToolName {
  return SKILL_TOOL_NAMES.includes(name as SkillToolName);
}
