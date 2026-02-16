/**
 * Tests for TemplateManager
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TemplateManager } from '../template-manager.js';
import type { StoredTemplate, AgentTemplateManifest, AgentConfig } from '@flo-monster/core';
import type { AgentContainer } from '../../agent/agent-container.js';
import JSZip from 'jszip';
import YAML from 'yaml';

/**
 * Helper to create a mock AgentContainer
 */
function createMockAgent(overrides: Partial<AgentConfig> = {}): AgentContainer {
  const config: AgentConfig = {
    id: 'agent-123',
    name: 'Test Agent',
    model: 'claude-sonnet-4-20250514',
    systemPrompt: 'You are a helpful assistant',
    maxTokens: 4096,
    tokenBudget: 100000,
    costBudgetUsd: 5.0,
    networkPolicy: { mode: 'allow-all' },
    tools: [
      { name: 'runjs', description: 'Run JavaScript', input_schema: { type: 'object' } },
    ],
    ...overrides,
  };

  return {
    id: config.id,
    config,
    state: 'running',
    captureDomState: vi.fn().mockResolvedValue({
      viewportHtml: '<div>Test content</div>',
      listeners: [],
      capturedAt: Date.now(),
    }),
    getIframeElement: vi.fn(() => null),
  } as unknown as AgentContainer;
}

/**
 * Helper to create a valid template zip blob
 */
async function createTemplateZip(options: {
  manifest?: Partial<AgentTemplateManifest>;
  manifestFilename?: string;
  srcdoc?: string;
  files?: { path: string; content: string }[];
  skipManifest?: boolean;
}): Promise<Blob> {
  const zip = new JSZip();

  if (!options.skipManifest) {
    const manifest: AgentTemplateManifest = {
      name: 'test-template',
      version: '1.0.0',
      description: 'A test template',
      config: {},
      ...options.manifest,
    };
    const filename = options.manifestFilename ?? 'manifest.yaml';
    zip.file(filename, YAML.stringify(manifest));
  }

  if (options.srcdoc) {
    zip.file('srcdoc.html', options.srcdoc);
  }

  if (options.files) {
    for (const file of options.files) {
      zip.file(`files/${file.path}`, file.content);
    }
  }

  return zip.generateAsync({ type: 'blob' });
}

