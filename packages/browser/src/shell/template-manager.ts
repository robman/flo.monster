/**
 * Manages agent templates - installation, storage, and spawning
 */

import type {
  AgentTemplateManifest,
  StoredTemplate,
  SerializedFile,
  StorageSnapshot,
} from '@flo-monster/core';
import type { AgentContainer } from '../agent/agent-container.js';
import YAML from 'yaml';
import JSZip from 'jszip';
import { getStorageProvider } from '../storage/agent-storage.js';
import { openDB, idbGet, idbKeys } from '../utils/idb-helpers.js';

export class TemplateManager {
  private templates = new Map<string, StoredTemplate>();

  /**
   * Install a template from a URL (fetches .flo.zip)
   */
  async installFromUrl(url: string): Promise<StoredTemplate> {
    // Validate URL scheme
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error('Invalid template URL');
    }

    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      throw new Error('Only http/https URLs are allowed for template installation');
    }

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch template from ${url}: ${response.statusText}`);
    }
    const blob = await response.blob();
    return this.installFromZip(blob, { type: 'url', url });
  }

  /**
   * Install a template from a zip Blob
   */
  async installFromZip(
    blob: Blob,
    source: { type: 'builtin' | 'url' | 'local'; url?: string } = { type: 'local' }
  ): Promise<StoredTemplate> {
    const zip = await JSZip.loadAsync(blob);

    // Find and parse manifest (manifest.yaml or manifest.yml)
    const manifestFile = zip.file('manifest.yaml') || zip.file('manifest.yml');
    if (!manifestFile) {
      throw new Error('Template zip must contain manifest.yaml');
    }
    const manifestContent = await manifestFile.async('string');
    const manifest = YAML.parse(manifestContent) as AgentTemplateManifest;

    // Validate required manifest fields (description is optional)
    if (!manifest.name || !manifest.version) {
      throw new Error('Template manifest must have name and version');
    }

    // Get entry points with defaults
    const srcdocPath = manifest.entryPoints?.srcdoc ?? 'srcdoc.html';
    const filesPath = manifest.entryPoints?.files ?? 'files/';

    // Load srcdoc if present
    let srcdoc: string | undefined;
    const srcdocFile = zip.file(srcdocPath);
    if (srcdocFile) {
      srcdoc = await srcdocFile.async('string');
    }

    // Load files from files/ directory
    const files: SerializedFile[] = [];
    const filesFolder = zip.folder(filesPath.replace(/\/$/, ''));
    if (filesFolder) {
      const entries = Object.entries(zip.files);
      for (const [path, file] of entries) {
        if (path.startsWith(filesPath) && !file.dir) {
          const relativePath = path.slice(filesPath.length);
          if (relativePath) {
            // Validate path for traversal
            if (relativePath.includes('..') || relativePath.startsWith('/')) {
              throw new Error(`Path traversal detected in template zip: ${path}`);
            }

            const content = await file.async('string');
            const isBinary = this.isBinaryFile(relativePath);
            files.push({
              path: relativePath,
              content: isBinary ? btoa(content) : content,
              encoding: isBinary ? 'base64' : 'utf8',
            });
          }
        }
      }
    }

    // Load storage snapshot if present
    let storageSnapshot: StorageSnapshot | undefined;
    if (manifest.entryPoints?.storage) {
      const snapshotFile = zip.file(manifest.entryPoints.storage);
      if (snapshotFile) {
        const content = await snapshotFile.async('string');
        storageSnapshot = JSON.parse(content);
      }
    }

    const template: StoredTemplate = {
      manifest,
      srcdoc,
      files,
      source,
      installedAt: Date.now(),
      storageSnapshot,
    };

    this.templates.set(manifest.name, template);
    return template;
  }

  /**
   * Install a template from a File input
   */
  async installFromFile(file: File): Promise<StoredTemplate> {
    return this.installFromZip(file, { type: 'local' });
  }

  /**
   * Bulk-install builtin templates (called at startup with templates from catalog)
   */
  installSystemTemplates(templates: StoredTemplate[]): void {
    for (const template of templates) {
      this.templates.set(template.manifest.name, template);
    }
  }

  /**
   * Get a template by name
   */
  getTemplate(name: string): StoredTemplate | undefined {
    return this.templates.get(name);
  }

  /**
   * List all installed templates
   */
  listTemplates(): StoredTemplate[] {
    const all = Array.from(this.templates.values());
    // Builtins first, then user-installed
    return all.sort((a, b) => {
      const aBuiltin = a.source.type === 'builtin' ? 0 : 1;
      const bBuiltin = b.source.type === 'builtin' ? 0 : 1;
      return aBuiltin - bBuiltin;
    });
  }

  /**
   * Remove a template by name
   */
  removeTemplate(name: string): boolean {
    const template = this.templates.get(name);
    if (template?.source.type === 'builtin') return false;
    return this.templates.delete(name);
  }

  /**
   * Check if a template is installed
   */
  hasTemplate(name: string): boolean {
    return this.templates.has(name);
  }

  /**
   * Export a template to a zip Blob
   */
  async exportToZip(templateName: string): Promise<Blob | null> {
    const template = this.templates.get(templateName);
    if (!template) {
      return null;
    }

    const zip = new JSZip();

    // Add manifest
    zip.file('manifest.yaml', YAML.stringify(template.manifest));

    // Add srcdoc if present
    if (template.srcdoc) {
      zip.file('srcdoc.html', template.srcdoc);
    }

    // Add files
    for (const file of template.files) {
      const content = file.encoding === 'base64' ? atob(file.content) : file.content;
      zip.file('files/' + file.path, content);
    }

    return zip.generateAsync({ type: 'blob' });
  }

  /**
   * Create a template from an existing agent
   */
  async createFromAgent(
    agent: AgentContainer,
    manifest: Partial<AgentTemplateManifest> & { name: string; version: string; description: string },
    options?: {
      includeDomState?: boolean;
      includeFiles?: boolean;
      includeConversation?: boolean;
      includeStorage?: boolean;
    }
  ): Promise<Blob> {
    const zip = new JSZip();

    // Full manifest with agent's current config
    const fullManifest: AgentTemplateManifest = {
      ...manifest,
      config: {
        systemPrompt: agent.config.systemPrompt,
        model: agent.config.model,
        maxTokens: agent.config.maxTokens,
        tokenBudget: agent.config.tokenBudget,
        costBudgetUsd: agent.config.costBudgetUsd,
        networkPolicy: agent.config.networkPolicy,
        tools: agent.config.tools?.map(t => t.name),
        ...manifest.config,
      },
    };

    zip.file('manifest.yaml', YAML.stringify(fullManifest));

    // Capture DOM state if requested
    if (options?.includeDomState !== false) {
      const domState = await agent.captureDomState();
      if (domState?.viewportHtml) {
        // Create srcdoc from captured DOM
        const srcdoc = this.createSrcdocFromDomState(domState.viewportHtml);
        zip.file('srcdoc.html', srcdoc);
      }
    }

    // Capture OPFS files if requested
    if (options?.includeFiles !== false) {
      const files = await this.collectAgentFiles(agent.id);
      for (const file of files) {
        zip.file('files/' + file.path, file.encoding === 'base64' ? atob(file.content) : file.content);
      }
    }

    // Capture conversation context if requested
    if (options?.includeConversation) {
      try {
        const provider = await getStorageProvider();
        const contextContent = await provider.readFile(agent.id, 'context.json');
        if (contextContent) {
          zip.file('files/context.json', contextContent);
        }
      } catch {
        // Conversation context may not exist, ignore errors
      }
    }

    // Capture storage snapshot if requested
    if (options?.includeStorage) {
      const snapshot = await this.captureStorageSnapshot(agent.id);
      if (snapshot) {
        zip.file('storage/snapshot.json', JSON.stringify(snapshot, null, 2));
        fullManifest.entryPoints = fullManifest.entryPoints || {};
        fullManifest.entryPoints.storage = 'storage/snapshot.json';
        // Re-write manifest with updated entryPoints
        zip.file('manifest.yaml', YAML.stringify(fullManifest));
      }
    }

    return zip.generateAsync({ type: 'blob' });
  }

  /**
   * Capture storage snapshot from an agent's IndexedDB
   */
  private async captureStorageSnapshot(agentId: string): Promise<StorageSnapshot | null> {
    try {
      const dbName = `flo-agent-${agentId}`;
      const db = await openDB(dbName);
      const keys = await idbKeys(db, 'store');

      const items: Array<{ key: string; value: unknown }> = [];
      for (const key of keys) {
        // Skip internal keys (those starting with underscore)
        if (key.startsWith('_')) continue;
        const value = await idbGet(db, 'store', key);
        items.push({ key, value });
      }

      db.close();

      if (items.length === 0) return null;

      return {
        keys: items,
        capturedAt: Date.now(),
      };
    } catch (err) {
      console.warn('[TemplateManager] Failed to capture storage snapshot:', err);
      return null;
    }
  }

  /**
   * Create srcdoc HTML from captured viewport HTML
   */
  private createSrcdocFromDomState(viewportHtml: string): string {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; }
  #agent-viewport { min-height: 100vh; position: relative; }
</style>
</head>
<body>
<div id="agent-viewport">
${viewportHtml}
</div>
<!-- FLO_BOOTSTRAP -->
</body>
</html>`;
  }

  /**
   * Collect files from agent's storage
   */
  private async collectAgentFiles(agentId: string): Promise<SerializedFile[]> {
    try {
      const provider = await getStorageProvider();
      return await provider.exportFiles(agentId);
    } catch {
      return [];
    }
  }

  /**
   * Export entries for persistence
   */
  exportEntries(): StoredTemplate[] {
    return Array.from(this.templates.values()).filter(
      t => t.source.type !== 'builtin'
    );
  }

  /**
   * Import entries from persistence
   */
  importEntries(templates: StoredTemplate[]): void {
    // Preserve builtins
    const builtins = Array.from(this.templates.values()).filter(
      t => t.source.type === 'builtin'
    );
    this.templates.clear();
    for (const builtin of builtins) {
      this.templates.set(builtin.manifest.name, builtin);
    }
    for (const template of templates) {
      this.templates.set(template.manifest.name, template);
    }
  }

  /**
   * Check if a file should be treated as binary based on extension
   */
  private isBinaryFile(filename: string): boolean {
    const binaryExtensions = [
      '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico',
      '.pdf', '.zip', '.tar', '.gz', '.7z', '.rar',
      '.exe', '.dll', '.so', '.dylib',
      '.wasm', '.bin',
    ];
    const lowerName = filename.toLowerCase();
    return binaryExtensions.some(ext => lowerName.endsWith(ext));
  }
}
