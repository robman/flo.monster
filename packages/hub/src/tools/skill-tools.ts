/**
 * Skill tools for the hub server
 */

import type { ToolDef, ToolResult } from './index.js';
import type { HubSkillManager } from '../skill-manager.js';
import { parseSkillMd } from '@flo-monster/core';

export const skillToolDefs: ToolDef[] = [
  {
    name: 'list_skills',
    description: 'List all available skills that can be invoked with /command syntax',
    input_schema: {
      type: 'object',
      properties: {},
      required: [] as const,
    },
  },
  {
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
      required: ['name'] as const,
    },
  },
  {
    name: 'create_skill',
    description: 'Create a new skill. Content should be in SKILL.md format with YAML frontmatter.',
    input_schema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The skill content in SKILL.md format',
        },
      },
      required: ['content'] as const,
    },
  },
  {
    name: 'remove_skill',
    description: 'Remove an installed skill.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The skill name to remove',
        },
      },
      required: ['name'] as const,
    },
  },
];

export function isSkillTool(name: string): boolean {
  return ['list_skills', 'get_skill', 'create_skill', 'remove_skill'].includes(name);
}

export async function executeSkillTool(
  name: string,
  input: Record<string, unknown>,
  skillManager: HubSkillManager,
  requestApproval?: (skill: { name: string; description: string; content: string }) => Promise<boolean>,
  agentId?: string,
): Promise<ToolResult> {
  switch (name) {
    case 'list_skills': {
      // Use agent-visible listing which includes system skills + capability filtering
      // Hub agents always declare both capabilities (browser is potentially available)
      const skills = skillManager.listAgentVisibleSkills(agentId, { hasHub: true, hasBrowser: true });
      const result = skills.map(s => ({
        name: s.name,
        description: s.manifest.description,
        argumentHint: s.manifest.argumentHint,
        allowedTools: s.manifest.allowedTools,
      }));
      return { content: JSON.stringify(result, null, 2) };
    }

    case 'get_skill': {
      const skillName = input.name as string;
      const skill = skillManager.getSkill(skillName);
      if (!skill) {
        return { content: `Skill "${skillName}" not found`, is_error: true };
      }
      // Capability check: hub agents declare both capabilities (browser potentially available)
      if (skill.manifest.requiredCapabilities) {
        const ctx = { hasHub: true, hasBrowser: true };
        for (const cap of skill.manifest.requiredCapabilities) {
          if (cap === 'hub' && !ctx.hasHub) {
            return { content: `Skill "${skillName}" requires hub persistence`, is_error: true };
          }
          if (cap === 'browser' && !ctx.hasBrowser) {
            return { content: `Skill "${skillName}" requires browser access`, is_error: true };
          }
        }
      }
      // Track usage for dependency serialization
      if (agentId) {
        skillManager.trackUsage(agentId, skillName);
      }
      return {
        content: JSON.stringify({
          name: skill.name,
          manifest: skill.manifest,
          instructions: skill.instructions,
          source: skill.source,
        }, null, 2),
      };
    }

    case 'create_skill': {
      const content = input.content as string;

      // Parse and validate first
      let manifest;
      try {
        const parsed = parseSkillMd(content);
        manifest = parsed.manifest;
      } catch (err) {
        return {
          content: `Invalid skill format: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        };
      }

      // Request approval if handler available
      if (requestApproval) {
        try {
          const approved = await requestApproval({
            name: manifest.name,
            description: manifest.description,
            content,
          });
          if (!approved) {
            return {
              content: `Skill "${manifest.name}" installation was rejected by user`,
              is_error: true,
            };
          }
        } catch (err) {
          return {
            content: `Failed to get approval: ${err instanceof Error ? err.message : String(err)}`,
            is_error: true,
          };
        }
      }

      try {
        const skill = skillManager.install(content);
        return { content: `Skill "${skill.name}" installed successfully at ~/.flo-monster/skills/${skill.name}/` };
      } catch (err) {
        return {
          content: `Failed to install skill: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        };
      }
    }

    case 'remove_skill': {
      const skillName = input.name as string;

      if (!skillManager.hasSkill(skillName)) {
        return { content: `Skill "${skillName}" not found`, is_error: true };
      }

      const removed = skillManager.remove(skillName);
      if (removed) {
        return { content: `Skill "${skillName}" removed successfully` };
      } else {
        return { content: `Failed to remove skill "${skillName}"`, is_error: true };
      }
    }

    default:
      return { content: `Unknown skill tool: ${name}`, is_error: true };
  }
}
