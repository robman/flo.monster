import type { ToolPlugin, ToolDef, ShellToolContext, ToolResult } from '@flo-monster/core';
import type { AuditManager } from '../../shell/audit-manager.js';

export function createAuditToolPlugin(auditManager: AuditManager): ToolPlugin {
  const definition: ToolDef = {
    name: 'audit_log',
    description:
      'Read the audit log for this agent. Shows tool calls, storage operations, and network requests made by the agent.',
    input_schema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          enum: ['srcdoc', 'agent', 'user', 'shell'],
          description: 'Filter by source type. Optional.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of entries to return (from most recent). Default: 100.',
        },
        since: {
          type: 'number',
          description: 'Only return entries with timestamp >= this value (Unix ms). Optional.',
        },
        format: {
          type: 'string',
          enum: ['json', 'jsonl', 'summary'],
          description: 'Output format. Default: summary.',
        },
      },
    },
  };

  return {
    definition,
    async execute(
      input: Record<string, unknown>,
      context: ShellToolContext
    ): Promise<ToolResult> {
      const source = input.source as string | undefined;
      const limit = (input.limit as number) || 100;
      const since = input.since as number | undefined;
      const format = (input.format as string) || 'summary';

      const entries = auditManager.getLog(context.agentId, {
        source: source as 'srcdoc' | 'agent' | 'user' | 'shell' | undefined,
        limit,
        since,
      });

      if (format === 'jsonl') {
        const jsonl = entries.map((e) => JSON.stringify(e)).join('\n');
        return { content: jsonl || '(no entries)' };
      }

      if (format === 'json') {
        return { content: JSON.stringify(entries, null, 2) };
      }

      // Summary format
      if (entries.length === 0) {
        return { content: 'No audit entries found.' };
      }

      const lines = [`Audit log (${entries.length} entries):`];
      for (const entry of entries) {
        const time = new Date(entry.ts).toISOString();
        const parts = [time, `[${entry.source}]`];
        if (entry.tool) parts.push(`tool=${entry.tool}`);
        if (entry.action) parts.push(`action=${entry.action}`);
        if (entry.event) parts.push(`event=${entry.event}`);
        if (entry.key) parts.push(`key=${entry.key}`);
        if (entry.url)
          parts.push(`url=${entry.url.substring(0, 50)}${entry.url.length > 50 ? '...' : ''}`);
        if (entry.selector) parts.push(`selector=${entry.selector}`);
        if (entry.approved !== undefined) parts.push(`approved=${entry.approved}`);
        if (entry.size !== undefined) parts.push(`size=${entry.size}`);
        if (entry.error) parts.push(`error=${entry.error}`);
        lines.push(parts.join(' '));
      }

      return { content: lines.join('\n') };
    },
  };
}
