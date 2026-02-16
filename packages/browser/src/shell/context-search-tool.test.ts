import { describe, it, expect, vi } from 'vitest';
import { createContextSearchPlugin, messageContains, mergeRanges, formatMessages } from './context-search-tool.js';
import type { AgentStorageProvider } from '../storage/agent-storage.js';
import type { AgentConfig } from '@flo-monster/core';

function createMockProvider(files: Record<string, string>): AgentStorageProvider {
  return {
    readFile: vi.fn(async (_agentId: string, path: string) => {
      if (path in files) return files[path];
      throw new Error('NOT_FOUND');
    }),
    writeFile: vi.fn(async () => {}),
  } as unknown as AgentStorageProvider;
}

const mockContext = {
  agentId: 'agent-1',
  agentConfig: { id: 'agent-1', name: 'Test' } as AgentConfig,
};

// Sample conversation history for tests
const sampleHistory = [
  { role: 'user', content: 'Hello, can you help me with a color scheme?' },
  { role: 'assistant', content: [{ type: 'text', text: 'Sure! What colors do you prefer?' }] },
  { role: 'user', content: 'I like blue and green' },
  { role: 'assistant', content: [{ type: 'text', text: 'Great choices! Let me create a palette.' }] },
  { role: 'user', content: 'Can you also add some CSS?' },
  { role: 'assistant', content: [
    { type: 'text', text: 'Here is the CSS.' },
    { type: 'tool_use', name: 'dom', input: { action: 'create', html: '<style>.theme { color: blue; }</style>' } },
  ]},
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Element created' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Done! The theme is applied.' }] },
];

// Sample conversation with turnId annotations
const sampleHistoryWithTurns = [
  { role: 'user', content: 'Hello, can you help?', turnId: 't1' },
  { role: 'assistant', content: [{ type: 'text', text: 'Sure! What do you need?' }], turnId: 't1' },
  { role: 'user', content: 'I like blue and green', turnId: 't2' },
  { role: 'assistant', content: [{ type: 'text', text: 'Great choices! Let me create a palette.' }], turnId: 't2' },
  { role: 'user', content: 'Can you also add some CSS?', turnId: 't3' },
  { role: 'assistant', content: [
    { type: 'text', text: 'Here is the CSS.' },
    { type: 'tool_use', name: 'dom', input: { action: 'create', html: '<style>.theme { color: blue; }</style>' } },
  ], turnId: 't3' },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Element created' }], turnId: 't3' },
  { role: 'assistant', content: [{ type: 'text', text: 'Done! The theme is applied.' }], turnId: 't3' },
];

