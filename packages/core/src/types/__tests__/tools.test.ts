import { describe, it, expect } from 'vitest';
import { getToolTier, TOOL_TIERS } from '../tools.js';

describe('Tool security tiers', () => {
  describe('getToolTier', () => {
    it('returns immediate for storage', () => {
      expect(getToolTier('storage')).toBe('immediate');
    });

    it('returns immediate for subagent', () => {
      expect(getToolTier('subagent')).toBe('immediate');
    });

    it('returns immediate for capabilities', () => {
      expect(getToolTier('capabilities')).toBe('immediate');
    });

    it('returns immediate for agent_respond', () => {
      expect(getToolTier('agent_respond')).toBe('immediate');
    });

    it('returns immediate for worker_message', () => {
      expect(getToolTier('worker_message')).toBe('immediate');
    });

    it('returns prompted for fetch', () => {
      expect(getToolTier('fetch')).toBe('prompted');
    });

    it('returns blocked for bash', () => {
      expect(getToolTier('bash')).toBe('blocked');
    });

    it('returns blocked for unknown tools', () => {
      expect(getToolTier('totally_unknown_tool')).toBe('blocked');
    });
  });

  describe('TOOL_TIERS constant', () => {
    it('has all expected immediate tools', () => {
      const immediateTools = Object.entries(TOOL_TIERS)
        .filter(([, tier]) => tier === 'immediate')
        .map(([name]) => name);
      expect(immediateTools).toContain('storage');
      expect(immediateTools).toContain('dom');
      expect(immediateTools).toContain('files');
      expect(immediateTools).toContain('view_state');
      expect(immediateTools).toContain('audit_log');
      expect(immediateTools).toContain('subagent');
      expect(immediateTools).toContain('capabilities');
      expect(immediateTools).toContain('agent_respond');
      expect(immediateTools).toContain('worker_message');
    });
  });
});
