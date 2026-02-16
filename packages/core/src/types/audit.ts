/**
 * Audit trail types for tracking agent actions.
 * The audit log is managed by the shell and is append-only from the agent's perspective.
 */

export type AuditEventSource = 'srcdoc' | 'agent' | 'user' | 'shell';

export interface AuditEntry {
  ts: number;
  source: AuditEventSource;
  tool?: string;
  action?: string;
  event?: string;
  key?: string;
  url?: string;
  selector?: string;
  approved?: boolean;
  size?: number;
  error?: string;
}

export interface AuditLogOptions {
  source?: AuditEventSource;
  limit?: number;
  since?: number;
}
