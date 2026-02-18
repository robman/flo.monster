/**
 * Cron scheduler and event trigger system for hub agents.
 * Enables autonomous execution: agents schedule cron jobs and event triggers.
 * The hub daemon evaluates triggers and wakes agents when conditions are met.
 */

import type { HeadlessAgentRunner, RunnerState } from './agent-runner.js';
import { evaluateSafeCondition } from './utils/safe-eval.js';

export interface ScheduleEntry {
  id: string;
  hubAgentId: string;
  type: 'cron' | 'event';
  cronExpression?: string;      // "*/5 * * * *"
  eventName?: string;           // "state:score", "browser:connected"
  eventCondition?: string;      // "> 100" (for state events)
  message?: string;             // sent to agent when triggered (required if no tool)
  enabled: boolean;
  maxRuns?: number;             // stop after N runs (undefined = unlimited)
  runCount: number;
  createdAt: number;
  lastRunAt?: number;
  tool?: string;                // tool to execute directly (no agent wakeup)
  toolInput?: Record<string, unknown>;  // input for direct tool execution
}

export interface SchedulerDeps {
  getRunner: (hubAgentId: string) => HeadlessAgentRunner | undefined;
  executeToolForAgent?: (hubAgentId: string, toolName: string, toolInput: Record<string, unknown>) => Promise<{ content: string; is_error?: boolean }>;
}

/** Max schedules per agent */
const MAX_SCHEDULES_PER_AGENT = 10;
/** Minimum cron interval: 1 minute */
const MIN_CRON_INTERVAL_MS = 60000;

export class Scheduler {
  private entries = new Map<string, ScheduleEntry>();
  private timer?: ReturnType<typeof setInterval>;
  private tickIntervalMs: number;
  private deps: SchedulerDeps;
  private nextId = 1;
  private lastTickMinute = -1;  // Prevent duplicate ticks in same minute

  constructor(deps: SchedulerDeps, tickIntervalMs = 30000) {
    this.deps = deps;
    this.tickIntervalMs = tickIntervalMs;
  }

