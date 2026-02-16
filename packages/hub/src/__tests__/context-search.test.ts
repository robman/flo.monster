import { describe, it, expect } from 'vitest';
import { executeHubContextSearch } from '../tools/context-search.js';

const sampleHistory = [
  { role: 'user', content: [{ type: 'text', text: 'Hello' }], turnId: 't1' },
  { role: 'assistant', content: [{ type: 'text', text: 'Hi there! <terse>Greeted user</terse>' }], turnId: 't1' },
  { role: 'user', content: [{ type: 'text', text: 'Build me a dashboard' }], turnId: 't2' },
  { role: 'assistant', content: [{ type: 'text', text: 'Created dashboard <terse>Built dashboard</terse>' }], turnId: 't2' },
  { role: 'user', content: [{ type: 'text', text: 'Add a chart' }], turnId: 't3' },
  { role: 'assistant', content: [{ type: 'text', text: 'Added chart component <terse>Added chart</terse>' }], turnId: 't3' },
];

describe('executeHubContextSearch', () => {
  describe('empty history', () => {
    it('returns "No conversation history found." for empty array', () => {
      const result = executeHubContextSearch({ mode: 'search', query: 'hello' }, []);
      expect(result.content).toBe('No conversation history found.');
    });

    it('returns "No conversation history found." for non-array', () => {
      const result = executeHubContextSearch({ mode: 'tail' }, null as any);
      expect(result.content).toBe('No conversation history found.');
    });
  });

  describe('search mode', () => {
    it('finds matching messages and returns with context', () => {
      const result = executeHubContextSearch(
        { mode: 'search', query: 'dashboard' },
        sampleHistory as any,
      );
      expect(result.is_error).toBeUndefined();
      expect(result.content).toContain('dashboard');
      // Should include context around the match (before=2, after=2 default)
      expect(result.content).toContain('Hello');
      expect(result.content).toContain('chart');
    });

    it('returns "No matches found." for no results', () => {
      const result = executeHubContextSearch(
        { mode: 'search', query: 'nonexistent' },
        sampleHistory as any,
      );
      expect(result.content).toBe('No matches found.');
      expect(result.is_error).toBeUndefined();
    });

    it('requires query param', () => {
      const result = executeHubContextSearch(
        { mode: 'search' },
        sampleHistory as any,
      );
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('query required');
    });

    it('returns error for empty query string', () => {
      const result = executeHubContextSearch(
        { mode: 'search', query: '' },
        sampleHistory as any,
      );
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('query required');
    });

    it('search is case-insensitive', () => {
      const result = executeHubContextSearch(
        { mode: 'search', query: 'DASHBOARD' },
        sampleHistory as any,
      );
      expect(result.content).toContain('dashboard');
      expect(result.is_error).toBeUndefined();
    });

    it('respects custom before/after context', () => {
      const result = executeHubContextSearch(
        { mode: 'search', query: 'dashboard', before: 0, after: 0 },
        sampleHistory as any,
      );
      expect(result.is_error).toBeUndefined();
      // Only the matching messages, no context from other turns
      expect(result.content).toContain('dashboard');
      // With before=0 and after=0, only messages containing "dashboard" appear
      // Message index 2 (user "Build me a dashboard") and 3 (assistant "Created dashboard")
      // The range header should show the exact messages
      expect(result.content).toContain('---');
    });

    it('includes range headers in results', () => {
      const result = executeHubContextSearch(
        { mode: 'search', query: 'chart', before: 0, after: 0 },
        sampleHistory as any,
      );
      expect(result.content).toMatch(/--- messages \d+-\d+ of \d+ ---/);
    });
  });

  describe('tail mode', () => {
    it('returns last N messages', () => {
      const result = executeHubContextSearch(
        { mode: 'tail', last: 2 },
        sampleHistory as any,
      );
      expect(result.is_error).toBeUndefined();
      expect(result.content).toContain('Add a chart');
      expect(result.content).toContain('Added chart');
      // Should NOT contain earlier messages
      expect(result.content).not.toContain('Hello');
      expect(result.content).not.toContain('dashboard');
    });

    it('defaults to 10 messages when last is not specified', () => {
      const result = executeHubContextSearch(
        { mode: 'tail' },
        sampleHistory as any,
      );
      expect(result.is_error).toBeUndefined();
      // All 6 messages should be returned (fewer than 10)
      expect(result.content).toContain('Hello');
      expect(result.content).toContain('chart');
    });

    it('handles last larger than history', () => {
      const result = executeHubContextSearch(
        { mode: 'tail', last: 100 },
        sampleHistory as any,
      );
      expect(result.is_error).toBeUndefined();
      expect(result.content).toContain('Hello');
      expect(result.content).toContain('chart');
    });
  });

  describe('head mode', () => {
    it('returns first N messages', () => {
      const result = executeHubContextSearch(
        { mode: 'head', first: 2 },
        sampleHistory as any,
      );
      expect(result.is_error).toBeUndefined();
      expect(result.content).toContain('Hello');
      expect(result.content).toContain('Hi there!');
      // Should NOT contain later messages
      expect(result.content).not.toContain('dashboard');
      expect(result.content).not.toContain('chart');
    });

    it('defaults to 10 messages when first is not specified', () => {
      const result = executeHubContextSearch(
        { mode: 'head' },
        sampleHistory as any,
      );
      expect(result.is_error).toBeUndefined();
      // All 6 messages (fewer than 10)
      expect(result.content).toContain('Hello');
      expect(result.content).toContain('chart');
    });

    it('handles first larger than history', () => {
      const result = executeHubContextSearch(
        { mode: 'head', first: 100 },
        sampleHistory as any,
      );
      expect(result.is_error).toBeUndefined();
      expect(result.content).toContain('Hello');
      expect(result.content).toContain('chart');
    });
  });

  describe('turn mode', () => {
    it('retrieves messages by turnId', () => {
      const result = executeHubContextSearch(
        { mode: 'turn', turnId: 't2' },
        sampleHistory as any,
      );
      expect(result.is_error).toBeUndefined();
      expect(result.content).toContain('Build me a dashboard');
      expect(result.content).toContain('Created dashboard');
      // Should NOT contain messages from other turns
      expect(result.content).not.toContain('Hello');
      expect(result.content).not.toContain('chart');
    });

    it('with before turns', () => {
      const result = executeHubContextSearch(
        { mode: 'turn', turnId: 't3', before: 1 },
        sampleHistory as any,
      );
      expect(result.is_error).toBeUndefined();
      // t3 + 1 turn before (t2)
      expect(result.content).toContain('Build me a dashboard');
      expect(result.content).toContain('Add a chart');
    });

    it('with after turns', () => {
      const result = executeHubContextSearch(
        { mode: 'turn', turnId: 't1', after: 1 },
        sampleHistory as any,
      );
      expect(result.is_error).toBeUndefined();
      // t1 + 1 turn after (t2)
      expect(result.content).toContain('Hello');
      expect(result.content).toContain('Build me a dashboard');
    });

    it('with before and after turns', () => {
      const result = executeHubContextSearch(
        { mode: 'turn', turnId: 't2', before: 1, after: 1 },
        sampleHistory as any,
      );
      expect(result.is_error).toBeUndefined();
      // t1, t2, t3 — all messages
      expect(result.content).toContain('Hello');
      expect(result.content).toContain('dashboard');
      expect(result.content).toContain('chart');
    });

    it('requires turnId param', () => {
      const result = executeHubContextSearch(
        { mode: 'turn' },
        sampleHistory as any,
      );
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('turnId required');
    });

    it('returns "No messages found" for non-existent turnId', () => {
      const result = executeHubContextSearch(
        { mode: 'turn', turnId: 't999' },
        sampleHistory as any,
      );
      expect(result.is_error).toBeUndefined();
      expect(result.content).toContain('No messages found for turn t999');
    });
  });

  describe('invalid mode', () => {
    it('returns error for unknown mode', () => {
      const result = executeHubContextSearch(
        { mode: 'invalid' },
        sampleHistory as any,
      );
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('mode must be');
    });
  });
});
