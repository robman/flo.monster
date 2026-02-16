import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentFilesPanel } from './agent-files-panel.js';
import type { AgentStorageProvider, StorageEntry } from '../storage/agent-storage.js';

// Mock the agent-storage module
vi.mock('../storage/agent-storage.js', () => ({
  getStorageProvider: vi.fn(),
}));

import { getStorageProvider } from '../storage/agent-storage.js';

const mockGetStorageProvider = vi.mocked(getStorageProvider);

function createMockAgent(id: string = 'agent-1') {
  return {
    id,
    config: { name: 'Test Agent' },
  } as any;
}

function createMockProvider(options: {
  files?: Map<string, string>;
  directories?: Set<string>;
  agentExists?: boolean;
} = {}): AgentStorageProvider {
  const { files = new Map(), directories = new Set(), agentExists = true } = options;

  const provider: AgentStorageProvider = {
    name: 'opfs',
    readFile: vi.fn(async (_agentId: string, path: string) => {
      const content = files.get(path);
      if (content === undefined) {
        throw new Error('NOT_FOUND');
      }
      return content;
    }),
    readFileBinary: vi.fn(async (_agentId: string, path: string) => {
      const content = files.get(path);
      if (content === undefined) {
        throw new Error('NOT_FOUND');
      }
      return new TextEncoder().encode(content).buffer;
    }),
    writeFile: vi.fn(async () => {}),
    deleteFile: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    listDir: vi.fn(async (_agentId: string, dirPath: string) => {
      const entries: StorageEntry[] = [];
      const prefix = dirPath ? dirPath + '/' : '';
      const seenDirs = new Set<string>();

      // List files
      for (const [filePath] of files) {
        if (dirPath === '' || filePath.startsWith(prefix)) {
          const relativePath = dirPath ? filePath.slice(prefix.length) : filePath;
          const parts = relativePath.split('/');
          if (parts.length === 1) {
            // Direct child file
            entries.push({
              path: filePath,
              name: parts[0],
              isDirectory: false,
            });
          } else {
            // File in subdirectory - add the subdirectory
            const subDirName = parts[0];
            const subDirPath = prefix + subDirName;
            if (!seenDirs.has(subDirPath)) {
              seenDirs.add(subDirPath);
              entries.push({
                path: subDirPath,
                name: subDirName,
                isDirectory: true,
              });
            }
          }
        }
      }

      // List explicit directories
      for (const dirPathEntry of directories) {
        if (dirPath === '' || dirPathEntry.startsWith(prefix)) {
          const relativePath = dirPath ? dirPathEntry.slice(prefix.length) : dirPathEntry;
          const parts = relativePath.split('/');
          if (parts.length === 1 && parts[0] && !seenDirs.has(dirPathEntry)) {
            seenDirs.add(dirPathEntry);
            entries.push({
              path: dirPathEntry,
              name: parts[0],
              isDirectory: true,
            });
          }
        }
      }

      return entries;
    }),
    exists: vi.fn(async (_agentId: string, path: string) => {
      if (path === '') return agentExists;
      return files.has(path) || directories.has(path);
    }),
    isFile: vi.fn(async (_agentId: string, path: string) => files.has(path)),
    isDirectory: vi.fn(async (_agentId: string, path: string) => {
      if (path === '') return agentExists;
      return directories.has(path);
    }),
    deleteDir: vi.fn(async () => {}),
    exportFiles: vi.fn(async () => []),
    importFiles: vi.fn(async () => {}),
    clearAgent: vi.fn(async () => {}),
    initAgent: vi.fn(async () => {}),
  };

  return provider;
}