describe('createContextSearchPlugin', () => {
  describe('tail mode', () => {
    it('returns last N messages', async () => {
      const provider = createMockProvider({ 'context.json': JSON.stringify(sampleHistory) });
      const plugin = createContextSearchPlugin({ getProvider: async () => provider });

      const result = await plugin.execute({ mode: 'tail', last: 3 }, mockContext);
      expect(result.is_error).toBeFalsy();
      const content = result.content as string;
      // Should contain last 3 messages
      expect(content).toContain('CSS');
      expect(content).toContain('result: Element created');
      expect(content).toContain('theme is applied');
    });

    it('defaults to 10 messages', async () => {
      const provider = createMockProvider({ 'context.json': JSON.stringify(sampleHistory) });
      const plugin = createContextSearchPlugin({ getProvider: async () => provider });

      const result = await plugin.execute({ mode: 'tail' }, mockContext);
      const content = result.content as string;
      // All 8 messages returned (fewer than default 10)
      expect(content).toContain('Hello');
      expect(content).toContain('theme is applied');
    });

    it('handles fewer messages than requested', async () => {
      const history = [{ role: 'user', content: 'Hi' }];
      const provider = createMockProvider({ 'context.json': JSON.stringify(history) });
      const plugin = createContextSearchPlugin({ getProvider: async () => provider });

      const result = await plugin.execute({ mode: 'tail', last: 100 }, mockContext);
      expect(result.is_error).toBeFalsy();
      expect((result.content as string)).toContain('Hi');
    });
  });

  describe('head mode', () => {
    it('returns first N messages', async () => {
      const provider = createMockProvider({ 'context.json': JSON.stringify(sampleHistory) });
      const plugin = createContextSearchPlugin({ getProvider: async () => provider });

      const result = await plugin.execute({ mode: 'head', first: 3 }, mockContext);
      expect(result.is_error).toBeFalsy();
      const content = result.content as string;
      // Should contain first 3 messages
      expect(content).toContain('Hello');
      expect(content).toContain('What colors do you prefer');
      expect(content).toContain('blue and green');
      // Should NOT contain later messages
      expect(content).not.toContain('theme is applied');
    });

    it('defaults to 10 messages', async () => {
      const provider = createMockProvider({ 'context.json': JSON.stringify(sampleHistory) });
      const plugin = createContextSearchPlugin({ getProvider: async () => provider });

      const result = await plugin.execute({ mode: 'head' }, mockContext);
      const content = result.content as string;
      // All 8 messages returned (fewer than default 10)
      expect(content).toContain('Hello');
      expect(content).toContain('theme is applied');
    });
  });

  describe('search mode', () => {
    it('finds matching messages', async () => {
      const provider = createMockProvider({ 'context.json': JSON.stringify(sampleHistory) });
      const plugin = createContextSearchPlugin({ getProvider: async () => provider });

      const result = await plugin.execute({ mode: 'search', query: 'color scheme', before: 0, after: 0 }, mockContext);
      expect(result.is_error).toBeFalsy();
      expect((result.content as string)).toContain('color scheme');
    });

    it('returns context window (before/after)', async () => {
      const provider = createMockProvider({ 'context.json': JSON.stringify(sampleHistory) });
      const plugin = createContextSearchPlugin({ getProvider: async () => provider });

      // Search for 'blue and green' (index 2), with before: 1, after: 1
      const result = await plugin.execute({ mode: 'search', query: 'blue and green', before: 1, after: 1 }, mockContext);
      const content = result.content as string;
      // Should include message before (index 1) and after (index 3)
      expect(content).toContain('What colors do you prefer');
      expect(content).toContain('blue and green');
      expect(content).toContain('Great choices');
    });

    it('merges overlapping ranges', async () => {
      const provider = createMockProvider({ 'context.json': JSON.stringify(sampleHistory) });
      const plugin = createContextSearchPlugin({ getProvider: async () => provider });

      // Search for 'blue' — appears in message index 2 ('blue and green') and index 5 (tool_use with 'color: blue')
      // With before: 2 and after: 2 they overlap
      const result = await plugin.execute({ mode: 'search', query: 'blue', before: 2, after: 2 }, mockContext);
      const content = result.content as string;
      expect(content).toContain('messages'); // Should have range headers
      expect(result.is_error).toBeFalsy();
    });

    it('returns "No matches" when nothing found', async () => {
      const provider = createMockProvider({ 'context.json': JSON.stringify(sampleHistory) });
      const plugin = createContextSearchPlugin({ getProvider: async () => provider });

      const result = await plugin.execute({ mode: 'search', query: 'xyznonexistent' }, mockContext);
      expect((result.content as string)).toBe('No matches found.');
    });

    it('is case-insensitive', async () => {
      const provider = createMockProvider({ 'context.json': JSON.stringify(sampleHistory) });
      const plugin = createContextSearchPlugin({ getProvider: async () => provider });

      const result = await plugin.execute({ mode: 'search', query: 'COLOR SCHEME', before: 0, after: 0 }, mockContext);
      expect(result.is_error).toBeFalsy();
      expect((result.content as string)).toContain('color scheme');
    });

    it('searches across tool_use blocks', async () => {
      const provider = createMockProvider({ 'context.json': JSON.stringify(sampleHistory) });
      const plugin = createContextSearchPlugin({ getProvider: async () => provider });

      const result = await plugin.execute({ mode: 'search', query: '.theme', before: 0, after: 0 }, mockContext);
      expect(result.is_error).toBeFalsy();
      expect((result.content as string)).toContain('dom');
    });

    it('requires query parameter', async () => {
      const provider = createMockProvider({ 'context.json': JSON.stringify(sampleHistory) });
      const plugin = createContextSearchPlugin({ getProvider: async () => provider });

      const result = await plugin.execute({ mode: 'search' }, mockContext);
      expect(result.is_error).toBe(true);
      expect((result.content as string)).toContain('query required');
    });
  });

  describe('turn mode', () => {
    it('returns messages for specific turnId', async () => {
      const provider = createMockProvider({ 'context.json': JSON.stringify(sampleHistoryWithTurns) });
      const plugin = createContextSearchPlugin({ getProvider: async () => provider });

      const result = await plugin.execute({ mode: 'turn', turnId: 't2' }, mockContext);
      expect(result.is_error).toBeFalsy();
      const content = result.content as string;
      // Turn t2 has two messages
      expect(content).toContain('blue and green');
      expect(content).toContain('Great choices');
      // Should NOT contain messages from other turns
      expect(content).not.toContain('Hello, can you help');
      expect(content).not.toContain('theme is applied');
    });

    it('returns error when turnId missing', async () => {
      const provider = createMockProvider({ 'context.json': JSON.stringify(sampleHistoryWithTurns) });
      const plugin = createContextSearchPlugin({ getProvider: async () => provider });

      const result = await plugin.execute({ mode: 'turn' }, mockContext);
      expect(result.is_error).toBe(true);
      expect((result.content as string)).toContain('turnId required');
    });

    it('with before/after turns', async () => {
      const provider = createMockProvider({ 'context.json': JSON.stringify(sampleHistoryWithTurns) });
      const plugin = createContextSearchPlugin({ getProvider: async () => provider });

      // Request turn t2 with 1 turn before and 1 turn after
      const result = await plugin.execute({ mode: 'turn', turnId: 't2', before: 1, after: 1 }, mockContext);
      expect(result.is_error).toBeFalsy();
      const content = result.content as string;
      // Should include t1 (before), t2 (target), t3 (after)
      expect(content).toContain('Hello, can you help');    // t1
      expect(content).toContain('blue and green');          // t2
      expect(content).toContain('Here is the CSS');         // t3
    });

    it('returns "No messages found" for non-existent turnId', async () => {
      const provider = createMockProvider({ 'context.json': JSON.stringify(sampleHistoryWithTurns) });
      const plugin = createContextSearchPlugin({ getProvider: async () => provider });

      const result = await plugin.execute({ mode: 'turn', turnId: 't999' }, mockContext);
      expect(result.is_error).toBeFalsy();
      expect((result.content as string)).toContain('No messages found for turn t999');
    });
  });

  it('returns error for invalid mode', async () => {
    const provider = createMockProvider({ 'context.json': JSON.stringify(sampleHistory) });
    const plugin = createContextSearchPlugin({ getProvider: async () => provider });

    const result = await plugin.execute({ mode: 'invalid' }, mockContext);
    expect(result.is_error).toBe(true);
    expect((result.content as string)).toContain('mode must be');
  });

  it('handles empty/missing history', async () => {
    const provider = createMockProvider({});
    const plugin = createContextSearchPlugin({ getProvider: async () => provider });

    const result = await plugin.execute({ mode: 'tail' }, mockContext);
    expect((result.content as string)).toBe('No conversation history found.');
  });
});

