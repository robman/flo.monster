import { describe, it, expect } from 'vitest';
import {
  extractTerseSummary,
  buildContextMessages,
  type TerseEntry,
  type ContextBuildOptions,
} from '../context-builder.js';

describe('extractTerseSummary', () => {
  it('returns null when no terse tags', () => {
    expect(extractTerseSummary({ content: 'Hello world' })).toBeNull();
    expect(extractTerseSummary({ content: [{ type: 'text', text: 'No tags here' }] })).toBeNull();
    expect(extractTerseSummary({ content: 42 })).toBeNull();
    expect(extractTerseSummary({})).toBeNull();
  });

  it('extracts from string content', () => {
    const msg = { content: 'Some text <terse>built a widget</terse> more text' };
    expect(extractTerseSummary(msg)).toBe('built a widget');
  });

  it('extracts from content blocks (array with text type)', () => {
    const msg = {
      content: [
        { type: 'text', text: 'Prefix <terse>deployed the app</terse> suffix' },
      ],
    };
    expect(extractTerseSummary(msg)).toBe('deployed the app');
  });

  it('uses last match when multiple terse tags', () => {
    const msg = {
      content: '<terse>first summary</terse> middle <terse>second summary</terse>',
    };
    expect(extractTerseSummary(msg)).toBe('second summary');
  });

  it('uses last match across multiple text blocks', () => {
    const msg = {
      content: [
        { type: 'text', text: '<terse>from block one</terse>' },
        { type: 'text', text: '<terse>from block two</terse>' },
      ],
    };
    expect(extractTerseSummary(msg)).toBe('from block two');
  });

  it('handles multiline terse content', () => {
    const msg = {
      content: '<terse>line one\nline two\nline three</terse>',
    };
    expect(extractTerseSummary(msg)).toBe('line one\nline two\nline three');
  });

  it('ignores non-text blocks in content array', () => {
    const msg = {
      content: [
        { type: 'tool_use', name: 'foo', input: { x: '<terse>hidden</terse>' } },
        { type: 'text', text: '<terse>visible</terse>' },
      ],
    };
    expect(extractTerseSummary(msg)).toBe('visible');
  });

  it('ignores blocks with non-string text', () => {
    const msg = {
      content: [
        { type: 'text', text: 123 },
      ],
    };
    expect(extractTerseSummary(msg)).toBeNull();
  });

  it('handles null blocks in content array', () => {
    const msg = {
      content: [null, undefined, { type: 'text', text: '<terse>ok</terse>' }],
    };
    expect(extractTerseSummary(msg)).toBe('ok');
  });
});

