import { describe, it, expect, vi } from 'vitest';
import { extractTerseSummary, appendTerseSummary, loadTerseContext, buildSlimContext, generateTurnId } from './context-manager.js';
import type { AgentStorageProvider } from '../../storage/agent-storage.js';

function createMockProvider(existingContent?: string) {
  const written: { path: string; content: string }[] = [];
  let storedContent = existingContent;
  return {
    provider: {
      readFile: vi.fn(async (_agentId: string, _path: string) => {
        if (storedContent !== undefined) return storedContent;
        throw new Error('NOT_FOUND');
      }),
      writeFile: vi.fn(async (_agentId: string, path: string, content: string) => {
        written.push({ path, content });
        storedContent = content;
      }),
    } as unknown as AgentStorageProvider,
    written,
  };
}

describe('extractTerseSummary', () => {
  it('extracts terse from single text block', () => {
    const message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello <terse>did a thing</terse>' }],
    };
    expect(extractTerseSummary(message)).toBe('did a thing');
  });

  it('extracts from multiple text blocks (uses last match)', () => {
    const message = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'First <terse>first summary</terse>' },
        { type: 'text', text: 'Second <terse>second summary</terse>' },
      ],
    };
    expect(extractTerseSummary(message)).toBe('second summary');
  });

  it('returns null when no tag present', () => {
    const message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello world, no terse here' }],
    };
    expect(extractTerseSummary(message)).toBeNull();
  });

  it('handles multiline terse content', () => {
    const message = {
      role: 'assistant',
      content: [{ type: 'text', text: '<terse>line1\nline2</terse>' }],
    };
    expect(extractTerseSummary(message)).toBe('line1\nline2');
  });

  it('handles content as string (not array)', () => {
    const message = {
      role: 'assistant',
      content: 'text <terse>summary</terse> more',
    };
    expect(extractTerseSummary(message)).toBe('summary');
  });

  it('returns null for message with no content field', () => {
    const message = { role: 'assistant' };
    expect(extractTerseSummary(message)).toBeNull();
  });

  it('handles content array with tool_use blocks mixed in', () => {
    const message = {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tool1', name: 'bash', input: {} },
        { type: 'text', text: 'Result <terse>used bash tool</terse>' },
        { type: 'tool_use', id: 'tool2', name: 'read', input: {} },
      ],
    };
    expect(extractTerseSummary(message)).toBe('used bash tool');
  });
});

describe('appendTerseSummary', () => {
  it('creates file when absent (readFile throws)', async () => {
    const { provider, written } = createMockProvider(); // no existing content → throws
    const getProvider = async () => provider;

    await appendTerseSummary('agent-1', 'did something', 'assistant', 't1', getProvider);

    expect(written).toHaveLength(1);
    expect(written[0].path).toBe('context.terse.json');
    const data = JSON.parse(written[0].content);
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0]).toMatchObject({ role: 'assistant', summary: 'did something', turnId: 't1' });
    expect(typeof data.entries[0].ts).toBe('number');
    expect(data.nextTurnId).toBe(1); // nextTurnId stays at 1 since we didn't call generateTurnId
  });

  it('appends to existing entries (new format)', async () => {
    const existing = JSON.stringify({
      entries: [{ ts: 1000, turnId: 't1', role: 'assistant', summary: 'first thing' }],
      nextTurnId: 2,
    });
    const { provider, written } = createMockProvider(existing);
    const getProvider = async () => provider;

    await appendTerseSummary('agent-1', 'second thing', 'subagent', 't2', getProvider);

    expect(written).toHaveLength(1);
    const data = JSON.parse(written[0].content);
    expect(data.entries).toHaveLength(2);
    expect(data.entries[0]).toMatchObject({ turnId: 't1', role: 'assistant', summary: 'first thing' });
    expect(data.entries[1]).toMatchObject({ turnId: 't2', role: 'subagent', summary: 'second thing' });
    expect(data.nextTurnId).toBe(2);
  });

  it('appends to existing entries (migrated from old array format)', async () => {
    const existing = JSON.stringify([
      { ts: 1000, role: 'assistant', summary: 'first thing' },
    ]);
    const { provider, written } = createMockProvider(existing);
    const getProvider = async () => provider;

    await appendTerseSummary('agent-1', 'second thing', 'subagent', 't3', getProvider);

    expect(written).toHaveLength(1);
    const data = JSON.parse(written[0].content);
    expect(data.entries).toHaveLength(2);
    // First entry migrated from old format, gets turnId 't1'
    expect(data.entries[0]).toMatchObject({ turnId: 't1', role: 'assistant', summary: 'first thing' });
    // New entry appended with provided turnId
    expect(data.entries[1]).toMatchObject({ turnId: 't3', role: 'subagent', summary: 'second thing' });
    expect(data.nextTurnId).toBe(2); // migrated nextTurnId = entries.length + 1 = 2
  });

  it('handles storage errors gracefully', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const getProvider = async () => {
        throw new Error('provider init failed');
      };

      // Should not throw
      await appendTerseSummary('agent-1', 'summary', 'assistant', 't1', getProvider);

      expect(spy).toHaveBeenCalledWith(
        '[ContextManager] Failed to append terse summary:',
        expect.any(Error),
      );
    } finally {
      spy.mockRestore();
    }
  });
});

