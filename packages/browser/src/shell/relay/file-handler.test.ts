import { describe, it, expect, vi } from 'vitest';
import { handleFileRequest } from './file-handler.js';
import type { AgentStorageProvider } from '../../storage/agent-storage.js';

// Helper to create mock provider
function createMockProvider(options: {
  files?: Map<string, string>;
} = {}) {
  const { files = new Map() } = options;
  return {
    name: 'opfs' as const,
    readFile: vi.fn(async (_agentId: string, path: string) => {
      const content = files.get(path);
      if (content === undefined) throw new Error('NOT_FOUND');
      return content;
    }),
    writeFile: vi.fn(async () => {}),
    deleteFile: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    listDir: vi.fn(async (_agentId: string, dirPath: string) => {
      const entries: { path: string; name: string; isDirectory: boolean }[] = [];
      const prefix = dirPath === '.' ? '' : dirPath + '/';
      for (const [filePath] of files) {
        if (dirPath === '.' && !filePath.includes('/')) {
          entries.push({ path: filePath, name: filePath, isDirectory: false });
        } else if (prefix && filePath.startsWith(prefix)) {
          const rest = filePath.slice(prefix.length);
          if (!rest.includes('/')) {
            entries.push({ path: filePath, name: rest, isDirectory: false });
          }
        }
      }
      return entries;
    }),
    exportAll: vi.fn(async () => []),
    importAll: vi.fn(async () => {}),
    deleteAll: vi.fn(async () => {}),
  } as unknown as AgentStorageProvider;
}

// Helper to capture postMessage
function createMockTarget() {
  const messages: any[] = [];
  return {
    target: { postMessage: vi.fn((...args: any[]) => messages.push(args[0])) } as unknown as Window,
    messages,
  };
}

const agentId = 'test-agent';

describe('file-handler frontmatter action', () => {
  it('returns frontmatter for matching files', async () => {
    const files = new Map([
      ['game.srcdoc.md', '---\ntitle: My Game\nversion: 2\n---\n# Content'],
      ['notes.txt', 'no frontmatter here'],
    ]);
    const provider = createMockProvider({ files });
    const { target, messages } = createMockTarget();

    await handleFileRequest(
      { type: 'file_request', id: 'test-1', agentId, action: 'frontmatter' as any, path: '*.srcdoc.md' },
      agentId,
      target,
      async () => provider,
    );

    expect(messages).toHaveLength(1);
    const parsed = JSON.parse(messages[0].result);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].path).toBe('game.srcdoc.md');
    expect(parsed[0].frontmatter.title).toBe('My Game');
    expect(parsed[0].frontmatter.version).toBe(2);
  });

  it('returns empty array when no files match', async () => {
    const files = new Map([
      ['readme.txt', 'hello'],
    ]);
    const provider = createMockProvider({ files });
    const { target, messages } = createMockTarget();

    await handleFileRequest(
      { type: 'file_request', id: 'test-2', agentId, action: 'frontmatter' as any, path: '*.srcdoc.md' },
      agentId,
      target,
      async () => provider,
    );

    expect(messages).toHaveLength(1);
    const parsed = JSON.parse(messages[0].result);
    expect(parsed).toEqual([]);
  });

  it('skips files without frontmatter', async () => {
    const files = new Map([
      ['a.srcdoc.md', '---\ntitle: Has FM\n---\ncontent'],
      ['b.srcdoc.md', '# No frontmatter here\nJust markdown'],
    ]);
    const provider = createMockProvider({ files });
    const { target, messages } = createMockTarget();

    await handleFileRequest(
      { type: 'file_request', id: 'test-3', agentId, action: 'frontmatter' as any, path: '*.srcdoc.md' },
      agentId,
      target,
      async () => provider,
    );

    const parsed = JSON.parse(messages[0].result);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].path).toBe('a.srcdoc.md');
  });

  it('handles subdirectory patterns', async () => {
    const files = new Map([
      ['saves/level1.srcdoc.md', '---\nlevel: 1\n---\ncontent'],
      ['saves/level2.srcdoc.md', '---\nlevel: 2\n---\ncontent'],
      ['saves/readme.txt', 'not a match'],
    ]);
    const provider = createMockProvider({ files });
    const { target, messages } = createMockTarget();

    await handleFileRequest(
      { type: 'file_request', id: 'test-4', agentId, action: 'frontmatter' as any, path: 'saves/*.srcdoc.md' },
      agentId,
      target,
      async () => provider,
    );

    const parsed = JSON.parse(messages[0].result);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].frontmatter.level).toBe(1);
    expect(parsed[1].frontmatter.level).toBe(2);
  });

  it('returns proper file_result message format', async () => {
    const provider = createMockProvider({ files: new Map() });
    const { target, messages } = createMockTarget();

    await handleFileRequest(
      { type: 'file_request', id: 'msg-42', agentId, action: 'frontmatter' as any, path: '*.md' },
      agentId,
      target,
      async () => provider,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('file_result');
    expect(messages[0].id).toBe('msg-42');
    expect(messages[0].result).toBe('[]');
    expect(messages[0].error).toBeUndefined();
  });

  it('skips directories in listing', async () => {
    const files = new Map([
      ['doc.srcdoc.md', '---\ntitle: Doc\n---\ncontent'],
    ]);
    const provider = createMockProvider({ files });
    // Override listDir to include a directory entry
    provider.listDir = vi.fn(async () => [
      { path: 'subdir', name: 'subdir', isDirectory: true },
      { path: 'doc.srcdoc.md', name: 'doc.srcdoc.md', isDirectory: false },
    ]) as any;
    const { target, messages } = createMockTarget();

    await handleFileRequest(
      { type: 'file_request', id: 'test-6', agentId, action: 'frontmatter' as any, path: '*.srcdoc.md' },
      agentId,
      target,
      async () => provider,
    );

    const parsed = JSON.parse(messages[0].result);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].path).toBe('doc.srcdoc.md');
    // readFile should not be called for the directory
    expect(provider.readFile).toHaveBeenCalledTimes(1);
  });

  it('handles readFile errors gracefully', async () => {
    const files = new Map([
      ['a.srcdoc.md', '---\ntitle: Good\n---\ncontent'],
    ]);
    const provider = createMockProvider({ files });
    // Override listDir to return two files, but one will fail to read
    provider.listDir = vi.fn(async () => [
      { path: 'a.srcdoc.md', name: 'a.srcdoc.md', isDirectory: false },
      { path: 'b.srcdoc.md', name: 'b.srcdoc.md', isDirectory: false },
    ]) as any;
    // readFile will throw for b.srcdoc.md (not in the files map)
    const { target, messages } = createMockTarget();

    await handleFileRequest(
      { type: 'file_request', id: 'test-7', agentId, action: 'frontmatter' as any, path: '*.srcdoc.md' },
      agentId,
      target,
      async () => provider,
    );

    const parsed = JSON.parse(messages[0].result);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].path).toBe('a.srcdoc.md');
    // No error in the response — graceful handling
    expect(messages[0].error).toBeUndefined();
  });

  it('returns error for unknown action', async () => {
    const provider = createMockProvider();
    const { target, messages } = createMockTarget();

    await handleFileRequest(
      { type: 'file_request', id: 'test-8', agentId, action: 'bogus_action' as any, path: 'foo.txt' },
      agentId,
      target,
      async () => provider,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('file_result');
    expect(messages[0].result).toBeNull();
    expect(messages[0].error).toContain('Unknown files action');
  });
});
