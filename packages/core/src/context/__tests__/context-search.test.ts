import { describe, it, expect } from 'vitest';
import {
  messageContains,
  mergeRanges,
  formatMessages,
  getMessagesByTurn,
} from '../context-search.js';

describe('messageContains', () => {
  it('returns false for null/undefined', () => {
    expect(messageContains(null, 'test')).toBe(false);
    expect(messageContains(undefined, 'test')).toBe(false);
  });

  it('returns false for non-object values', () => {
    expect(messageContains(42, 'test')).toBe(false);
    expect(messageContains('string', 'test')).toBe(false);
    expect(messageContains(true, 'test')).toBe(false);
  });

  it('returns false for object without content', () => {
    expect(messageContains({ role: 'user' }, 'test')).toBe(false);
  });

  it('matches string content (case insensitive)', () => {
    const msg = { content: 'Hello World' };
    // Content is lowercased before comparison, so query must be lowercase
    expect(messageContains(msg, 'hello')).toBe(true);
    expect(messageContains(msg, 'world')).toBe(true);
    expect(messageContains(msg, 'hello world')).toBe(true);
    expect(messageContains(msg, 'missing')).toBe(false);
    // Uppercase query won't match since only content is lowercased
    expect(messageContains(msg, 'WORLD')).toBe(false);
  });

  it('matches text blocks in content array', () => {
    const msg = {
      content: [
        { type: 'text', text: 'First block' },
        { type: 'text', text: 'Second block with keyword' },
      ],
    };
    expect(messageContains(msg, 'keyword')).toBe(true);
    expect(messageContains(msg, 'first')).toBe(true);
    expect(messageContains(msg, 'missing')).toBe(false);
  });

  it('matches tool_use name and input', () => {
    const msg = {
      content: [
        {
          type: 'tool_use',
          name: 'create_file',
          input: { path: '/tmp/example.txt', content: 'file data' },
        },
      ],
    };
    expect(messageContains(msg, 'create_file')).toBe(true);
    expect(messageContains(msg, 'example.txt')).toBe(true);
    expect(messageContains(msg, 'file data')).toBe(true);
    expect(messageContains(msg, 'missing')).toBe(false);
  });

  it('matches tool_use name without input', () => {
    const msg = {
      content: [
        { type: 'tool_use', name: 'list_files', input: null },
      ],
    };
    expect(messageContains(msg, 'list_files')).toBe(true);
    expect(messageContains(msg, 'missing')).toBe(false);
  });

  it('matches tool_result content', () => {
    const msg = {
      content: [
        { type: 'tool_result', content: 'Operation succeeded with result 42' },
      ],
    };
    expect(messageContains(msg, 'operation')).toBe(true);
    expect(messageContains(msg, 'result 42')).toBe(true);
    expect(messageContains(msg, 'missing')).toBe(false);
  });

  it('returns false for tool_result with non-string content', () => {
    const msg = {
      content: [
        { type: 'tool_result', content: { data: 'nested' } },
      ],
    };
    expect(messageContains(msg, 'nested')).toBe(false);
  });

  it('skips null/undefined blocks in content array', () => {
    const msg = {
      content: [null, undefined, { type: 'text', text: 'valid' }],
    };
    expect(messageContains(msg, 'valid')).toBe(true);
  });

  it('skips non-object blocks in content array', () => {
    const msg = {
      content: [42, 'string', { type: 'text', text: 'valid' }],
    };
    expect(messageContains(msg, 'valid')).toBe(true);
  });
});

