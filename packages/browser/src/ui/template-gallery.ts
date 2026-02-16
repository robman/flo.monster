/**
 * Template gallery UI - displays installed templates in a grid
 */

import type { StoredTemplate } from '@flo-monster/core';
import type { TemplateManager } from '../shell/template-manager.js';

export interface TemplateGalleryOptions {
  onSelect?: (template: StoredTemplate) => void;
  onInstall?: (url: string) => void;
  onRemove?: (name: string) => void;
}

export class TemplateGallery {
  private container: HTMLElement;
  private templateManager: TemplateManager;
  private options: TemplateGalleryOptions;

  constructor(
    container: HTMLElement,
    templateManager: TemplateManager,
    options: TemplateGalleryOptions = {}
  ) {
    this.container = container;
    this.templateManager = templateManager;
    this.options = options;
    this.render();
  }

  render(): void {
    const templates = this.templateManager.listTemplates();

    this.container.innerHTML = '';
    this.container.className = 'template-gallery';

    // Header with install buttons
    const header = document.createElement('div');
    header.className = 'template-gallery__header';

    const actions = document.createElement('div');
    actions.className = 'template-gallery__actions';

    const installUrlBtn = document.createElement('button');
    installUrlBtn.className = 'btn';
    installUrlBtn.textContent = 'Install from URL';
    installUrlBtn.addEventListener('click', () => this.showInstallUrlDialog());
    actions.appendChild(installUrlBtn);

    const uploadBtn = document.createElement('button');
    uploadBtn.className = 'btn';
    uploadBtn.textContent = 'Upload .flo.zip';
    uploadBtn.addEventListener('click', () => this.showUploadDialog());
    actions.appendChild(uploadBtn);

    header.appendChild(actions);
    this.container.appendChild(header);

    // Template grid
    const grid = document.createElement('div');
    grid.className = 'template-gallery__grid';

    if (templates.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'template-gallery__empty';
      empty.textContent = 'No templates installed. Install one from a URL or upload a .flo.zip file.';
      grid.appendChild(empty);
    } else {
      for (const template of templates) {
        grid.appendChild(this.renderTemplateCard(template));
      }
    }

    this.container.appendChild(grid);
  }

  private renderTemplateCard(template: StoredTemplate): HTMLElement {
    const card = document.createElement('div');
    card.className = 'template-card';

    const name = document.createElement('h4');
    name.className = 'template-card__name';
    name.textContent = template.manifest.name;
    card.appendChild(name);

    // Built-in badge
    if (template.source.type === 'builtin') {
      const badge = document.createElement('span');
      badge.className = 'template-card__badge template-card__badge--builtin';
      badge.textContent = 'Built-in';
      card.appendChild(badge);
    }

    const version = document.createElement('span');
    version.className = 'template-card__version';
    version.textContent = `v${template.manifest.version}`;
    card.appendChild(version);

    const description = document.createElement('p');
    description.className = 'template-card__description';
    description.textContent = template.manifest.description;
    card.appendChild(description);

    // Tags
    if (template.manifest.tags?.length) {
      const tags = document.createElement('div');
      tags.className = 'template-card__tags';
      for (const tag of template.manifest.tags) {
        const tagEl = document.createElement('span');
        tagEl.className = 'template-card__tag';
        tagEl.textContent = tag;
        tags.appendChild(tagEl);
      }
      card.appendChild(tags);
    }

    // Actions
    const actions = document.createElement('div');
    actions.className = 'template-card__actions';

    const selectBtn = document.createElement('button');
    selectBtn.className = 'btn btn--primary';
    selectBtn.textContent = 'Use Template';
    selectBtn.addEventListener('click', () => {
      this.options.onSelect?.(template);
    });
    actions.appendChild(selectBtn);

    if (template.source.type !== 'builtin') {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn template-card__remove';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => {
        if (window.confirm(`Remove template "${template.manifest.name}"?`)) {
          this.templateManager.removeTemplate(template.manifest.name);
          this.options.onRemove?.(template.manifest.name);
          this.render();
        }
      });
      actions.appendChild(removeBtn);
    }

    card.appendChild(actions);
    return card;
  }

  private showInstallUrlDialog(): void {
    const overlay = document.createElement('div');
    overlay.className = 'template-gallery__dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'template-gallery__dialog';

    // Title
    const title = document.createElement('h3');
    title.textContent = 'Install Template from URL';
    dialog.appendChild(title);

    // URL input
    const urlField = document.createElement('div');
    urlField.className = 'form-field';

    const urlLabel = document.createElement('label');
    urlLabel.className = 'form-field__label';
    urlLabel.textContent = 'Template URL';

    const urlInput = document.createElement('input');
    urlInput.type = 'url';
    urlInput.className = 'form-field__input';
    urlInput.placeholder = 'https://example.com/template.flo.zip';

    const urlHelp = document.createElement('div');
    urlHelp.className = 'template-gallery__help';
    urlHelp.textContent = 'Enter the URL to a .flo.zip template file';

    urlField.appendChild(urlLabel);
    urlField.appendChild(urlInput);
    urlField.appendChild(urlHelp);
    dialog.appendChild(urlField);

    // Error display
    const errorEl = document.createElement('div');
    errorEl.className = 'template-gallery__dialog-error';
    errorEl.style.display = 'none';
    dialog.appendChild(errorEl);

    // Loading indicator
    const loadingEl = document.createElement('div');
    loadingEl.className = 'template-gallery__dialog-loading';
    loadingEl.textContent = 'Installing...';
    loadingEl.style.display = 'none';
    dialog.appendChild(loadingEl);

    // Actions
    const actionsEl = document.createElement('div');
    actionsEl.className = 'template-gallery__dialog-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Cancel';

    const installBtn = document.createElement('button');
    installBtn.className = 'btn btn--primary';
    installBtn.textContent = 'Install';

    actionsEl.appendChild(cancelBtn);
    actionsEl.appendChild(installBtn);
    dialog.appendChild(actionsEl);

    overlay.appendChild(dialog);
    this.container.appendChild(overlay);

    const closeDialog = () => {
      overlay.remove();
    };

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeDialog();
    });

    cancelBtn.addEventListener('click', closeDialog);

    installBtn.addEventListener('click', async () => {
      const url = urlInput.value.trim();
      if (!url) {
        errorEl.textContent = 'Please enter a URL';
        errorEl.style.display = 'block';
        return;
      }

      // Validate URL
      try {
        new URL(url);
      } catch {
        errorEl.textContent = 'Invalid URL format';
        errorEl.style.display = 'block';
        return;
      }

      errorEl.style.display = 'none';
      loadingEl.style.display = 'block';
      installBtn.disabled = true;
      cancelBtn.disabled = true;

      try {
        this.options.onInstall?.(url);
        closeDialog();
      } catch (err) {
        loadingEl.style.display = 'none';
        installBtn.disabled = false;
        cancelBtn.disabled = false;
        errorEl.textContent = err instanceof Error ? err.message : 'Failed to install template';
        errorEl.style.display = 'block';
      }
    });

    // Focus input
    urlInput.focus();
  }

  private showUploadDialog(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,.flo.zip';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (file) {
        try {
          await this.templateManager.installFromFile(file);
          this.render();
        } catch (err) {
          window.alert(`Failed to install template: ${err}`);
        }
      }
    });
    input.click();
  }
}
