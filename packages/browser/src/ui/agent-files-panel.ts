import type { AgentContainer } from '../agent/agent-container.js';
import { getStorageProvider, type AgentStorageProvider, type StorageEntry } from '../storage/agent-storage.js';

export class AgentFilesPanel {
  private container: HTMLElement;
  private panelEl: HTMLElement | null = null;
  private backdropEl: HTMLElement | null = null;
  private _isVisible = false;
  private agent: AgentContainer | null = null;
  private currentAgentId: string | null = null;
  private provider: AgentStorageProvider | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  show(agent: AgentContainer): void {
    if (this._isVisible) return;
    this._isVisible = true;
    this.agent = agent;
    this.currentAgentId = agent.id;

    // Create backdrop
    this.backdropEl = document.createElement('div');
    this.backdropEl.className = 'settings-backdrop';
    this.backdropEl.addEventListener('click', () => this.hide());

    // Create panel
    this.panelEl = document.createElement('div');
    this.panelEl.className = 'settings-panel';

    const header = document.createElement('div');
    header.className = 'settings-panel__header';

    const title = document.createElement('h2');
    title.className = 'settings-panel__title';
    title.textContent = agent.config.name + ' Files';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'icon-btn settings-panel__close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => this.hide());

    header.appendChild(title);
    header.appendChild(closeBtn);

    const content = document.createElement('div');
    content.className = 'settings-panel__content';

    this.panelEl.appendChild(header);
    this.panelEl.appendChild(content);

    this.container.appendChild(this.backdropEl);
    this.container.appendChild(this.panelEl);

    // Trigger animation
    requestAnimationFrame(() => {
      this.panelEl?.classList.add('settings-panel--open');
      this.backdropEl?.classList.add('settings-backdrop--visible');
    });

    // Load files asynchronously
    this.loadFiles(agent.id, content);
  }

  hide(): void {
    if (!this._isVisible) return;
    this._isVisible = false;

    this.panelEl?.classList.remove('settings-panel--open');
    this.backdropEl?.classList.remove('settings-backdrop--visible');

    const cleanup = () => {
      this.panelEl?.remove();
      this.backdropEl?.remove();
      this.panelEl = null;
      this.backdropEl = null;
    };

    if (this.panelEl) {
      this.panelEl.addEventListener('transitionend', cleanup, { once: true });
      setTimeout(cleanup, 400);
    } else {
      cleanup();
    }
  }

  toggle(agent: AgentContainer): void {
    if (this._isVisible) {
      this.hide();
    } else {
      this.show(agent);
    }
  }

  isVisible(): boolean {
    return this._isVisible;
  }

