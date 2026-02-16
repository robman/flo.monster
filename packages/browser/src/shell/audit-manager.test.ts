import { describe, it, expect, beforeEach } from 'vitest';
import { AuditManager } from './audit-manager.js';

describe('AuditManager', () => {
  let manager: AuditManager;

  beforeEach(() => {
    manager = new AuditManager();
  });

  describe('append', () => {
    it('should add entries with timestamp', () => {
      manager.append('agent-1', { source: 'agent', tool: 'storage', action: 'get' });

      const log = manager.getLog('agent-1');
      expect(log).toHaveLength(1);
      expect(log[0].source).toBe('agent');
      expect(log[0].tool).toBe('storage');
      expect(log[0].ts).toBeTypeOf('number');
    });

    it('should trim oldest entries when over limit', () => {
      // Add 10001 entries
      for (let i = 0; i < 10001; i++) {
        manager.append('agent-1', { source: 'agent', tool: `tool-${i}` });
      }

      const log = manager.getLog('agent-1');
      expect(log).toHaveLength(10000);
      // First entry should be tool-1 (tool-0 was trimmed)
      expect(log[0].tool).toBe('tool-1');
    });
  });

  describe('getLog', () => {
    beforeEach(() => {
      manager.append('agent-1', { source: 'agent', tool: 'storage' });
      manager.append('agent-1', { source: 'srcdoc', tool: 'dom' });
      manager.append('agent-1', { source: 'agent', tool: 'fetch', url: 'https://example.com' });
    });

    it('should return all entries without filter', () => {
      const log = manager.getLog('agent-1');
      expect(log).toHaveLength(3);
    });

    it('should filter by source', () => {
      const log = manager.getLog('agent-1', { source: 'agent' });
      expect(log).toHaveLength(2);
      expect(log.every((e) => e.source === 'agent')).toBe(true);
    });

    it('should limit results', () => {
      const log = manager.getLog('agent-1', { limit: 2 });
      expect(log).toHaveLength(2);
      // Should return the last 2 entries
      expect(log[0].tool).toBe('dom');
      expect(log[1].tool).toBe('fetch');
    });

    it('should filter by since timestamp', () => {
      const allEntries = manager.getLog('agent-1');
      const middleTs = allEntries[1].ts;

      const filtered = manager.getLog('agent-1', { since: middleTs });
      expect(filtered.length).toBeGreaterThanOrEqual(2);
    });

    it('should return empty array for unknown agent', () => {
      const log = manager.getLog('unknown-agent');
      expect(log).toEqual([]);
    });
  });

  describe('exportLog', () => {
    it('should export as JSONL', () => {
      manager.append('agent-1', { source: 'agent', tool: 'storage' });
      manager.append('agent-1', { source: 'srcdoc', tool: 'dom' });

      const jsonl = manager.exportLog('agent-1');
      const lines = jsonl.split('\n');
      expect(lines).toHaveLength(2);

      const entry1 = JSON.parse(lines[0]);
      expect(entry1.tool).toBe('storage');
    });

    it('should return empty string for unknown agent', () => {
      const jsonl = manager.exportLog('unknown-agent');
      expect(jsonl).toBe('');
    });
  });

  describe('clear', () => {
    it('should remove all entries for an agent', () => {
      manager.append('agent-1', { source: 'agent', tool: 'storage' });
      manager.append('agent-2', { source: 'agent', tool: 'dom' });

      manager.clear('agent-1');

      expect(manager.getLog('agent-1')).toEqual([]);
      expect(manager.getLog('agent-2')).toHaveLength(1);
    });
  });

  describe('getEntryCount', () => {
    it('should return correct count', () => {
      manager.append('agent-1', { source: 'agent', tool: 'storage' });
      manager.append('agent-1', { source: 'agent', tool: 'dom' });

      expect(manager.getEntryCount('agent-1')).toBe(2);
      expect(manager.getEntryCount('unknown')).toBe(0);
    });
  });
});