  /** Start the cron tick timer */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickIntervalMs);
  }

  /** Stop the timer and clear pending */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Add a new schedule entry. Returns the entry ID. */
  addSchedule(params: {
    hubAgentId: string;
    type: 'cron' | 'event';
    cronExpression?: string;
    eventName?: string;
    eventCondition?: string;
    message?: string;
    enabled?: boolean;
    maxRuns?: number;
    tool?: string;
    toolInput?: Record<string, unknown>;
  }): string {
    // Validate
    if (params.type === 'cron') {
      if (!params.cronExpression) throw new Error('cronExpression required for cron type');
      // Validate cron expression
      Scheduler.parseCron(params.cronExpression);
      // Check minimum interval (reject */0 or unreasonably fast)
    }
    if (params.type === 'event') {
      if (!params.eventName) throw new Error('eventName required for event type');
    }

    // Must have exactly one of message or tool
    if (params.message && params.tool) {
      throw new Error('Cannot specify both message and tool — use one or the other');
    }
    if (!params.message && !params.tool) {
      throw new Error('Must specify either message or tool');
    }

    // Check max schedules per agent
    const agentCount = this.getSchedules(params.hubAgentId).length;
    if (agentCount >= MAX_SCHEDULES_PER_AGENT) {
      throw new Error(`Maximum ${MAX_SCHEDULES_PER_AGENT} schedules per agent exceeded`);
    }

    const id = `sched-${this.nextId++}`;
    const entry: ScheduleEntry = {
      id,
      hubAgentId: params.hubAgentId,
      type: params.type,
      cronExpression: params.cronExpression,
      eventName: params.eventName,
      eventCondition: params.eventCondition,
      message: params.message,
      enabled: params.enabled !== false,
      maxRuns: params.maxRuns,
      runCount: 0,
      createdAt: Date.now(),
      tool: params.tool,
      toolInput: params.toolInput,
    };

    this.entries.set(id, entry);
    return id;
  }

  /** Remove a schedule by ID (only if it belongs to the given agent) */
  removeSchedule(hubAgentId: string, id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.hubAgentId !== hubAgentId) return false;
    this.entries.delete(id);
    return true;
  }

  /** Get all schedules for an agent */
  getSchedules(hubAgentId: string): ScheduleEntry[] {
    return Array.from(this.entries.values()).filter(e => e.hubAgentId === hubAgentId);
  }

  /** Enable a schedule (only if it belongs to the given agent) */
  enableSchedule(hubAgentId: string, id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.hubAgentId !== hubAgentId) return false;
    entry.enabled = true;
    return true;
  }

  /** Disable a schedule (only if it belongs to the given agent) */
  disableSchedule(hubAgentId: string, id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.hubAgentId !== hubAgentId) return false;
    entry.enabled = false;
    return true;
  }

  /** Remove all schedules for an agent */
  removeAllForAgent(hubAgentId: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.hubAgentId === hubAgentId) {
        this.entries.delete(id);
      }
    }
  }

  /** Fire an event — triggers matching event entries immediately */
  fireEvent(eventName: string, hubAgentId: string, data?: unknown): void {
    for (const entry of this.entries.values()) {
      if (!entry.enabled) continue;
      if (entry.type !== 'event') continue;
      if (entry.hubAgentId !== hubAgentId) continue;
      if (entry.eventName !== eventName) continue;

      // Check condition if specified
      if (entry.eventCondition && data !== undefined) {
        if (!Scheduler.evaluateCondition(entry.eventCondition, data)) continue;
      }

      void this.triggerEntry(entry).catch(err => {
        console.warn(`[Scheduler] Failed to trigger ${entry.id}:`, err);
      });
    }
  }

  /** Serialize all entries for persistence */
  serialize(): ScheduleEntry[] {
    return Array.from(this.entries.values());
  }

  /** Restore entries from persistence */
  restore(entries: ScheduleEntry[]): void {
    for (const entry of entries) {
      this.entries.set(entry.id, entry);
      // Track max ID for nextId
      const match = entry.id.match(/^sched-(\d+)$/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num >= this.nextId) this.nextId = num + 1;
      }
    }
  }

  // ── Cron helpers (static, exported for testing) ──

  /** Check if a cron expression should run at the given time */
  static shouldRunCron(cronExpr: string, now: Date): boolean {
    const fields = Scheduler.parseCron(cronExpr);
    const minute = now.getMinutes();
    const hour = now.getHours();
    const dayOfMonth = now.getDate();
    const month = now.getMonth() + 1;  // 1-based
    const dayOfWeek = now.getDay();    // 0=Sunday

    return (
      fields.minutes.includes(minute) &&
      fields.hours.includes(hour) &&
      fields.daysOfMonth.includes(dayOfMonth) &&
      fields.months.includes(month) &&
      fields.daysOfWeek.includes(dayOfWeek)
    );
  }

  /** Parse a single cron field into an array of matching values */
  static parseCronField(field: string, min: number, max: number): number[] {
    const values: number[] = [];

    for (const part of field.split(',')) {
      const trimmed = part.trim();

      // */N — step
      if (trimmed.startsWith('*/')) {
        const step = parseInt(trimmed.slice(2), 10);
        if (isNaN(step) || step <= 0) throw new Error(`Invalid cron step: ${trimmed}`);
        for (let i = min; i <= max; i += step) {
          values.push(i);
        }
        continue;
      }

      // * — all values
      if (trimmed === '*') {
        for (let i = min; i <= max; i++) {
          values.push(i);
        }
        continue;
      }

      // N-M — range
      if (trimmed.includes('-')) {
        const [startStr, endStr] = trimmed.split('-');
        const start = parseInt(startStr, 10);
        const end = parseInt(endStr, 10);
        if (isNaN(start) || isNaN(end) || start < min || end > max || start > end) {
          throw new Error(`Invalid cron range: ${trimmed}`);
        }
        for (let i = start; i <= end; i++) {
          values.push(i);
        }
        continue;
      }

      // N — specific value
      const num = parseInt(trimmed, 10);
      if (isNaN(num) || num < min || num > max) {
        throw new Error(`Invalid cron value: ${trimmed} (expected ${min}-${max})`);
      }
      values.push(num);
    }

    return [...new Set(values)].sort((a, b) => a - b);
  }

  /** Parse a full 5-field cron expression */
  static parseCron(expr: string): {
    minutes: number[];
    hours: number[];
    daysOfMonth: number[];
    months: number[];
    daysOfWeek: number[];
  } {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) {
      throw new Error(`Invalid cron expression: expected 5 fields, got ${parts.length}`);
    }

    return {
      minutes: Scheduler.parseCronField(parts[0], 0, 59),
      hours: Scheduler.parseCronField(parts[1], 0, 23),
      daysOfMonth: Scheduler.parseCronField(parts[2], 1, 31),
      months: Scheduler.parseCronField(parts[3], 1, 12),
      daysOfWeek: Scheduler.parseCronField(parts[4], 0, 6),
    };
  }

  /** Evaluate a condition against a value (declarative: "> 100", "< 5", "== value", "changed", "always") */
  static evaluateCondition(condition: string, value: unknown): boolean {
    return evaluateSafeCondition(condition, value);
  }

  // ── Private methods ──

  /** Tick handler — check all cron entries */
  private tick(): void {
    const now = new Date();
    const currentMinute = now.getFullYear() * 10000000 + (now.getMonth() + 1) * 100000 + now.getDate() * 1000 + now.getHours() * 60 + now.getMinutes();

    // Prevent duplicate ticks in the same minute
    if (currentMinute === this.lastTickMinute) return;
    this.lastTickMinute = currentMinute;

    for (const entry of this.entries.values()) {
      if (!entry.enabled) continue;
      if (entry.type !== 'cron') continue;
      if (!entry.cronExpression) continue;

      if (Scheduler.shouldRunCron(entry.cronExpression, now)) {
        void this.triggerEntry(entry).catch(err => {
          console.warn(`[Scheduler] Failed to trigger ${entry.id}:`, err);
        });
      }
    }
  }

  /** Trigger a schedule entry — send message to agent or execute tool directly */
  private async triggerEntry(entry: ScheduleEntry): Promise<void> {
    // Direct tool execution — no runner needed
    if (entry.tool) {
      if (!this.deps.executeToolForAgent) {
        console.warn(`[Scheduler] No executeToolForAgent — cannot execute tool for ${entry.id}`);
        return;
      }

      // Still need runner to be running for agent context
      const runner = this.deps.getRunner(entry.hubAgentId);
      if (!runner) return;
      const state = runner.getState();
      if (state !== 'running') return;

      // Update run count before execution
      entry.runCount++;
      entry.lastRunAt = Date.now();

      // Check maxRuns — disable after reaching limit
      if (entry.maxRuns !== undefined && entry.runCount >= entry.maxRuns) {
        entry.enabled = false;
      }

      try {
        const result = await this.deps.executeToolForAgent(entry.hubAgentId, entry.tool, entry.toolInput || {});
        if (result.is_error) {
          // Tool returned an error — notify the agent so it can self-correct
          runner.queueMessage(
            `[Scheduled task "${entry.id}" failed] Tool "${entry.tool}" returned error:\n${result.content}`
          );
        }
      } catch (err) {
        // Execution threw — notify the agent
        runner.queueMessage(
          `[Scheduled task "${entry.id}" failed] Tool "${entry.tool}" threw:\n${err instanceof Error ? err.message : String(err)}`
        );
      }
      return;
    }

    // Message-based trigger — wake the agent
    const runner = this.deps.getRunner(entry.hubAgentId);
    if (!runner) return;

    // Skip if agent is not running
    const state = runner.getState();
    if (state !== 'running') return;

    // Skip if agent is busy (don't queue — skip this trigger)
    if (runner.busy) return;

    // Update run count
    entry.runCount++;
    entry.lastRunAt = Date.now();

    // Check maxRuns — disable after reaching limit
    if (entry.maxRuns !== undefined && entry.runCount >= entry.maxRuns) {
      entry.enabled = false;
    }

    // Send the trigger message
    try {
      runner.sendMessage(entry.message!);
    } catch (err) {
      console.warn(`[Scheduler] Failed to trigger ${entry.id} for ${entry.hubAgentId}:`, err);
    }
  }
}