describe('mergeRanges', () => {
  it('returns empty for no indices', () => {
    expect(mergeRanges([], 2, 2, 10)).toEqual([]);
  });

  it('single index with before/after', () => {
    // index 5, before=2, after=2 in total=10 => [3, 7]
    expect(mergeRanges([5], 2, 2, 10)).toEqual([[3, 7]]);
  });

  it('single index with before=0 and after=0', () => {
    expect(mergeRanges([5], 0, 0, 10)).toEqual([[5, 5]]);
  });

  it('merges overlapping ranges', () => {
    // indices 3, 5 with before=1, after=1, total=10
    // 3 => [2, 4], 5 => [4, 6] — overlapping at 4
    expect(mergeRanges([3, 5], 1, 1, 10)).toEqual([[2, 6]]);
  });

  it('merges adjacent ranges', () => {
    // indices 3, 6 with before=1, after=1, total=10
    // 3 => [2, 4], 6 => [5, 7] — adjacent (5 == 4+1)
    expect(mergeRanges([3, 6], 1, 1, 10)).toEqual([[2, 7]]);
  });

  it('keeps separate non-overlapping ranges', () => {
    // indices 2, 8 with before=1, after=1, total=10
    // 2 => [1, 3], 8 => [7, 9] — not overlapping
    expect(mergeRanges([2, 8], 1, 1, 10)).toEqual([[1, 3], [7, 9]]);
  });

  it('clamps to bounds (0, total-1)', () => {
    // index 0 with before=5 => start clamped to 0
    expect(mergeRanges([0], 5, 2, 10)).toEqual([[0, 2]]);

    // index 9 with after=5, total=10 => end clamped to 9
    expect(mergeRanges([9], 2, 5, 10)).toEqual([[7, 9]]);
  });

  it('clamps both bounds simultaneously', () => {
    // index 1, before=5, after=5, total=4 => [0, 3]
    expect(mergeRanges([1], 5, 5, 4)).toEqual([[0, 3]]);
  });

  it('merges multiple overlapping into single range', () => {
    // indices 1, 3, 5 with before=1, after=1, total=10
    // 1 => [0,2], 3 => [2,4], 5 => [4,6] — all merge
    expect(mergeRanges([1, 3, 5], 1, 1, 10)).toEqual([[0, 6]]);
  });

  it('handles total=1', () => {
    expect(mergeRanges([0], 2, 2, 1)).toEqual([[0, 0]]);
  });
});

describe('formatMessages', () => {
  it('formats string content with role prefix', () => {
    const result = formatMessages([
      { role: 'user', content: 'Hello there' },
    ]);
    expect(result).toBe('[user] Hello there');
  });

  it('formats content blocks with text, tool_use, tool_result', () => {
    const result = formatMessages([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me help.' },
          { type: 'tool_use', name: 'read_file', input: { path: '/tmp/x' } },
          { type: 'tool_result', content: 'file contents here' },
        ],
      },
    ]);
    expect(result).toContain('[assistant]');
    expect(result).toContain('Let me help.');
    expect(result).toContain('[tool: read_file(');
    expect(result).toContain('/tmp/x');
    expect(result).toContain('[result: file contents here]');
  });

  it('shows turnId when present: [role turnId]', () => {
    const result = formatMessages([
      { role: 'user', turnId: 't3', content: 'with turn' },
    ]);
    expect(result).toBe('[user t3] with turn');
  });

  it('shows [role] without turnId', () => {
    const result = formatMessages([
      { role: 'assistant', content: 'no turn id' },
    ]);
    expect(result).toBe('[assistant] no turn id');
  });

  it('truncates long content', () => {
    const longText = 'x'.repeat(1000);
    const result = formatMessages([
      { role: 'user', content: longText },
    ]);
    // truncate(content, 500) => 500 chars + '...'
    expect(result.length).toBeLessThan(1000);
    expect(result).toContain('...');
    // Prefix '[user] ' (7 chars) + 500 chars + '...' (3 chars)
    expect(result).toBe(`[user] ${'x'.repeat(500)}...`);
  });

  it('truncates long tool_use input', () => {
    const longInput = { data: 'y'.repeat(500) };
    const result = formatMessages([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'big_tool', input: longInput },
        ],
      },
    ]);
    expect(result).toContain('[tool: big_tool(');
    expect(result).toContain('...');
  });

  it('truncates long tool_result content', () => {
    const longResult = 'z'.repeat(500);
    const result = formatMessages([
      {
        role: 'user',
        content: [
          { type: 'tool_result', content: longResult },
        ],
      },
    ]);
    expect(result).toContain('[result: ');
    expect(result).toContain('...');
  });

  it('handles unknown/null messages', () => {
    const result = formatMessages([null, undefined, 42 as any]);
    const lines = result.split('\n');
    expect(lines[0]).toBe('[0] (unknown)');
    expect(lines[1]).toBe('[1] (unknown)');
    expect(lines[2]).toBe('[2] (unknown)');
  });

  it('handles message with no content', () => {
    const result = formatMessages([
      { role: 'assistant' },
    ]);
    expect(result).toBe('[assistant] (no content)');
  });

  it('handles message with unknown role', () => {
    const result = formatMessages([
      { content: 'orphan' },
    ]);
    expect(result).toBe('[unknown] orphan');
  });

  it('handles tool_result with non-string content (JSON stringified)', () => {
    const result = formatMessages([
      {
        role: 'user',
        content: [
          { type: 'tool_result', content: { key: 'value' } },
        ],
      },
    ]);
    expect(result).toContain('[result: {"key":"value"}]');
  });

  it('skips null/non-object blocks in content array', () => {
    const result = formatMessages([
      {
        role: 'assistant',
        content: [null, 42, { type: 'text', text: 'valid' }],
      },
    ]);
    expect(result).toContain('valid');
    // null and 42 blocks are skipped
    expect(result).toBe('[assistant] valid');
  });

  it('formats multiple messages separated by newlines', () => {
    const result = formatMessages([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
    ]);
    expect(result).toBe('[user] first\n[assistant] second');
  });
});