describe('buildContextMessages', () => {
  const defaultOpts: ContextBuildOptions = {
    contextMode: 'slim',
    maxTerseEntries: 50,
    fullContextTurns: 3,
  };

  function makeTerseEntry(overrides: Partial<TerseEntry> = {}): TerseEntry {
    return {
      ts: 1700000000000,
      turnId: 't1',
      role: 'assistant',
      summary: 'did something',
      ...overrides,
    };
  }

  function makeMsg(role: string, turnId: string, content: string = 'text'): Record<string, unknown> {
    return { role, turnId, content };
  }

  describe('full mode', () => {
    it('returns all messages (no terse)', () => {
      const history = [
        makeMsg('user', 't1', 'hello'),
        makeMsg('assistant', 't1', 'hi'),
        makeMsg('user', 't2', 'bye'),
      ];
      const terse = [makeTerseEntry({ turnId: 't1' })];

      const result = buildContextMessages(terse, history, {
        ...defaultOpts,
        contextMode: 'full',
      });

      expect(result).toEqual(history);
      // Verify it's a copy, not the same array
      expect(result).not.toBe(history);
    });

    it('returns empty array for empty history', () => {
      const result = buildContextMessages([], [], {
        ...defaultOpts,
        contextMode: 'full',
      });
      expect(result).toEqual([]);
    });
  });

  describe('slim mode', () => {
    it('no terse entries, no history -> empty result', () => {
      const result = buildContextMessages([], [], defaultOpts);
      expect(result).toEqual([]);
    });

    it('has terse entries but no history -> terse pair only', () => {
      const terse = [
        makeTerseEntry({ turnId: 't1', summary: 'created page', ts: 1700000000000 }),
      ];

      const result = buildContextMessages(terse, [], defaultOpts);

      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('user');
      expect((result[0].content as string)).toContain('[Context — Activity Log]');
      expect((result[0].content as string)).toContain('created page');
      expect(result[1].role).toBe('assistant');
      expect(result[1].content).toBe('Understood, I have the activity log context.');
    });

    it('excludes last K turn IDs from terse log', () => {
      const terse = [
        makeTerseEntry({ turnId: 't1', summary: 'step one' }),
        makeTerseEntry({ turnId: 't2', summary: 'step two' }),
        makeTerseEntry({ turnId: 't3', summary: 'step three' }),
      ];

      const history = [
        makeMsg('user', 't1', 'q1'),
        makeMsg('assistant', 't1', 'a1'),
        makeMsg('user', 't2', 'q2'),
        makeMsg('assistant', 't2', 'a2'),
        makeMsg('user', 't3', 'q3'),
        makeMsg('assistant', 't3', 'a3'),
      ];

      // fullContextTurns = 2 means last 2 turns (t2, t3) are full, t1 is terse
      const result = buildContextMessages(terse, history, {
        ...defaultOpts,
        fullContextTurns: 2,
      });

      // Should have: terse pair (for t1) + 4 full messages (t2+t3)
      expect(result).toHaveLength(6);

      // Terse pair
      expect(result[0].role).toBe('user');
      expect((result[0].content as string)).toContain('step one');
      expect((result[0].content as string)).not.toContain('step two');
      expect((result[0].content as string)).not.toContain('step three');
      expect(result[1].role).toBe('assistant');

      // Full messages from t2 and t3
      expect(result[2]).toEqual(makeMsg('user', 't2', 'q2'));
      expect(result[3]).toEqual(makeMsg('assistant', 't2', 'a2'));
      expect(result[4]).toEqual(makeMsg('user', 't3', 'q3'));
      expect(result[5]).toEqual(makeMsg('assistant', 't3', 'a3'));
    });

    it('formats terse entries with turn ID and timestamp', () => {
      const ts = new Date('2024-01-15T10:30:00Z').getTime();
      const terse = [
        makeTerseEntry({ turnId: 't1', summary: 'created page', ts, role: 'assistant' }),
      ];

      const result = buildContextMessages(terse, [], defaultOpts);

      const terseContent = result[0].content as string;
      expect(terseContent).toContain('[t1 2024-01-15T10:30]');
      expect(terseContent).toContain('assistant: created page');
    });

    it('includes full messages from recent turns only', () => {
      const terse: TerseEntry[] = [];
      const history = [
        makeMsg('user', 't1', 'old question'),
        makeMsg('assistant', 't1', 'old answer'),
        makeMsg('user', 't2', 'recent question'),
        makeMsg('assistant', 't2', 'recent answer'),
      ];

      const result = buildContextMessages(terse, history, {
        ...defaultOpts,
        fullContextTurns: 1,
      });

      // Only t2 (last 1 turn) should appear, no terse entries
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(makeMsg('user', 't2', 'recent question'));
      expect(result[1]).toEqual(makeMsg('assistant', 't2', 'recent answer'));
    });

    it('respects maxTerseEntries limit', () => {
      const terse: TerseEntry[] = [];
      for (let i = 0; i < 10; i++) {
        terse.push(makeTerseEntry({ turnId: `t${i}`, summary: `step ${i}` }));
      }

      // No full history, so all terse entries are candidates
      const result = buildContextMessages(terse, [], {
        ...defaultOpts,
        maxTerseEntries: 3,
      });

      // Should have terse pair with only last 3 entries
      expect(result).toHaveLength(2);
      const terseContent = result[0].content as string;
      // Last 3 entries: t7, t8, t9
      expect(terseContent).toContain('step 7');
      expect(terseContent).toContain('step 8');
      expect(terseContent).toContain('step 9');
      expect(terseContent).not.toContain('step 6');
    });

    it('handles fewer turns than requested fullContextTurns', () => {
      const terse = [
        makeTerseEntry({ turnId: 't1', summary: 'only terse' }),
      ];
      const history = [
        makeMsg('user', 't1', 'only question'),
        makeMsg('assistant', 't1', 'only answer'),
      ];

      // Requesting 5 full turns but only 1 exists
      const result = buildContextMessages(terse, history, {
        ...defaultOpts,
        fullContextTurns: 5,
      });

      // t1 is a recent turn (all turns are recent when fewer than K)
      // so terse entry for t1 is excluded, leaving no terse entries
      // Result is just the full messages
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(makeMsg('user', 't1', 'only question'));
      expect(result[1]).toEqual(makeMsg('assistant', 't1', 'only answer'));
    });

    it('handles messages without turnId', () => {
      const terse = [
        makeTerseEntry({ turnId: 't1', summary: 'summarized' }),
      ];
      const history = [
        { role: 'user', content: 'no turnId msg' },
        makeMsg('user', 't1', 'with turnId'),
        makeMsg('assistant', 't1', 'reply'),
      ];

      const result = buildContextMessages(terse, history, {
        ...defaultOpts,
        fullContextTurns: 1,
      });

      // t1 is the only turn, so it's recent. Terse for t1 excluded.
      // Message without turnId is NOT included (no turnId match).
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(makeMsg('user', 't1', 'with turnId'));
      expect(result[1]).toEqual(makeMsg('assistant', 't1', 'reply'));
    });

    it('subagent role appears in terse log', () => {
      const terse = [
        makeTerseEntry({ turnId: 't1', summary: 'ran subtask', role: 'subagent' }),
      ];

      const result = buildContextMessages(terse, [], defaultOpts);

      const terseContent = result[0].content as string;
      expect(terseContent).toContain('subagent: ran subtask');
    });
  });
});
