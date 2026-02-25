import { describe, it, expect } from 'vitest';
import { getToolTier, TOOL_TIERS } from './tools.js';

describe('TOOL_TIERS', () => {
  it('browse is prompted tier', () => {
    expect(TOOL_TIERS.browse).toBe('prompted');
  });

  it('getToolTier returns prompted for browse', () => {
    expect(getToolTier('browse')).toBe('prompted');
  });

  it('getToolTier returns blocked for unknown tools', () => {
    expect(getToolTier('some_unknown_tool')).toBe('blocked');
  });

  it('getToolTier returns immediate for storage', () => {
    expect(getToolTier('storage')).toBe('immediate');
  });
});