describe('generateTurnId', () => {
  it('returns t1 for a new agent (no existing terse file)', async () => {
    const { provider } = createMockProvider(); // no existing content → throws → starts at 1
    const getProvider = async () => provider;

    const turnId = await generateTurnId('agent-1', getProvider);
    expect(turnId).toBe('t1');
  });

  it('increments counter on successive calls', async () => {
    const { provider } = createMockProvider(); // starts empty
    const getProvider = async () => provider;

    const t1 = await generateTurnId('agent-1', getProvider);
    expect(t1).toBe('t1');

    // After first call, provider now has stored content with nextTurnId: 2
    const t2 = await generateTurnId('agent-1', getProvider);
    expect(t2).toBe('t2');

    const t3 = await generateTurnId('agent-1', getProvider);
    expect(t3).toBe('t3');
  });

  it('continues from existing nextTurnId in new format', async () => {
    const existing = JSON.stringify({
      entries: [
        { ts: 1000, turnId: 't1', role: 'assistant', summary: 'first' },
        { ts: 2000, turnId: 't2', role: 'assistant', summary: 'second' },
      ],
      nextTurnId: 3,
    });
    const { provider } = createMockProvider(existing);
    const getProvider = async () => provider;

    const turnId = await generateTurnId('agent-1', getProvider);
    expect(turnId).toBe('t3');
  });

  it('migrates old format and continues from correct counter', async () => {
    const existing = JSON.stringify([
      { ts: 1000, role: 'assistant', summary: 'first' },
      { ts: 2000, role: 'assistant', summary: 'second' },
      { ts: 3000, role: 'subagent', summary: 'third' },
    ]);
    const { provider } = createMockProvider(existing);
    const getProvider = async () => provider;

    // Old array has 3 entries, so migration sets nextTurnId = 4
    const turnId = await generateTurnId('agent-1', getProvider);
    expect(turnId).toBe('t4');
  });
});

describe('loadTerseContext', () => {
  it('returns [] when file missing (readFile throws)', async () => {
    const { provider } = createMockProvider(); // no existing content → throws
    const getProvider = async () => provider;

    const result = await loadTerseContext('agent-1', getProvider);
    expect(result).toEqual([]);
  });

  it('returns parsed entries when file exists (new format)', async () => {
    const data = {
      entries: [
        { ts: 1000, turnId: 't1', role: 'assistant', summary: 'first' },
        { ts: 2000, turnId: 't2', role: 'subagent', summary: 'second' },
      ],
      nextTurnId: 3,
    };
    const { provider } = createMockProvider(JSON.stringify(data));
    const getProvider = async () => provider;

    const result = await loadTerseContext('agent-1', getProvider);
    expect(result).toEqual(data.entries);
  });

  it('migrates old array format (adds turnId)', async () => {
    const oldEntries = [
      { ts: 1000, role: 'assistant', summary: 'first' },
      { ts: 2000, role: 'subagent', summary: 'second' },
    ];
    const { provider } = createMockProvider(JSON.stringify(oldEntries));
    const getProvider = async () => provider;

    const result = await loadTerseContext('agent-1', getProvider);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ ts: 1000, turnId: 't1', role: 'assistant', summary: 'first' });
    expect(result[1]).toMatchObject({ ts: 2000, turnId: 't2', role: 'subagent', summary: 'second' });
  });

  it('returns [] on corrupt JSON', async () => {
    const { provider } = createMockProvider('not valid json {{{');
    const getProvider = async () => provider;

    const result = await loadTerseContext('agent-1', getProvider);
    expect(result).toEqual([]);
  });
});