describe('getMessagesByTurn', () => {
  function makeMsg(role: string, turnId: string, content: string = 'text'): Record<string, unknown> {
    return { role, turnId, content };
  }

  const messages = [
    makeMsg('user', 't1', 'q1'),
    makeMsg('assistant', 't1', 'a1'),
    makeMsg('user', 't2', 'q2'),
    makeMsg('assistant', 't2', 'a2'),
    makeMsg('user', 't3', 'q3'),
    makeMsg('assistant', 't3', 'a3'),
    makeMsg('user', 't4', 'q4'),
    makeMsg('assistant', 't4', 'a4'),
  ];

  it('returns empty for non-existent turnId', () => {
    expect(getMessagesByTurn(messages, 't99')).toEqual([]);
  });

  it('returns messages for target turn', () => {
    const result = getMessagesByTurn(messages, 't2');
    expect(result).toEqual([
      makeMsg('user', 't2', 'q2'),
      makeMsg('assistant', 't2', 'a2'),
    ]);
  });

  it('returns messages with before/after turns', () => {
    const result = getMessagesByTurn(messages, 't2', 1, 1);
    expect(result).toEqual([
      makeMsg('user', 't1', 'q1'),
      makeMsg('assistant', 't1', 'a1'),
      makeMsg('user', 't2', 'q2'),
      makeMsg('assistant', 't2', 'a2'),
      makeMsg('user', 't3', 'q3'),
      makeMsg('assistant', 't3', 'a3'),
    ]);
  });

  it('handles first turn with before > 0', () => {
    const result = getMessagesByTurn(messages, 't1', 3, 0);
    // Can't go before t1, so just t1
    expect(result).toEqual([
      makeMsg('user', 't1', 'q1'),
      makeMsg('assistant', 't1', 'a1'),
    ]);
  });

  it('handles last turn with after > 0', () => {
    const result = getMessagesByTurn(messages, 't4', 0, 5);
    // Can't go after t4, so just t4
    expect(result).toEqual([
      makeMsg('user', 't4', 'q4'),
      makeMsg('assistant', 't4', 'a4'),
    ]);
  });

  it('handles before and after clamped at both boundaries', () => {
    const result = getMessagesByTurn(messages, 't2', 10, 10);
    // Clamped to all turns
    expect(result).toEqual(messages);
  });

  it('returns empty for empty messages array', () => {
    expect(getMessagesByTurn([], 't1')).toEqual([]);
  });

  it('excludes messages without turnId', () => {
    const msgs = [
      makeMsg('user', 't1', 'q1'),
      { role: 'system', content: 'no turn id' },
      makeMsg('assistant', 't1', 'a1'),
    ];
    const result = getMessagesByTurn(msgs, 't1');
    expect(result).toEqual([
      makeMsg('user', 't1', 'q1'),
      makeMsg('assistant', 't1', 'a1'),
    ]);
  });

  it('defaults before and after to 0', () => {
    const result = getMessagesByTurn(messages, 't3');
    expect(result).toEqual([
      makeMsg('user', 't3', 'q3'),
      makeMsg('assistant', 't3', 'a3'),
    ]);
  });
});
