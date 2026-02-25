/**
 * Tool registry for the hub server
 */

import { bashToolDef, executeBash, type BashInput } from './bash.js';
import { filesystemToolDef, executeFilesystem, type FilesystemInput } from './filesystem.js';
import { skillToolDefs, isSkillTool, executeSkillTool } from './skill-tools.js';
import { browseToolDef } from './browse.js';
import type { HubConfig } from '../config.js';
import type { HookExecutor } from '../hook-executor.js';
import type { HubSkillManager } from '../skill-manager.js';
import type { DeclarativeHookEvaluator } from '../declarative-hook-evaluator.js';

export { bashToolDef, executeBash, type BashInput } from './bash.js';
export { filesystemToolDef, executeFilesystem, type FilesystemInput } from './filesystem.js';
export { skillToolDefs, isSkillTool, executeSkillTool } from './skill-tools.js';
export { hubStateToolDef, HubAgentStateStore, executeHubState, type HubStateData } from './hub-state.js';
export { hubFilesToolDef, executeHubFiles, validateFilePath, unpackFilesToDisk, type HubFilesInput } from './hub-files.js';
export { scheduleToolDef, executeScheduleTool, type ScheduleToolInput } from './schedule.js';
export { contextSearchToolDef, executeHubContextSearch } from './context-search.js';
export { hubRunJsToolDef, executeHubRunJs, type HubRunJsDeps, type RunJsLogEntry } from './hub-runjs.js';
export { browseToolDef, executeBrowse, type BrowseInput, type BrowseDeps } from './browse.js';

export interface ToolDef {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: readonly string[];
  };
}

export interface ToolResult {
  content: string;
  is_error?: boolean;
}

export type ToolInput = BashInput | FilesystemInput | Record<string, unknown>;

/**
 * Get all available tool definitions
 */
export function getToolDefinitions(config: HubConfig, includeSkillTools = true): ToolDef[] {
  const tools: ToolDef[] = [];

  if (config.tools.bash.enabled) {
    tools.push(bashToolDef);
  }

  if (config.tools.filesystem.enabled) {
    tools.push(filesystemToolDef);
  }

  if (config.tools.browse?.enabled) {
    tools.push(browseToolDef);
  }

  // Add skill tools (always enabled when requested)
  if (includeSkillTools) {
    tools.push(...skillToolDefs);
  }

  return tools;
}

// Skill approval request function type
export type SkillApprovalFn = (skill: { name: string; description: string; content: string }) => Promise<boolean>;

/**
 * Execute a tool by name
 */
export async function executeTool(
  name: string,
  input: ToolInput,
  config: HubConfig,
  hookExecutor?: HookExecutor,
  skillManager?: HubSkillManager,
  requestSkillApproval?: SkillApprovalFn,
  agentId?: string,
  declarativeHookEvaluator?: DeclarativeHookEvaluator,
): Promise<ToolResult> {
  // Evaluate declarative hooks (from agent session)
  if (declarativeHookEvaluator) {
    const hookResult = declarativeHookEvaluator.evaluatePreToolUse(
      name,
      input as unknown as Record<string, unknown>,
    );
    if (hookResult.decision === 'deny') {
      return { content: hookResult.reason || 'Blocked by declarative hook', is_error: true };
    }
  }

  // Run PreToolUse hooks if executor is provided
  if (hookExecutor) {
    const preResult = await hookExecutor.runPreToolUse({
      toolName: name,
      toolInput: input as unknown as Record<string, unknown>,
      sandboxPath: config.sandboxPath ?? '',
    });
    if (preResult.blocked) {
      return { content: preResult.blockReason || 'Blocked by hook', is_error: true };
    }
  }

  // Execute the tool
  let result: ToolResult;

  // Check if this is a skill tool
  if (isSkillTool(name) && skillManager) {
    result = await executeSkillTool(name, input as Record<string, unknown>, skillManager, requestSkillApproval, agentId);
  } else {
    switch (name) {
      case 'bash':
        result = await executeBash(input as BashInput, config);
        break;
      case 'filesystem':
        result = await executeFilesystem(input as FilesystemInput, config);
        break;
      default:
        result = { content: `Unknown tool: ${name}`, is_error: true };
    }
  }

  // Run PostToolUse hooks if executor is provided
  if (hookExecutor) {
    await hookExecutor.runPostToolUse({
      toolName: name,
      toolInput: input as unknown as Record<string, unknown>,
      toolResult: { content: result.content, is_error: result.is_error },
      sandboxPath: config.sandboxPath ?? '',
    });
  }

  // Evaluate declarative post-tool hooks
  if (declarativeHookEvaluator) {
    declarativeHookEvaluator.evaluatePostToolUse(
      name,
      input as unknown as Record<string, unknown>,
    );
  }

  return result;
}