describe('new format roundtrip', () => {
  it('appendTerseSummary writes new format, loadTerseContext reads it back', async () => {
    const { provider } = createMockProvider(); // starts empty
    const getProvider = async () => provider;

    // Generate a turn ID and append
    const turnId = await generateTurnId('agent-1', getProvider);
    expect(turnId).toBe('t1');

    await appendTerseSummary('agent-1', 'did something', 'assistant', turnId, getProvider);

    // Load it back
    const entries = await loadTerseContext('agent-1', getProvider);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      turnId: 't1',
      role: 'assistant',
      summary: 'did something',
    });
    expect(typeof entries[0].ts).toBe('number');
  });

  it('multiple turns roundtrip correctly', async () => {
    const { provider } = createMockProvider(); // starts empty
    const getProvider = async () => provider;

    const t1 = await generateTurnId('agent-1', getProvider);
    await appendTerseSummary('agent-1', 'first action', 'assistant', t1, getProvider);

    const t2 = await generateTurnId('agent-1', getProvider);
    await appendTerseSummary('agent-1', 'second action', 'subagent', t2, getProvider);

    const entries = await loadTerseContext('agent-1', getProvider);
    expect(entries).toHaveLength(2);
    expect(entries[0].turnId).toBe('t1');
    expect(entries[0].summary).toBe('first action');
    expect(entries[1].turnId).toBe('t2');
    expect(entries[1].summary).toBe('second action');
  });
});

function createMultiFileMockProvider(files: Record<string, string>) {
  return {
    readFile: vi.fn(async (_agentId: string, path: string) => {
      if (path in files) return files[path];
      throw new Error('NOT_FOUND');
    }),
    writeFile: vi.fn(async () => {}),
  } as unknown as AgentStorageProvider;
}

describe('buildSlimContext', () => {
  it('returns empty array when no terse log exists', async () => {
    const provider = createMultiFileMockProvider({});
    const getProvider = async () => provider;

    const result = await buildSlimContext('agent-1', getProvider);
    expect(result).toEqual([]);
  });

  it('includes terse log message when entries exist', async () => {
    const terseData = {
      entries: [
        { ts: 1700000000000, turnId: 't1', role: 'assistant', summary: 'Created a button' },
        { ts: 1700000060000, turnId: 't2', role: 'subagent', summary: 'Styled the page' },
      ],
      nextTurnId: 3,
    };
    const provider = createMultiFileMockProvider({
      'context.terse.json': JSON.stringify(terseData),
    });
    const getProvider = async () => provider;

    const result = await buildSlimContext('agent-1', getProvider);
    expect(result).toHaveLength(2);
    const userMsg = result[0] as { role: string; content: string };
    expect(userMsg.role).toBe('user');
    expect(userMsg.content).toContain('[Context — Activity Log]');
    expect(userMsg.content).toContain('assistant: Created a button');
    expect(userMsg.content).toContain('subagent: Styled the page');
    // Verify turnId prefix in output
    expect(userMsg.content).toContain('t1');
    expect(userMsg.content).toContain('t2');
    // Verify timestamp formatting (ISO slice 0-16)
    expect(userMsg.content).toContain(new Date(1700000000000).toISOString().slice(0, 16));
    expect(result[1]).toEqual({
      role: 'assistant',
      content: 'Understood, I have the activity log context.',
    });
  });

  it('respects maxTerseEntries limit', async () => {
    const entries = Array.from({ length: 60 }, (_, i) => ({
      ts: 1700000000000 + i * 1000,
      turnId: `t${i + 1}`,
      role: 'assistant' as const,
      summary: `action ${i}`,
    }));
    const terseData = { entries, nextTurnId: 61 };
    const provider = createMultiFileMockProvider({
      'context.terse.json': JSON.stringify(terseData),
    });
    const getProvider = async () => provider;

    const result = await buildSlimContext('agent-1', getProvider, { maxTerseEntries: 3 });
    expect(result).toHaveLength(2);
    const userMsg = result[0] as { role: string; content: string };
    // Should only contain the last 3 entries (indices 57, 58, 59)
    expect(userMsg.content).toContain('action 57');
    expect(userMsg.content).toContain('action 58');
    expect(userMsg.content).toContain('action 59');
    expect(userMsg.content).not.toContain('action 56');
  });

  it('does not include full messages from context.json', async () => {
    const fullMessages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];
    const provider = createMultiFileMockProvider({
      'context.json': JSON.stringify(fullMessages),
    });
    const getProvider = async () => provider;

    // context.json exists but buildSlimContext should not include its messages
    const result = await buildSlimContext('agent-1', getProvider);
    expect(result).toEqual([]);
  });

  it('ignores overview.md (not included in slim context)', async () => {
    const terseData = {
      entries: [
        { ts: 1700000000000, turnId: 't1', role: 'assistant', summary: 'Did something' },
      ],
      nextTurnId: 2,
    };
    const provider = createMultiFileMockProvider({
      'overview.md': 'Agent overview text',
      'context.terse.json': JSON.stringify(terseData),
    });
    const getProvider = async () => provider;

    const result = await buildSlimContext('agent-1', getProvider);
    // Only terse pair, no overview
    expect(result).toHaveLength(2);
    expect((result[0] as any).content).toContain('[Context — Activity Log]');
    expect((result[1] as any).content).toBe('Understood, I have the activity log context.');
  });
});
