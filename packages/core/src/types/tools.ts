import type { ContentBlock, JsonSchema } from './messages.js';
import type { AgentConfig } from './agent.js';
import type { ExtensionContext } from './extension.js';

export interface ToolDef {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

export interface ToolHandler {
  definition: ToolDef;
  execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

export interface ToolResult {
  content: string | ContentBlock[];
  is_error?: boolean;
}

export interface ToolContext {
  agentId: string;
  sendToShell(msg: unknown): void;
  waitForResponse(id: string): Promise<unknown>;
}

export interface ShellToolContext {
  agentId: string;
  agentConfig: AgentConfig;
  /** Extension context (only available for extension tools) */
  extensionContext?: ExtensionContext;
}

export interface ToolPlugin {
  definition: ToolDef;
  /** Optional extension ID this tool belongs to */
  extensionId?: string;
  execute(input: Record<string, unknown>, context: ShellToolContext): Promise<ToolResult>;
}

export type ToolSecurityTier = 'immediate' | 'prompted' | 'blocked';

export const TOOL_TIERS: Record<string, ToolSecurityTier> = {
  // Immediate - safe browser-local tools
  storage: 'immediate',
  dom: 'immediate',
  files: 'immediate',
  view_state: 'immediate',
  audit_log: 'immediate',
  subagent: 'immediate',
  capabilities: 'immediate',
  agent_respond: 'immediate',
  worker_message: 'immediate',
  context_search: 'immediate',
  // Prompted - network tools require user approval (per-origin)
  fetch: 'prompted',
  web_fetch: 'prompted',
  web_search: 'prompted',
  browse: 'prompted',
  // Blocked - hub/system tools not allowed from srcdoc JS
  bash: 'blocked',
  read_file: 'blocked',
  write_file: 'blocked',
  list_directory: 'blocked',
};

export function getToolTier(toolName: string): ToolSecurityTier {
  return TOOL_TIERS[toolName] ?? 'blocked';  // Unknown tools default to blocked
}
