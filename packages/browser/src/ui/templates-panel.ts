/**
 * Templates panel - slide-in panel for managing agent templates
 */

import type { TemplateManager } from '../shell/template-manager.js';
import type { StoredTemplate } from '@flo-monster/core';

export interface TemplatesPanelOptions {
  templateManager: TemplateManager;
  onCreateAgent?: (template: StoredTemplate) => void;
  onDownload?: (templateName: string) => void;
  onDelete?: (templateName: string) => void;
  onUpload?: () => void;
}

export class TemplatesPanel {
  private container: HTMLElement;
  private templateManager: TemplateManager;
  private onCreateAgent?: (template: StoredTemplate) => void;
  private onDownload?: (templateName: string) => void;
  private onDelete?: (templateName: string) => void;
  private onUpload?: () => void;
  private panelEl: HTMLElement | null = null;
  private backdropEl: HTMLElement | null = null;
  private _isVisible = false;

  constructor(container: HTMLElement, options: TemplatesPanelOptions) {
    this.container = container;
    this.templateManager = options.templateManager;
    this.onCreateAgent = options.onCreateAgent;
    this.onDownload = options.onDownload;
    this.onDelete = options.onDelete;
    this.onUpload = options.onUpload;
  }

  show(): void {
    if (this._isVisible) return;
    this._isVisible = true;

    // Create backdrop
    this.backdropEl = document.createElement('div');
    this.backdropEl.className = 'settings-backdrop';
    this.backdropEl.addEventListener('click', () => this.hide());

    // Create panel
    this.panelEl = document.createElement('div');
    this.panelEl.className = 'settings-panel';

    this.render();

    this.container.appendChild(this.backdropEl);
    this.container.appendChild(this.panelEl);

    // Trigger animation
    requestAnimationFrame(() => {
      this.panelEl?.classList.add('settings-panel--open');
      this.backdropEl?.classList.add('settings-backdrop--visible');
    });
  }

  hide(): void {
    if (!this._isVisible) return;
    this._isVisible = false;

    // Capture element references BEFORE scheduling cleanup
    const panelToRemove = this.panelEl;
    const backdropToRemove = this.backdropEl;

    panelToRemove?.classList.remove('settings-panel--open');
    backdropToRemove?.classList.remove('settings-backdrop--visible');

    // Clear instance references immediately so show() can create fresh elements
    this.panelEl = null;
    this.backdropEl = null;

    // Remove after animation using captured references
    const cleanup = () => {
      panelToRemove?.remove();
      backdropToRemove?.remove();
    };

    // Wait for transition
    if (panelToRemove) {
      panelToRemove.addEventListener('transitionend', cleanup, { once: true });
      // Fallback timeout in case transition doesn't fire
      setTimeout(cleanup, 400);
    } else {
      cleanup();
    }
  }

  toggle(): void {
    if (this._isVisible) {
      this.hide();
    } else {
      this.show();
    }
  }

  render(): void {
    if (!this.panelEl) return;

    this.panelEl.innerHTML = '';

    // Header
    const header = document.createElement('div');
    header.className = 'settings-panel__header';

    const title = document.createElement('h2');
    title.className = 'settings-panel__title';
    title.textContent = 'Templates';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'icon-btn settings-panel__close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '\u00d7'; // &times;
    closeBtn.addEventListener('click', () => this.hide());

    header.appendChild(title);
    header.appendChild(closeBtn);
    this.panelEl.appendChild(header);

    // Content
    const content = document.createElement('div');
    content.className = 'settings-panel__content';

    // Upload button
    const uploadSection = document.createElement('div');
    uploadSection.className = 'templates-panel__upload';

    const uploadBtn = document.createElement('button');
    uploadBtn.className = 'btn btn--primary';
    uploadBtn.textContent = 'Upload .flo.zip';
    uploadBtn.addEventListener('click', () => this.handleUpload());

    uploadSection.appendChild(uploadBtn);
    content.appendChild(uploadSection);

    // Template list
    const templates = this.templateManager.listTemplates();

    if (templates.length === 0) {
      const emptyState = document.createElement('p');
      emptyState.className = 'templates-panel__empty';
      emptyState.textContent = 'No templates installed. Upload a .flo.zip file to get started.';
      content.appendChild(emptyState);
    } else {
      const templateList = document.createElement('div');
      templateList.className = 'templates-panel__list';

      for (const template of templates) {
        templateList.appendChild(this.renderTemplateCard(template));
      }

      content.appendChild(templateList);
    }

    this.panelEl.appendChild(content);
  }

  private renderTemplateCard(template: StoredTemplate): HTMLElement {
    const card = document.createElement('div');
    card.className = 'template-card';

    // Header with name and version
    const cardHeader = document.createElement('div');
    cardHeader.className = 'template-card__header';

    const name = document.createElement('h4');
    name.className = 'template-card__name';
    name.textContent = template.manifest.name;

    const version = document.createElement('span');
    version.className = 'template-card__version';
    version.textContent = `v${template.manifest.version}`;

    cardHeader.appendChild(name);
    cardHeader.appendChild(version);

    // Built-in badge
    if (template.source.type === 'builtin') {
      const badge = document.createElement('span');
      badge.className = 'template-card__badge template-card__badge--builtin';
      badge.textContent = 'Built-in';
      cardHeader.appendChild(badge);
    }

    card.appendChild(cardHeader);

    // Description
    const description = document.createElement('p');
    description.className = 'template-card__description';
    description.textContent = template.manifest.description;
    card.appendChild(description);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'template-card__actions';

    const createBtn = document.createElement('button');
    createBtn.className = 'btn btn--primary';
    createBtn.textContent = 'Create Agent';
    createBtn.addEventListener('click', () => {
      this.onCreateAgent?.(template);
    });
    actions.appendChild(createBtn);

    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'btn';
    downloadBtn.textContent = 'Download';
    downloadBtn.addEventListener('click', () => {
      this.onDownload?.(template.manifest.name);
    });
    actions.appendChild(downloadBtn);

    if (template.source.type !== 'builtin') {
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn template-card__delete';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', () => {
        if (window.confirm(`Delete template "${template.manifest.name}"?`)) {
          this.templateManager.removeTemplate(template.manifest.name);
          this.onDelete?.(template.manifest.name);
          this.render();
        }
      });
      actions.appendChild(deleteBtn);
    }

    card.appendChild(actions);
    return card;
  }

  private handleUpload(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,.flo.zip';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (file) {
        try {
          await this.templateManager.installFromFile(file);
          this.onUpload?.();
          this.render();
        } catch (err) {
          window.alert(`Failed to install template: ${err}`);
        }
      }
    });
    input.click();
  }
}
