import type { ToolPlugin, ToolResult, ShellToolContext, ToolDef } from '@flo-monster/core';
import { parseSkillMd } from '@flo-monster/core';
import type { SkillManager } from '../../shell/skill-manager.js';
import type { PersistenceLayer } from '../../shell/persistence.js';
import {
  listSkillsToolDef,
  getSkillToolDef,
  createSkillToolDef,
  removeSkillToolDef,
  SKILL_TOOL_NAMES,
} from './skill-tools.js';

/**
 * Dependencies for the skill tools plugin
 */
export interface SkillToolsPluginDeps {
  skillManager: SkillManager;
  persistence: PersistenceLayer;
  /** Show approval dialog for installing a new skill. Returns true if approved. */
  showApprovalDialog: (skill: { name: string; description: string; content: string }) => Promise<boolean>;
  /** Show confirmation dialog for removing a skill. Returns true if confirmed. */
  showConfirmDialog: (message: string) => Promise<boolean>;
}

/**
 * Create skill tool plugins that interact with the shell's SkillManager.
 * Returns an array of ToolPlugin objects, one for each skill tool.
 */
export function createSkillToolsPlugins(deps: SkillToolsPluginDeps): ToolPlugin[] {
  const { skillManager, persistence, showApprovalDialog, showConfirmDialog } = deps;

  const listSkillsPlugin: ToolPlugin = {
    definition: listSkillsToolDef,
    async execute(_input: Record<string, unknown>, context: ShellToolContext): Promise<ToolResult> {
      // Browser-side skill listing: hasHub is false because browser agents aren't hub-persisted.
      // Hub-persisted agents route list_skills to the hub (HUB_TOOLS), so this code only runs
      // for browser-local agents. The hub side sets { hasHub: true, hasBrowser: true }.
      const skills = skillManager.listAgentVisibleSkills(context.agentId, {
        hasBrowser: true,
        hasHub: false,
      });
      const result = skills.map(s => ({
        name: s.name,
        description: s.manifest.description,
        category: s.manifest.category || 'user',
        argumentHint: s.manifest.argumentHint,
        allowedTools: s.manifest.allowedTools,
      }));
      return { content: JSON.stringify(result, null, 2) };
    },
  };

  const getSkillPlugin: ToolPlugin = {
    definition: getSkillToolDef,
    async execute(input: Record<string, unknown>, context: ShellToolContext): Promise<ToolResult> {
      const name = input.name as string;
      if (!name) {
        return { content: 'Missing required parameter: name', is_error: true };
      }

      const skill = skillManager.getSkill(name);
      if (!skill) {
        return { content: `Skill "${name}" not found`, is_error: true };
      }

      // Capability check: don't return skills the agent can't use
      if (skill.manifest.requiredCapabilities) {
        const ctx = { hasBrowser: true, hasHub: false };
        for (const cap of skill.manifest.requiredCapabilities) {
          if (cap === 'hub' && !ctx.hasHub) {
            return { content: `Skill "${name}" requires hub persistence (not available for browser agents)`, is_error: true };
          }
        }
      }

      // Track that this agent loaded (used) this skill
      skillManager.trackUsage(context.agentId, name);

      return {
        content: JSON.stringify({
          name: skill.name,
          manifest: skill.manifest,
          instructions: skill.instructions,
          source: skill.source,
        }, null, 2),
      };
    },
  };

  const createSkillPlugin: ToolPlugin = {
    definition: createSkillToolDef,
    async execute(input: Record<string, unknown>, _context: ShellToolContext): Promise<ToolResult> {
      const content = input.content as string;
      if (!content) {
        return { content: 'Missing required parameter: content', is_error: true };
      }

      // Parse and validate the skill content
      let parsed;
      try {
        parsed = parseSkillMd(content);
      } catch (err) {
        return {
          content: `Invalid skill format: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        };
      }

      // Check if skill already exists
      if (skillManager.hasSkill(parsed.manifest.name)) {
        return { content: `Skill "${parsed.manifest.name}" already exists`, is_error: true };
      }

      // Show approval dialog
      const approved = await showApprovalDialog({
        name: parsed.manifest.name,
        description: parsed.manifest.description,
        content,
      });

      if (!approved) {
        return { content: `User rejected installation of skill "${parsed.manifest.name}"` };
      }

      // Install the skill
      skillManager.installBuiltin({
        name: parsed.manifest.name,
        manifest: parsed.manifest,
        instructions: parsed.instructions,
        source: { type: 'local' },
        installedAt: Date.now(),
      });

      // Persist
      try {
        const settings = await persistence.getSettings();
        settings.installedSkills = skillManager.exportEntries();
        await persistence.saveSettings(settings);
      } catch (err) {
        console.warn('[skill-tools] Failed to persist skill:', err);
        // Don't fail the tool call, the skill is installed in memory
      }

      return { content: `Skill "${parsed.manifest.name}" installed successfully` };
    },
  };

  const removeSkillPlugin: ToolPlugin = {
    definition: removeSkillToolDef,
    async execute(input: Record<string, unknown>, _context: ShellToolContext): Promise<ToolResult> {
      const name = input.name as string;
      if (!name) {
        return { content: 'Missing required parameter: name', is_error: true };
      }

      const skill = skillManager.getSkill(name);
      if (!skill) {
        return { content: `Skill "${name}" not found`, is_error: true };
      }

      if (skill.source.type === 'builtin') {
        return { content: `Cannot remove builtin skill "${name}"`, is_error: true };
      }

      // Show confirmation dialog
      const confirmed = await showConfirmDialog(`Remove skill "${name}"?`);
      if (!confirmed) {
        return { content: `User cancelled removal of skill "${name}"` };
      }

      skillManager.removeSkill(name);

      // Persist
      try {
        const settings = await persistence.getSettings();
        settings.installedSkills = skillManager.exportEntries();
        await persistence.saveSettings(settings);
      } catch (err) {
        console.warn('[skill-tools] Failed to persist skill removal:', err);
        // Don't fail the tool call, the skill is removed from memory
      }

      return { content: `Skill "${name}" removed successfully` };
    },
  };

  return [listSkillsPlugin, getSkillPlugin, createSkillPlugin, removeSkillPlugin];
}

/**
 * Check if a tool name is handled by the skill tools plugin
 */
export function isSkillToolName(name: string): boolean {
  return SKILL_TOOL_NAMES.includes(name as typeof SKILL_TOOL_NAMES[number]);
}
