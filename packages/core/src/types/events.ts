import type { TokenUsage } from './messages.js';
import type { ToolResult } from './tools.js';
import type { AgentState, AgentViewState } from './agent.js';
import type { CostEstimate } from './provider.js';

export interface MessageStartEvent {
  type: 'message_start';
  messageId: string;
}

export interface TextDeltaEvent {
  type: 'text_delta';
  text: string;
}

export interface TextDoneEvent {
  type: 'text_done';
  text: string;
}

export interface ToolUseStartEvent {
  type: 'tool_use_start';
  toolUseId: string;
  toolName: string;
}

export interface ToolUseInputDeltaEvent {
  type: 'tool_use_input_delta';
  toolUseId: string;
  partialJson: string;
}

export interface ToolUseDoneEvent {
  type: 'tool_use_done';
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  thoughtSignature?: string;
}

export interface ToolResultEvent {
  type: 'tool_result';
  toolUseId: string;
  result: ToolResult;
}

export interface TurnEndEvent {
  type: 'turn_end';
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
}

export interface UsageEvent {
  type: 'usage';
  usage: TokenUsage;
  cost: CostEstimate;
}

export interface ErrorEvent {
  type: 'error';
  error: string;
  code?: string;
}

export interface StateChangeEvent {
  type: 'state_change';
  from: AgentState;
  to: AgentState;
}

export interface BudgetExceededEvent {
  type: 'budget_exceeded';
  reason: 'token_limit' | 'cost_limit' | 'iteration_limit';
  message: string;
}

export interface VisibilityChangeEvent {
  type: 'visibility_change';
  visible: boolean;
}

export interface ViewStateChangeEvent {
  type: 'view_state_change';
  from: AgentViewState;
  to: AgentViewState;
  requestedBy: 'user' | 'agent';
}

export interface LoopCompleteEvent {
  type: 'loop_complete';
}

export type AgentEvent =
  | MessageStartEvent
  | TextDeltaEvent
  | TextDoneEvent
  | ToolUseStartEvent
  | ToolUseInputDeltaEvent
  | ToolUseDoneEvent
  | ToolResultEvent
  | TurnEndEvent
  | UsageEvent
  | ErrorEvent
  | StateChangeEvent
  | BudgetExceededEvent
  | VisibilityChangeEvent
  | ViewStateChangeEvent
  | LoopCompleteEvent;

export function isTextEvent(event: AgentEvent): event is TextDeltaEvent | TextDoneEvent {
  return event.type === 'text_delta' || event.type === 'text_done';
}

export function isToolEvent(
  event: AgentEvent,
): event is ToolUseStartEvent | ToolUseInputDeltaEvent | ToolUseDoneEvent | ToolResultEvent {
  return (
    event.type === 'tool_use_start' ||
    event.type === 'tool_use_input_delta' ||
    event.type === 'tool_use_done' ||
    event.type === 'tool_result'
  );
}
