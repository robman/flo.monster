/**
 * Hub-side state store that mirrors the browser-side state tool API.
 * Provides reactive state management and escalation rules for hub agents.
 */

import type { ToolDef, ToolResult } from './index.js';
import { evaluateSafeCondition } from '../utils/safe-eval.js';

export interface HubStateData {
  state: Record<string, unknown>;
  escalationRules: Record<string, { condition: string; message: string | null }>;
}

type ChangeCallback = (key: string, value: unknown, action: 'set' | 'delete') => void;

export interface StateLimits {
  maxKeys: number;       // Max number of keys per agent (default 1000)
  maxValueSize: number;  // Max bytes per value (default 1MB)
  maxTotalSize: number;  // Max total bytes per agent (default 10MB)
}

const DEFAULT_STATE_LIMITS: StateLimits = {
  maxKeys: 1000,
  maxValueSize: 1_000_000,     // 1MB
  maxTotalSize: 10_000_000,    // 10MB
};

export class HubAgentStateStore {
  private state: Record<string, unknown>;
  private escalationRules: Record<string, { condition: string; message: string | null }>;
  private listeners: Set<ChangeCallback> = new Set();
  private limits: StateLimits;

  constructor(initial?: HubStateData, limits?: Partial<StateLimits>) {
    this.state = initial?.state ? { ...initial.state } : {};
    this.escalationRules = initial?.escalationRules ? { ...initial.escalationRules } : {};
    this.limits = { ...DEFAULT_STATE_LIMITS, ...limits };
  }

  get(key: string): unknown {
    return this.state[key];
  }

  getAll(): Record<string, unknown> {
    return { ...this.state };
  }

  set(key: string, value: unknown): { error?: string } {
    // Check key count limit
    if (!(key in this.state) && Object.keys(this.state).length >= this.limits.maxKeys) {
      return { error: `State limit exceeded: max ${this.limits.maxKeys} keys` };
    }

    // Check value size limit
    const valueSize = this.estimateSize(value);
    if (valueSize > this.limits.maxValueSize) {
      return { error: `State limit exceeded: value size ${valueSize} bytes exceeds max ${this.limits.maxValueSize}` };
    }

    // Check total size limit (approximate — subtract old value if replacing)
    const oldSize = key in this.state ? this.estimateSize(this.state[key]) : 0;
    const newTotal = this.estimateTotalSize() - oldSize + valueSize;
    if (newTotal > this.limits.maxTotalSize) {
      return { error: `State limit exceeded: total size would be ${newTotal} bytes (max ${this.limits.maxTotalSize})` };
    }

    this.state[key] = value;
    this.fireChange(key, value, 'set');
    return {};
  }

  delete(key: string): void {
    const value = this.state[key];
    delete this.state[key];
    this.fireChange(key, value, 'delete');
  }

  getEscalationRules(): Array<{ key: string; condition: string; message: string | null }> {
    return Object.entries(this.escalationRules).map(([key, rule]) => ({
      key,
      condition: rule.condition,
      message: rule.message,
    }));
  }

  setEscalation(key: string, condition: string, message?: string): void {
    this.escalationRules[key] = { condition, message: message ?? null };
  }

  clearEscalation(key: string): void {
    delete this.escalationRules[key];
  }

  evaluateEscalation(key: string, value: unknown): { triggered: boolean; message?: string } {
    const rule = this.escalationRules[key];
    if (!rule) {
      return { triggered: false };
    }

    const result = evaluateSafeCondition(rule.condition, value);
    if (result) {
      return { triggered: true, message: rule.message ?? undefined };
    }
    return { triggered: false };
  }

  onChange(cb: ChangeCallback): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  serialize(): HubStateData {
    return {
      state: { ...this.state },
      escalationRules: { ...this.escalationRules },
    };
  }

  private estimateSize(value: unknown): number {
    return JSON.stringify(value)?.length ?? 0;
  }

  private estimateTotalSize(): number {
    let total = 0;
    for (const v of Object.values(this.state)) {
      total += this.estimateSize(v);
    }
    return total;
  }

  private fireChange(key: string, value: unknown, action: 'set' | 'delete'): void {
    for (const cb of this.listeners) {
      cb(key, value, action);
    }
  }
}

export const hubStateToolDef: ToolDef = {
  name: 'state',
  description:
    'Reactive state management. Read/write persistent state and manage escalation rules that wake the agent when conditions are met.',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'get',
          'get_all',
          'set',
          'delete',
          'escalation_rules',
          'escalate',
          'clear_escalation',
        ],
        description: 'State action to perform',
      },
      key: {
        type: 'string',
        description: 'State key (required for get, set, delete, escalate, clear_escalation)',
      },
      value: {
        type: 'object',
        description: 'Value to set (any JSON type, required for set)',
      },
      condition: {
        type: 'string',
        description:
          'Condition expression for escalation. Keywords: "always", "changed". Comparisons: "> N", "< N", ">= N", "<= N", "== value", "!= value". Example: "> 100"',
      },
      message: {
        type: 'string',
        description: 'Context message included when escalation fires',
      },
    },
    required: ['action'] as const,
  },
};

export function executeHubState(
  input: { action: string; key?: string; value?: unknown; condition?: string; message?: string },
  stateStore: HubAgentStateStore,
): ToolResult {
  switch (input.action) {
    case 'get': {
      if (!input.key) {
        return { content: 'Missing required parameter: key', is_error: true };
      }
      const value = stateStore.get(input.key);
      if (value === undefined) {
        return { content: 'Key not found' };
      }
      return { content: JSON.stringify(value) };
    }

    case 'get_all': {
      return { content: JSON.stringify(stateStore.getAll()) };
    }

    case 'set': {
      if (!input.key) {
        return { content: 'Missing required parameter: key', is_error: true };
      }
      const result = stateStore.set(input.key, input.value);
      if (result.error) {
        return { content: result.error, is_error: true };
      }
      return { content: 'State updated' };
    }

    case 'delete': {
      if (!input.key) {
        return { content: 'Missing required parameter: key', is_error: true };
      }
      stateStore.delete(input.key);
      return { content: 'State key deleted' };
    }

    case 'escalation_rules': {
      return { content: JSON.stringify(stateStore.getEscalationRules()) };
    }

    case 'escalate': {
      if (!input.key) {
        return { content: 'Missing required parameter: key', is_error: true };
      }
      if (!input.condition) {
        return { content: 'Missing required parameter: condition', is_error: true };
      }
      stateStore.setEscalation(input.key, input.condition, input.message);
      return { content: 'Escalation rule set' };
    }

    case 'clear_escalation': {
      if (!input.key) {
        return { content: 'Missing required parameter: key', is_error: true };
      }
      stateStore.clearEscalation(input.key);
      return { content: 'Escalation rule cleared' };
    }

    default: {
      return { content: `Unknown state action: ${input.action}`, is_error: true };
    }
  }
}