describe('messageContains', () => {
  it('matches string content', () => {
    expect(messageContains({ role: 'user', content: 'Hello World' }, 'hello')).toBe(true);
    expect(messageContains({ role: 'user', content: 'Hello World' }, 'xyz')).toBe(false);
  });

  it('matches text blocks in array content', () => {
    const msg = { role: 'assistant', content: [{ type: 'text', text: 'Found it here' }] };
    expect(messageContains(msg, 'found it')).toBe(true);
  });

  it('matches tool_use name and input', () => {
    const msg = {
      role: 'assistant',
      content: [{ type: 'tool_use', name: 'dom', input: { action: 'create', html: '<div>test</div>' } }],
    };
    expect(messageContains(msg, 'dom')).toBe(true);
    expect(messageContains(msg, 'test')).toBe(true);
  });

  it('returns false for null/undefined', () => {
    expect(messageContains(null, 'test')).toBe(false);
    expect(messageContains(undefined, 'test')).toBe(false);
  });
});

describe('mergeRanges', () => {
  it('merges overlapping ranges', () => {
    // indices 2 and 4, before 2, after 2, total 10
    // Range 1: [0, 4], Range 2: [2, 6] -> merged: [0, 6]
    expect(mergeRanges([2, 4], 2, 2, 10)).toEqual([[0, 6]]);
  });

  it('keeps separate non-overlapping ranges', () => {
    // indices 1 and 8, before 1, after 1, total 10
    // Range 1: [0, 2], Range 2: [7, 9]
    expect(mergeRanges([1, 8], 1, 1, 10)).toEqual([[0, 2], [7, 9]]);
  });

  it('clamps to bounds', () => {
    expect(mergeRanges([0], 5, 5, 3)).toEqual([[0, 2]]);
  });

  it('returns empty for empty indices', () => {
    expect(mergeRanges([], 2, 2, 10)).toEqual([]);
  });
});

describe('formatMessages', () => {
  it('formats string content', () => {
    const msgs = [{ role: 'user', content: 'Hello' }];
    expect(formatMessages(msgs)).toBe('[user] Hello');
  });

  it('formats array content with text blocks', () => {
    const msgs = [{ role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] }];
    expect(formatMessages(msgs)).toBe('[assistant] Hi there');
  });

  it('truncates long content', () => {
    const longText = 'a'.repeat(600);
    const msgs = [{ role: 'user', content: longText }];
    const formatted = formatMessages(msgs);
    expect(formatted.length).toBeLessThan(600);
    expect(formatted).toContain('...');
  });
});