describe('TemplateManager', () => {
  let manager: TemplateManager;

  beforeEach(() => {
    manager = new TemplateManager();
  });

  describe('installFromZip', () => {
    it('installs a valid template', async () => {
      const blob = await createTemplateZip({
        manifest: {
          name: 'my-template',
          version: '2.0.0',
          description: 'My custom template',
          author: 'Test Author',
        },
        srcdoc: '<html><body>Hello</body></html>',
        files: [
          { path: 'data.json', content: '{"key": "value"}' },
          { path: 'nested/file.txt', content: 'nested content' },
        ],
      });

      const template = await manager.installFromZip(blob);

      expect(template.manifest.name).toBe('my-template');
      expect(template.manifest.version).toBe('2.0.0');
      expect(template.manifest.description).toBe('My custom template');
      expect(template.manifest.author).toBe('Test Author');
      expect(template.srcdoc).toBe('<html><body>Hello</body></html>');
      expect(template.files).toHaveLength(2);
      expect(template.files.find(f => f.path === 'data.json')?.content).toBe('{"key": "value"}');
      expect(template.files.find(f => f.path === 'nested/file.txt')?.content).toBe('nested content');
      expect(template.source.type).toBe('local');
      expect(template.installedAt).toBeGreaterThan(0);
    });

    it('accepts manifest.yml as alternative filename', async () => {
      const blob = await createTemplateZip({
        manifest: { name: 'yml-template', version: '1.0.0', description: 'Uses .yml' },
        manifestFilename: 'manifest.yml',
      });

      const template = await manager.installFromZip(blob);
      expect(template.manifest.name).toBe('yml-template');
    });

    it('rejects zip without manifest', async () => {
      const blob = await createTemplateZip({ skipManifest: true });

      await expect(manager.installFromZip(blob)).rejects.toThrow(
        'Template zip must contain manifest.yaml'
      );
    });

    it('rejects manifest missing required name field', async () => {
      const zip = new JSZip();
      zip.file('manifest.yaml', YAML.stringify({
        version: '1.0.0',
        description: 'No name',
        config: {},
      }));
      const blob = await zip.generateAsync({ type: 'blob' });

      await expect(manager.installFromZip(blob)).rejects.toThrow(
        'Template manifest must have name and version'
      );
    });

    it('rejects manifest missing required version field', async () => {
      const zip = new JSZip();
      zip.file('manifest.yaml', YAML.stringify({
        name: 'test',
        description: 'No version',
        config: {},
      }));
      const blob = await zip.generateAsync({ type: 'blob' });

      await expect(manager.installFromZip(blob)).rejects.toThrow(
        'Template manifest must have name and version'
      );
    });

    it('accepts manifest without description field', async () => {
      const zip = new JSZip();
      zip.file('manifest.yaml', YAML.stringify({
        name: 'test',
        version: '1.0.0',
        config: {},
      }));
      const blob = await zip.generateAsync({ type: 'blob' });

      const template = await manager.installFromZip(blob);
      expect(template.manifest.name).toBe('test');
      expect(template.manifest.description).toBeUndefined();
    });

    it('uses custom entry points when specified', async () => {
      const zip = new JSZip();
      zip.file('manifest.yaml', YAML.stringify({
        name: 'custom-entries',
        version: '1.0.0',
        description: 'Custom entry points',
        config: {},
        entryPoints: {
          srcdoc: 'custom/index.html',
          files: 'assets/',
        },
      }));
      zip.file('custom/index.html', '<html>Custom</html>');
      zip.file('assets/style.css', 'body { color: red; }');
      const blob = await zip.generateAsync({ type: 'blob' });

      const template = await manager.installFromZip(blob);
      expect(template.srcdoc).toBe('<html>Custom</html>');
      expect(template.files).toHaveLength(1);
      expect(template.files[0].path).toBe('style.css');
    });

    it('stores source information for URL installs', async () => {
      const blob = await createTemplateZip({
        manifest: { name: 'url-template', version: '1.0.0', description: 'From URL' },
      });

      const template = await manager.installFromZip(blob, {
        type: 'url',
        url: 'https://example.com/template.zip',
      });

      expect(template.source.type).toBe('url');
      expect(template.source.url).toBe('https://example.com/template.zip');
    });

    it('blocks path traversal via JSZip normalization', async () => {
      // JSZip normalizes paths when loading a zip. A path like
      // files/../../../etc/passwd becomes etc/passwd after normalization.
      // This means it no longer starts with "files/" prefix and is skipped.
      // This test verifies that behavior provides protection.
      const zip = new JSZip();
      zip.file('manifest.yaml', YAML.stringify({
        name: 'traversal-template',
        version: '1.0.0',
        description: 'Has traversal path',
        config: {},
      }));
      // This path will be normalized by JSZip to "etc/passwd"
      zip.file('files/../../../etc/passwd', 'malicious content');
      // Add a valid file to ensure the template installs
      zip.file('files/valid.txt', 'valid content');
      const blob = await zip.generateAsync({ type: 'blob' });

      const template = await manager.installFromZip(blob);
      // Only valid.txt should be extracted (etc/passwd doesn't start with files/)
      expect(template.files).toHaveLength(1);
      expect(template.files[0].path).toBe('valid.txt');
      // Verify malicious file was NOT included
      expect(template.files.find(f => f.path.includes('passwd'))).toBeUndefined();
    });

    it('rejects paths with double dots in relative path', async () => {
      // Test paths that still contain .. after slicing off the files/ prefix
      // This catches edge cases where JSZip might not fully normalize
      const zip = new JSZip();
      zip.file('manifest.yaml', YAML.stringify({
        name: 'dotdot-template',
        version: '1.0.0',
        description: 'Has dot-dot in path',
        config: {},
      }));
      // files/subdir/../file.txt normalizes to files/file.txt, which is OK
      zip.file('files/subdir/../file.txt', 'content');
      const blob = await zip.generateAsync({ type: 'blob' });

      // After normalization, this becomes files/file.txt which is valid
      const template = await manager.installFromZip(blob);
      // The path should be normalized to file.txt (no subdir/../)
      expect(template.files.some(f => f.path === 'file.txt')).toBe(true);
    });

    it('normalizes double slashes in paths', async () => {
      // JSZip normalizes double slashes (files//absolute -> files/absolute)
      // This test verifies that behavior, which provides protection against
      // attempted absolute path injection via double slashes
      const zip = new JSZip();
      zip.file('manifest.yaml', YAML.stringify({
        name: 'slash-template',
        version: '1.0.0',
        description: 'Has double slash in path',
        config: {},
      }));
      zip.file('files//absolute', 'content with double slash');
      zip.file('files/valid.txt', 'valid content');
      const blob = await zip.generateAsync({ type: 'blob' });

      const template = await manager.installFromZip(blob);
      // Both files should be extracted, with normalized paths
      expect(template.files).toHaveLength(2);
      expect(template.files.find(f => f.path === 'absolute')).toBeDefined();
      expect(template.files.find(f => f.path === 'valid.txt')).toBeDefined();
    });

    it('marks binary files with base64 encoding', async () => {
      const zip = new JSZip();
      zip.file('manifest.yaml', YAML.stringify({
        name: 'binary-template',
        version: '1.0.0',
        description: 'Has binary files',
        config: {},
      }));
      // Simulate binary content (in real scenario would be actual binary data)
      zip.file('files/image.png', 'PNG binary content');
      zip.file('files/text.txt', 'plain text');
      const blob = await zip.generateAsync({ type: 'blob' });

      const template = await manager.installFromZip(blob);

      const pngFile = template.files.find(f => f.path === 'image.png');
      const txtFile = template.files.find(f => f.path === 'text.txt');

      expect(pngFile?.encoding).toBe('base64');
      expect(txtFile?.encoding).toBe('utf8');
    });
  });

  describe('installFromUrl', () => {
    it('fetches and installs template from URL', async () => {
      const blob = await createTemplateZip({
        manifest: { name: 'remote-template', version: '1.0.0', description: 'Remote' },
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(blob),
      });

      const template = await manager.installFromUrl('https://example.com/template.zip');

      expect(template.manifest.name).toBe('remote-template');
      expect(template.source.type).toBe('url');
      expect(template.source.url).toBe('https://example.com/template.zip');
      expect(global.fetch).toHaveBeenCalledWith('https://example.com/template.zip');
    });

    it('throws on fetch error', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        statusText: 'Not Found',
      });

      await expect(manager.installFromUrl('https://example.com/missing.zip')).rejects.toThrow(
        'Failed to fetch template from https://example.com/missing.zip: Not Found'
      );
    });

    it('rejects invalid URL', async () => {
      await expect(manager.installFromUrl('not-a-valid-url')).rejects.toThrow(
        'Invalid template URL'
      );
    });

    it('rejects javascript: URL scheme', async () => {
      await expect(manager.installFromUrl('javascript:alert(1)')).rejects.toThrow(
        'Only http/https URLs are allowed for template installation'
      );
    });

    it('rejects file: URL scheme', async () => {
      await expect(manager.installFromUrl('file:///etc/passwd')).rejects.toThrow(
        'Only http/https URLs are allowed for template installation'
      );
    });

    it('rejects data: URL scheme', async () => {
      await expect(manager.installFromUrl('data:text/html,<script>alert(1)</script>')).rejects.toThrow(
        'Only http/https URLs are allowed for template installation'
      );
    });

    it('allows http: URL scheme', async () => {
      const blob = await createTemplateZip({
        manifest: { name: 'http-template', version: '1.0.0', description: 'HTTP' },
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(blob),
      });

      const template = await manager.installFromUrl('http://example.com/template.zip');
      expect(template.manifest.name).toBe('http-template');
    });
  });

  describe('getTemplate', () => {
    it('returns installed template by name', async () => {
      const blob = await createTemplateZip({
        manifest: { name: 'get-test', version: '1.0.0', description: 'Get test' },
      });
      await manager.installFromZip(blob);

      const template = manager.getTemplate('get-test');
      expect(template).toBeDefined();
      expect(template!.manifest.name).toBe('get-test');
    });

    it('returns undefined for unknown template', () => {
      const template = manager.getTemplate('nonexistent');
      expect(template).toBeUndefined();
    });
  });

  describe('listTemplates', () => {
    it('returns all installed templates', async () => {
      const blob1 = await createTemplateZip({
        manifest: { name: 'template-1', version: '1.0.0', description: 'First' },
      });
      const blob2 = await createTemplateZip({
        manifest: { name: 'template-2', version: '1.0.0', description: 'Second' },
      });

      await manager.installFromZip(blob1);
      await manager.installFromZip(blob2);

      const templates = manager.listTemplates();
      expect(templates).toHaveLength(2);
      expect(templates.map(t => t.manifest.name)).toContain('template-1');
      expect(templates.map(t => t.manifest.name)).toContain('template-2');
    });

    it('returns empty array when no templates installed', () => {
      const templates = manager.listTemplates();
      expect(templates).toEqual([]);
    });
  });

  describe('removeTemplate', () => {
    it('removes an installed template', async () => {
      const blob = await createTemplateZip({
        manifest: { name: 'to-remove', version: '1.0.0', description: 'Remove me' },
      });
      await manager.installFromZip(blob);

      expect(manager.hasTemplate('to-remove')).toBe(true);

      const removed = manager.removeTemplate('to-remove');
      expect(removed).toBe(true);
      expect(manager.hasTemplate('to-remove')).toBe(false);
    });

    it('returns false for non-existent template', () => {
      const removed = manager.removeTemplate('nonexistent');
      expect(removed).toBe(false);
    });
  });

  describe('hasTemplate', () => {
    it('returns true for installed template', async () => {
      const blob = await createTemplateZip({
        manifest: { name: 'exists', version: '1.0.0', description: 'I exist' },
      });
      await manager.installFromZip(blob);

      expect(manager.hasTemplate('exists')).toBe(true);
    });

    it('returns false for non-existent template', () => {
      expect(manager.hasTemplate('nonexistent')).toBe(false);
    });
  });

  describe('export/import', () => {
    it('exports all templates', async () => {
      const blob1 = await createTemplateZip({
        manifest: { name: 'export-1', version: '1.0.0', description: 'Export 1' },
      });
      const blob2 = await createTemplateZip({
        manifest: { name: 'export-2', version: '1.0.0', description: 'Export 2' },
      });

      await manager.installFromZip(blob1);
      await manager.installFromZip(blob2);

      const exported = manager.exportEntries();
      expect(exported).toHaveLength(2);
      expect(exported.map(t => t.manifest.name)).toContain('export-1');
      expect(exported.map(t => t.manifest.name)).toContain('export-2');
    });

    it('imports templates and clears existing', async () => {
      const blob = await createTemplateZip({
        manifest: { name: 'existing', version: '1.0.0', description: 'Existing' },
      });
      await manager.installFromZip(blob);

      const imported: StoredTemplate[] = [
        {
          manifest: {
            name: 'imported',
            version: '1.0.0',
            description: 'Imported template',
            config: {},
          },
          files: [],
          source: { type: 'url', url: 'https://example.com' },
          installedAt: Date.now(),
        },
      ];

      manager.importEntries(imported);

      expect(manager.hasTemplate('existing')).toBe(false);
      expect(manager.hasTemplate('imported')).toBe(true);
    });
  });

  describe('createFromAgent', () => {
    it('creates a template blob with manifest and agent config', async () => {
      const mockAgent = createMockAgent({
        model: 'claude-opus-4-20250514',
        systemPrompt: 'Custom system prompt',
        maxTokens: 8192,
      });

      const blob = await manager.createFromAgent(mockAgent, {
        name: 'agent-template',
        version: '1.0.0',
        description: 'Created from agent',
        author: 'Test',
      });

      expect(blob).toBeInstanceOf(Blob);

      // Verify the manifest is correct by reading the zip
      const zip = await JSZip.loadAsync(blob);
      const manifestFile = zip.file('manifest.yaml');
      expect(manifestFile).not.toBeNull();

      const content = await manifestFile!.async('string');
      const manifest = YAML.parse(content);
      expect(manifest.name).toBe('agent-template');
      expect(manifest.version).toBe('1.0.0');
      expect(manifest.description).toBe('Created from agent');
      expect(manifest.author).toBe('Test');
      // Check agent config was captured
      expect(manifest.config.model).toBe('claude-opus-4-20250514');
      expect(manifest.config.systemPrompt).toBe('Custom system prompt');
      expect(manifest.config.maxTokens).toBe(8192);
      expect(manifest.config.tools).toContain('runjs');
    });

    it('captures DOM state by default', async () => {
      const mockAgent = createMockAgent();

      const blob = await manager.createFromAgent(mockAgent, {
        name: 'dom-template',
        version: '1.0.0',
        description: 'With DOM state',
      });

      const zip = await JSZip.loadAsync(blob);
      const srcdocFile = zip.file('srcdoc.html');
      expect(srcdocFile).not.toBeNull();

      const content = await srcdocFile!.async('string');
      expect(content).toContain('<div>Test content</div>');
      expect(content).toContain('<!DOCTYPE html>');
      expect(content).toContain('<!-- FLO_BOOTSTRAP -->');
      expect(mockAgent.captureDomState).toHaveBeenCalled();
    });

    it('skips DOM state when includeDomState is false', async () => {
      const mockAgent = createMockAgent();

      const blob = await manager.createFromAgent(mockAgent, {
        name: 'no-dom-template',
        version: '1.0.0',
        description: 'Without DOM state',
      }, { includeDomState: false });

      const zip = await JSZip.loadAsync(blob);
      const srcdocFile = zip.file('srcdoc.html');
      expect(srcdocFile).toBeNull();
      expect(mockAgent.captureDomState).not.toHaveBeenCalled();
    });

    it('handles agent with null DOM state', async () => {
      const mockAgent = createMockAgent();
      (mockAgent.captureDomState as any).mockResolvedValue(null);

      const blob = await manager.createFromAgent(mockAgent, {
        name: 'null-dom-template',
        version: '1.0.0',
        description: 'Null DOM state',
      });

      const zip = await JSZip.loadAsync(blob);
      const srcdocFile = zip.file('srcdoc.html');
      expect(srcdocFile).toBeNull();
    });

    it('manifest config can override agent config', async () => {
      const mockAgent = createMockAgent({
        model: 'claude-opus-4-20250514',
      });

      const blob = await manager.createFromAgent(mockAgent, {
        name: 'override-template',
        version: '1.0.0',
        description: 'With overrides',
        config: {
          model: 'claude-sonnet-4-20250514', // Override agent's model
        },
      });

      const zip = await JSZip.loadAsync(blob);
      const manifestFile = zip.file('manifest.yaml');
      const content = await manifestFile!.async('string');
      const manifest = YAML.parse(content);
      // Override should take precedence
      expect(manifest.config.model).toBe('claude-sonnet-4-20250514');
    });
  });

  describe('installFromFile', () => {
    it('installs template from File object', async () => {
      const blob = await createTemplateZip({
        manifest: { name: 'file-template', version: '1.0.0', description: 'From file' },
      });
      // Create a File object from the blob
      const file = new File([blob], 'template.zip', { type: 'application/zip' });

      const template = await manager.installFromFile(file);

      expect(template.manifest.name).toBe('file-template');
      expect(template.source.type).toBe('local');
    });
  });

  describe('template replacement', () => {
    it('replaces template with same name on reinstall', async () => {
      const blob1 = await createTemplateZip({
        manifest: { name: 'same-name', version: '1.0.0', description: 'Version 1' },
      });
      const blob2 = await createTemplateZip({
        manifest: { name: 'same-name', version: '2.0.0', description: 'Version 2' },
      });

      await manager.installFromZip(blob1);
      expect(manager.getTemplate('same-name')?.manifest.version).toBe('1.0.0');

      await manager.installFromZip(blob2);
      expect(manager.getTemplate('same-name')?.manifest.version).toBe('2.0.0');
      expect(manager.listTemplates()).toHaveLength(1);
    });
  });

  describe('builtin templates', () => {
    function createBuiltinTemplate(name: string, version = '1.0.0'): StoredTemplate {
      return {
        manifest: { name, version, description: `Builtin ${name}`, config: {} },
        files: [],
        source: { type: 'builtin' },
        installedAt: Date.now(),
      };
    }

    it('installSystemTemplates sets builtins into the map', () => {
      const builtins = [
        createBuiltinTemplate('builtin-1'),
        createBuiltinTemplate('builtin-2'),
      ];

      manager.installSystemTemplates(builtins);

      expect(manager.hasTemplate('builtin-1')).toBe(true);
      expect(manager.hasTemplate('builtin-2')).toBe(true);
      expect(manager.getTemplate('builtin-1')?.source.type).toBe('builtin');
    });

    it('removeTemplate returns false for builtins', () => {
      manager.installSystemTemplates([createBuiltinTemplate('protected')]);

      const removed = manager.removeTemplate('protected');
      expect(removed).toBe(false);
      expect(manager.hasTemplate('protected')).toBe(true);
    });

    it('removeTemplate still works for non-builtins', async () => {
      const blob = await createTemplateZip({
        manifest: { name: 'removable', version: '1.0.0', description: 'Can remove' },
      });
      await manager.installFromZip(blob);

      const removed = manager.removeTemplate('removable');
      expect(removed).toBe(true);
      expect(manager.hasTemplate('removable')).toBe(false);
    });

    it('exportEntries excludes builtins', async () => {
      manager.installSystemTemplates([createBuiltinTemplate('builtin-export')]);

      const blob = await createTemplateZip({
        manifest: { name: 'user-export', version: '1.0.0', description: 'User template' },
      });
      await manager.installFromZip(blob);

      const exported = manager.exportEntries();
      expect(exported).toHaveLength(1);
      expect(exported[0].manifest.name).toBe('user-export');
    });

    it('importEntries preserves builtins', () => {
      manager.installSystemTemplates([createBuiltinTemplate('preserved')]);

      const userTemplates: StoredTemplate[] = [
        {
          manifest: { name: 'imported', version: '1.0.0', description: 'Imported', config: {} },
          files: [],
          source: { type: 'url', url: 'https://example.com' },
          installedAt: Date.now(),
        },
      ];

      manager.importEntries(userTemplates);

      expect(manager.hasTemplate('preserved')).toBe(true);
      expect(manager.getTemplate('preserved')?.source.type).toBe('builtin');
      expect(manager.hasTemplate('imported')).toBe(true);
    });

    it('listTemplates returns builtins first', async () => {
      const blob = await createTemplateZip({
        manifest: { name: 'aaa-user', version: '1.0.0', description: 'User first alphabetically' },
      });
      await manager.installFromZip(blob);

      manager.installSystemTemplates([createBuiltinTemplate('zzz-builtin')]);

      const list = manager.listTemplates();
      expect(list[0].manifest.name).toBe('zzz-builtin');
      expect(list[0].source.type).toBe('builtin');
      expect(list[1].manifest.name).toBe('aaa-user');
    });
  });

  describe('storage snapshots', () => {
    it('installs template with storage snapshot', async () => {
      const snapshot = {
        keys: [
          { key: 'counter', value: 42 },
          { key: 'settings', value: { theme: 'dark' } },
        ],
        capturedAt: Date.now(),
      };

      const zip = new JSZip();
      zip.file('manifest.yaml', YAML.stringify({
        name: 'storage-template',
        version: '1.0.0',
        description: 'With storage snapshot',
        config: {},
        entryPoints: {
          storage: 'storage/snapshot.json',
        },
      }));
      zip.file('storage/snapshot.json', JSON.stringify(snapshot));
      const blob = await zip.generateAsync({ type: 'blob' });

      const template = await manager.installFromZip(blob);

      expect(template.storageSnapshot).toBeDefined();
      expect(template.storageSnapshot?.keys).toHaveLength(2);
      expect(template.storageSnapshot?.keys.find(k => k.key === 'counter')?.value).toBe(42);
      expect(template.storageSnapshot?.keys.find(k => k.key === 'settings')?.value).toEqual({ theme: 'dark' });
    });

    it('handles missing storage snapshot gracefully', async () => {
      const blob = await createTemplateZip({
        manifest: { name: 'no-storage', version: '1.0.0', description: 'No storage' },
      });

      const template = await manager.installFromZip(blob);

      expect(template.storageSnapshot).toBeUndefined();
    });

    it('handles missing storage file when entryPoint specified', async () => {
      const zip = new JSZip();
      zip.file('manifest.yaml', YAML.stringify({
        name: 'missing-storage',
        version: '1.0.0',
        description: 'Missing storage file',
        config: {},
        entryPoints: {
          storage: 'storage/snapshot.json', // File doesn't exist
        },
      }));
      const blob = await zip.generateAsync({ type: 'blob' });

      const template = await manager.installFromZip(blob);

      // Should not fail, just not include snapshot
      expect(template.storageSnapshot).toBeUndefined();
    });
  });
});