describe('AgentFilesPanel', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    mockGetStorageProvider.mockReset();
  });

  afterEach(() => {
    container.remove();
  });

  it('show/hide/toggle work correctly', () => {
    const panel = new AgentFilesPanel(container);
    const agent = createMockAgent();

    // Set up a provider that returns empty files
    const provider = createMockProvider({ agentExists: false });
    mockGetStorageProvider.mockResolvedValue(provider);

    expect(panel.isVisible()).toBe(false);

    panel.show(agent);
    expect(panel.isVisible()).toBe(true);

    panel.hide();
    expect(panel.isVisible()).toBe(false);
  });

  it('toggle opens and closes', () => {
    const panel = new AgentFilesPanel(container);
    const agent = createMockAgent();

    const provider = createMockProvider({ agentExists: false });
    mockGetStorageProvider.mockResolvedValue(provider);

    panel.toggle(agent);
    expect(panel.isVisible()).toBe(true);

    panel.toggle(agent);
    expect(panel.isVisible()).toBe(false);
  });

  it('isVisible tracks state', () => {
    const panel = new AgentFilesPanel(container);
    const agent = createMockAgent();

    const provider = createMockProvider({ agentExists: false });
    mockGetStorageProvider.mockResolvedValue(provider);

    expect(panel.isVisible()).toBe(false);
    panel.show(agent);
    expect(panel.isVisible()).toBe(true);
    panel.hide();
    expect(panel.isVisible()).toBe(false);
  });

  it('renders panel with agent name in title', () => {
    const panel = new AgentFilesPanel(container);
    const agent = createMockAgent();

    const provider = createMockProvider({ agentExists: false });
    mockGetStorageProvider.mockResolvedValue(provider);

    panel.show(agent);

    const title = container.querySelector('.settings-panel__title');
    expect(title).toBeTruthy();
    expect(title!.textContent).toBe('Test Agent Files');

    panel.hide();
  });

  it('shows loading state initially', () => {
    // Mock getStorageProvider to never resolve to keep loading visible
    mockGetStorageProvider.mockReturnValue(new Promise(() => {}));

    const panel = new AgentFilesPanel(container);
    const agent = createMockAgent();

    panel.show(agent);

    const loading = container.querySelector('.files-loading');
    expect(loading).toBeTruthy();
    expect(loading!.textContent).toBe('Loading...');

    panel.hide();
  });

  it('shows "(No files)" for empty agent directory', async () => {
    const provider = createMockProvider({ agentExists: true });
    mockGetStorageProvider.mockResolvedValue(provider);

    const panel = new AgentFilesPanel(container);
    const agent = createMockAgent();

    panel.show(agent);

    // Wait for async loadFiles
    await vi.waitFor(() => {
      const empty = container.querySelector('.files-empty');
      expect(empty).toBeTruthy();
      expect(empty!.textContent).toBe('(No files)');
    });

    panel.hide();
  });

  it('shows "(No files)" when agent directory does not exist', async () => {
    const provider = createMockProvider({ agentExists: false });
    mockGetStorageProvider.mockResolvedValue(provider);

    const panel = new AgentFilesPanel(container);
    const agent = createMockAgent();

    panel.show(agent);

    await vi.waitFor(() => {
      const empty = container.querySelector('.files-empty');
      expect(empty).toBeTruthy();
      expect(empty!.textContent).toBe('(No files)');
    });

    panel.hide();
  });

  it('lists files from storage provider', async () => {
    const files = new Map<string, string>();
    files.set('hello.txt', 'Hello World');
    files.set('data.json', '{}');

    const provider = createMockProvider({ files, agentExists: true });
    mockGetStorageProvider.mockResolvedValue(provider);

    const panel = new AgentFilesPanel(container);
    const agent = createMockAgent();

    panel.show(agent);

    await vi.waitFor(() => {
      const fileEntries = container.querySelectorAll('.file-entry');
      expect(fileEntries.length).toBe(2);
    });

    const paths = container.querySelectorAll('.file-entry__path');
    const pathTexts = Array.from(paths).map(p => p.textContent);
    expect(pathTexts).toContain('hello.txt');
    expect(pathTexts).toContain('data.json');

    panel.hide();
  });

  it('lists directories with trailing /', async () => {
    const directories = new Set<string>();
    directories.add('output');

    const provider = createMockProvider({ directories, agentExists: true });
    mockGetStorageProvider.mockResolvedValue(provider);

    const panel = new AgentFilesPanel(container);
    const agent = createMockAgent();

    panel.show(agent);

    await vi.waitFor(() => {
      const dirEntries = container.querySelectorAll('.file-entry--dir');
      expect(dirEntries.length).toBe(1);
    });

    const dirPath = container.querySelector('.file-entry--dir .file-entry__path');
    expect(dirPath!.textContent).toBe('output/');

    panel.hide();
  });

  it('download button creates object URL and triggers download', async () => {
    const files = new Map<string, string>();
    files.set('result.txt', 'result data');

    const provider = createMockProvider({ files, agentExists: true });
    mockGetStorageProvider.mockResolvedValue(provider);

    const origCreateObjectURL = URL.createObjectURL;
    const origRevokeObjectURL = URL.revokeObjectURL;
    const mockCreateObjectURL = vi.fn(() => 'blob:mock-url');
    const mockRevokeObjectURL = vi.fn();
    URL.createObjectURL = mockCreateObjectURL;
    URL.revokeObjectURL = mockRevokeObjectURL;

    const panel = new AgentFilesPanel(container);
    const agent = createMockAgent();

    panel.show(agent);

    await vi.waitFor(() => {
      const downloadBtn = container.querySelector('.file-entry__btn[title="Download"]');
      expect(downloadBtn).toBeTruthy();
    });

    const downloadBtn = container.querySelector('.file-entry__btn[title="Download"]') as HTMLElement;
    await downloadBtn.click();

    // Wait for async download
    await vi.waitFor(() => {
      expect(mockCreateObjectURL).toHaveBeenCalled();
      expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    });

    // Verify readFileBinary was called
    expect(provider.readFileBinary).toHaveBeenCalledWith('agent-1', 'result.txt');

    URL.createObjectURL = origCreateObjectURL;
    URL.revokeObjectURL = origRevokeObjectURL;
    panel.hide();
  });

  it('context.json does not have a delete button', async () => {
    const files = new Map<string, string>();
    files.set('context.json', '{}');
    files.set('output.txt', 'data');

    const provider = createMockProvider({ files, agentExists: true });
    mockGetStorageProvider.mockResolvedValue(provider);

    const panel = new AgentFilesPanel(container);
    const agent = createMockAgent();

    panel.show(agent);

    await vi.waitFor(() => {
      const fileEntries = container.querySelectorAll('.file-entry');
      expect(fileEntries.length).toBe(2);
    });

    const entries = container.querySelectorAll('.file-entry');
    for (const entry of entries) {
      const path = entry.querySelector('.file-entry__path')!.textContent;
      const deleteBtn = entry.querySelector('.file-entry__btn--danger[title="Delete"]');
      if (path === 'context.json') {
        expect(deleteBtn).toBeFalsy();
      } else {
        expect(deleteBtn).toBeTruthy();
      }
    }

    panel.hide();
  });

  it('context.terse.json does not have a delete button', async () => {
    const files = new Map<string, string>();
    files.set('context.terse.json', '[]');
    files.set('output.txt', 'data');

    const provider = createMockProvider({ files, agentExists: true });
    mockGetStorageProvider.mockResolvedValue(provider);

    const panel = new AgentFilesPanel(container);
    const agent = createMockAgent();

    panel.show(agent);

    await vi.waitFor(() => {
      const fileEntries = container.querySelectorAll('.file-entry');
      expect(fileEntries.length).toBe(2);
    });

    const entries = container.querySelectorAll('.file-entry');
    for (const entry of entries) {
      const path = entry.querySelector('.file-entry__path')!.textContent;
      const deleteBtn = entry.querySelector('.file-entry__btn--danger[title="Delete"]');
      if (path === 'context.terse.json') {
        expect(deleteBtn).toBeFalsy();
      } else {
        expect(deleteBtn).toBeTruthy();
      }
    }

    panel.hide();
  });

  it('delete button calls deleteFile and reloads', async () => {
    const files = new Map<string, string>();
    files.set('deleteme.txt', 'content');

    const provider = createMockProvider({ files, agentExists: true });
    mockGetStorageProvider.mockResolvedValue(provider);

    const panel = new AgentFilesPanel(container);
    const agent = createMockAgent();

    panel.show(agent);

    await vi.waitFor(() => {
      const deleteBtn = container.querySelector('.file-entry__btn--danger[title="Delete"]');
      expect(deleteBtn).toBeTruthy();
    });

    const deleteBtn = container.querySelector('.file-entry__btn--danger[title="Delete"]') as HTMLElement;
    await deleteBtn.click();

    await vi.waitFor(() => {
      expect(provider.deleteFile).toHaveBeenCalledWith('agent-1', 'deleteme.txt');
    });

    panel.hide();
  });
});
