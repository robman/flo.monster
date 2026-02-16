import type { AuditEntry, AuditEventSource, AuditLogOptions } from '@flo-monster/core';

const MAX_ENTRIES_PER_AGENT = 10000;

export class AuditManager {
  private logs = new Map<string, AuditEntry[]>();

  /**
   * Append an entry to an agent's audit log.
   */
  append(agentId: string, entry: Omit<AuditEntry, 'ts'>): void {
    let log = this.logs.get(agentId);
    if (!log) {
      log = [];
      this.logs.set(agentId, log);
    }

    const fullEntry: AuditEntry = {
      ...entry,
      ts: Date.now(),
    };

    log.push(fullEntry);

    // Trim oldest entries if over limit
    if (log.length > MAX_ENTRIES_PER_AGENT) {
      log.splice(0, log.length - MAX_ENTRIES_PER_AGENT);
    }
  }

  /**
   * Get audit log for an agent with optional filtering.
   */
  getLog(agentId: string, options: AuditLogOptions = {}): AuditEntry[] {
    const log = this.logs.get(agentId) || [];

    let filtered = log;

    if (options.source) {
      filtered = filtered.filter((e) => e.source === options.source);
    }

    if (options.since) {
      filtered = filtered.filter((e) => e.ts >= options.since!);
    }

    if (options.limit && options.limit > 0) {
      filtered = filtered.slice(-options.limit);
    }

    return filtered;
  }

  /**
   * Export audit log as JSONL (newline-delimited JSON).
   */
  exportLog(agentId: string): string {
    const log = this.logs.get(agentId) || [];
    return log.map((entry) => JSON.stringify(entry)).join('\n');
  }

  /**
   * Get total entry count for an agent.
   */
  getEntryCount(agentId: string): number {
    return this.logs.get(agentId)?.length || 0;
  }

  /**
   * Clear audit log for an agent.
   * Note: Typically only called when agent is destroyed.
   */
  clear(agentId: string): void {
    this.logs.delete(agentId);
  }
}
