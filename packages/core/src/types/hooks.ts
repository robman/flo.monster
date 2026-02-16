export type HookType = 'pre_tool_use' | 'post_tool_use' | 'user_prompt_submit' | 'stop' | 'agent_start' | 'agent_end';
export type HookDecision = 'allow' | 'deny' | 'default';

export interface HookMatcher {
  toolNamePattern?: string; // Regex pattern for tool name matching
}

export interface PreToolUseInput {
  type: 'pre_tool_use';
  agentId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

export interface PostToolUseInput {
  type: 'post_tool_use';
  agentId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult: { content: string; is_error?: boolean };
}

export interface StopInput {
  type: 'stop';
  agentId: string;
  stopReason: string;
}

export interface AgentStartInput {
  type: 'agent_start';
  agentId: string;
}

export interface AgentEndInput {
  type: 'agent_end';
  agentId: string;
}

export interface UserPromptSubmitInput {
  type: 'user_prompt_submit';
  agentId: string;
  prompt: string;
}

export type HookInput =
  | PreToolUseInput
  | PostToolUseInput
  | StopInput
  | AgentStartInput
  | AgentEndInput
  | UserPromptSubmitInput;

export interface HookResult {
  decision: HookDecision;
  reason?: string;
  modifiedInput?: Record<string, unknown>;
}

export type HookCallback = (input: HookInput) => HookResult | Promise<HookResult>;

export interface HookRegistration {
  id: string;
  type: HookType;
  callback: HookCallback;
  matcher?: HookMatcher;
  priority?: number; // Higher priority = evaluated first
}

export interface HooksConfig {
  activeHookTypes: HookType[];
}

// Declarative hook configuration (following Claude Code's model)
export interface HookActionConfig {
  type: 'action';
  action: 'deny' | 'allow' | 'log' | 'script';
  reason?: string;
  script?: string;  // JavaScript code (for 'script' action)
  continueOnError?: boolean;  // default true — log failures but don't affect hook decision
}

export interface HookRuleConfig {
  matcher?: string;  // regex for tool name matching (PreToolUse, PostToolUse only)
  inputMatchers?: Record<string, string>;  // field name -> regex pattern for tool input matching
  hooks: HookActionConfig[];
  priority?: number;
}

export interface HookRulesConfig {
  PreToolUse?: HookRuleConfig[];
  PostToolUse?: HookRuleConfig[];
  Stop?: HookRuleConfig[];
  UserPromptSubmit?: HookRuleConfig[];
  AgentStart?: HookRuleConfig[];
  AgentEnd?: HookRuleConfig[];
}

// Hub-side hook configuration
export interface HubHookRule {
  matcher?: string;  // tool name regex
  inputMatchers?: Record<string, string>;  // input field regexes
  command: string;  // shell command template
  timeout?: number;  // ms, default 5000
  continueOnError?: boolean;  // default true — log failures but don't fail tool
}

export interface HubHooksConfig {
  PreToolUse?: HubHookRule[];
  PostToolUse?: HubHookRule[];
}