  private async loadFiles(agentId: string, contentEl?: HTMLElement): Promise<void> {
    const content = contentEl || this.panelEl?.querySelector('.settings-panel__content') as HTMLElement;
    if (!content) return;

    // Show loading
    content.textContent = '';
    const loadingEl = document.createElement('div');
    loadingEl.className = 'files-loading';
    loadingEl.textContent = 'Loading...';
    content.appendChild(loadingEl);

    try {
      // Get the storage provider
      if (!this.provider) {
        this.provider = await getStorageProvider();
      }

      // Check if agent directory exists
      const agentDirExists = await this.provider.isDirectory(agentId, '');
      if (!agentDirExists) {
        content.textContent = '';
        const emptyEl = document.createElement('div');
        emptyEl.className = 'files-empty';
        emptyEl.textContent = '(No files)';
        content.appendChild(emptyEl);
        return;
      }

      // Walk the directory tree recursively
      const entries: StorageEntry[] = [];
      await this.walkDirectoryRecursive(agentId, '', entries);

      content.textContent = '';

      if (entries.length === 0) {
        const emptyEl = document.createElement('div');
        emptyEl.className = 'files-empty';
        emptyEl.textContent = '(No files)';
        content.appendChild(emptyEl);
        return;
      }

      const fileList = document.createElement('div');
      fileList.className = 'file-list';

      for (const entry of entries) {
        const row = document.createElement('div');
        row.className = 'file-entry' + (entry.isDirectory ? ' file-entry--dir' : '');

        const pathEl = document.createElement('span');
        pathEl.className = 'file-entry__path';
        pathEl.textContent = entry.path;
        row.appendChild(pathEl);

        if (!entry.isDirectory) {
          const actionsEl = document.createElement('div');
          actionsEl.className = 'file-entry__actions';

          // Download button
          const downloadBtn = document.createElement('button');
          downloadBtn.className = 'file-entry__btn';
          downloadBtn.title = 'Download';
          downloadBtn.textContent = '\u2B73';
          downloadBtn.addEventListener('click', () => this.downloadFile(agentId, entry));
          actionsEl.appendChild(downloadBtn);

          // View button
          const viewBtn = document.createElement('button');
          viewBtn.className = 'file-entry__btn';
          viewBtn.title = 'View';
          viewBtn.textContent = '\uD83D\uDC41';
          viewBtn.addEventListener('click', () => this.viewFile(agentId, entry));
          actionsEl.appendChild(viewBtn);

          // Delete button (skip for protected files)
          if (entry.name !== 'context.json' && entry.name !== 'context.terse.json') {
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'file-entry__btn file-entry__btn--danger';
            deleteBtn.title = 'Delete';
            deleteBtn.textContent = '\u2715';
            deleteBtn.addEventListener('click', () => this.deleteFile(agentId, entry.path));
            actionsEl.appendChild(deleteBtn);
          }

          row.appendChild(actionsEl);
        }

        fileList.appendChild(row);
      }

      content.appendChild(fileList);
    } catch {
      content.textContent = '';
      const emptyEl = document.createElement('div');
      emptyEl.className = 'files-empty';
      emptyEl.textContent = '(No files)';
      content.appendChild(emptyEl);
    }
  }

  /**
   * Recursively walk the directory tree and collect all entries.
   */
  private async walkDirectoryRecursive(
    agentId: string,
    dirPath: string,
    entries: StorageEntry[]
  ): Promise<void> {
    if (!this.provider) return;

    const children = await this.provider.listDir(agentId, dirPath);

    for (const child of children) {
      // Build the full path for display
      const displayPath = child.isDirectory ? child.path + '/' : child.path;
      entries.push({
        ...child,
        path: displayPath,
      });

      // Recurse into directories
      if (child.isDirectory) {
        await this.walkDirectoryRecursive(agentId, child.path, entries);
      }
    }
  }

  private async downloadFile(agentId: string, entry: StorageEntry): Promise<void> {
    if (!this.provider) {
      this.provider = await getStorageProvider();
    }

    // Remove trailing slash if present (for display paths)
    const filePath = entry.path.replace(/\/$/, '');
    const data = await this.provider.readFileBinary(agentId, filePath);
    const blob = new Blob([data]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = entry.name;
    a.click();
    URL.revokeObjectURL(url);
  }

  private async viewFile(agentId: string, entry: StorageEntry): Promise<void> {
    if (!this.provider) {
      this.provider = await getStorageProvider();
    }

    // Remove trailing slash if present (for display paths)
    const filePath = entry.path.replace(/\/$/, '');
    const data = await this.provider.readFileBinary(agentId, filePath);
    const blob = new Blob([data]);
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  private async deleteFile(agentId: string, filePath: string): Promise<void> {
    if (!this.provider) {
      this.provider = await getStorageProvider();
    }

    // Remove trailing slash if present (for display paths)
    const cleanPath = filePath.replace(/\/$/, '');

    // Check if it's a directory or file
    const isDir = await this.provider.isDirectory(agentId, cleanPath);
    if (isDir) {
      await this.provider.deleteDir(agentId, cleanPath);
    } else {
      await this.provider.deleteFile(agentId, cleanPath);
    }

    await this.loadFiles(agentId);
  }
}
