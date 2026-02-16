import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TemplateGallery } from './template-gallery.js';
import type { TemplateGalleryOptions } from './template-gallery.js';
import { TemplateManager } from '../shell/template-manager.js';
import type { StoredTemplate } from '@flo-monster/core';

function createMockTemplate(overrides: Partial<StoredTemplate> = {}): StoredTemplate {
  return {
    manifest: {
      name: 'Test Template',
      version: '1.0.0',
      description: 'A test template',
      config: {},
      ...overrides.manifest,
    },
    files: [],
    source: { type: 'local' },
    installedAt: Date.now(),
    ...overrides,
  };
}

describe('TemplateGallery', () => {
  let container: HTMLElement;
  let templateManager: TemplateManager;
  let options: TemplateGalleryOptions;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    templateManager = new TemplateManager();
    options = {
      onSelect: vi.fn(),
      onInstall: vi.fn(),
      onRemove: vi.fn(),
    };
  });

  afterEach(() => {
    container.remove();
  });

  it('renders empty state when no templates installed', () => {
    new TemplateGallery(container, templateManager, options);

    expect(container.querySelector('.template-gallery__empty')).not.toBeNull();
    expect(container.querySelector('.template-gallery__empty')?.textContent).toContain(
      'No templates installed'
    );
  });

  it('renders header with install buttons', () => {
    new TemplateGallery(container, templateManager, options);

    const header = container.querySelector('.template-gallery__header');
    expect(header).not.toBeNull();

    const buttons = container.querySelectorAll('.template-gallery__header .btn');
    expect(buttons.length).toBe(2);
    expect(buttons[0].textContent).toBe('Install from URL');
    expect(buttons[1].textContent).toBe('Upload .flo.zip');
  });

  it('renders template cards when templates are installed', () => {
    const template = createMockTemplate();
    templateManager.importEntries([template]);

    new TemplateGallery(container, templateManager, options);

    expect(container.querySelector('.template-gallery__empty')).toBeNull();

    const card = container.querySelector('.template-card');
    expect(card).not.toBeNull();
    expect(card?.querySelector('.template-card__name')?.textContent).toBe('Test Template');
    expect(card?.querySelector('.template-card__version')?.textContent).toBe('v1.0.0');
    expect(card?.querySelector('.template-card__description')?.textContent).toBe('A test template');
  });

  it('renders tags on template card', () => {
    const template = createMockTemplate({
      manifest: {
        name: 'Tagged Template',
        version: '1.0.0',
        description: 'Has tags',
        config: {},
        tags: ['coding', 'assistant'],
      },
    });
    templateManager.importEntries([template]);

    new TemplateGallery(container, templateManager, options);

    const tags = container.querySelectorAll('.template-card__tag');
    expect(tags.length).toBe(2);
    expect(tags[0].textContent).toBe('coding');
    expect(tags[1].textContent).toBe('assistant');
  });

  it('calls onSelect when Use Template button is clicked', () => {
    const template = createMockTemplate();
    templateManager.importEntries([template]);

    new TemplateGallery(container, templateManager, options);

    const selectBtn = container.querySelector('.template-card .btn--primary') as HTMLButtonElement;
    expect(selectBtn.textContent).toBe('Use Template');

    selectBtn.click();

    expect(options.onSelect).toHaveBeenCalledWith(template);
  });

  it('removes template and calls onRemove when Remove button is clicked', () => {
    const template = createMockTemplate();
    templateManager.importEntries([template]);

    new TemplateGallery(container, templateManager, options);

    // Mock confirm
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    const removeBtn = container.querySelector('.template-card__remove') as HTMLButtonElement;
    removeBtn.click();

    expect(confirmSpy).toHaveBeenCalledWith('Remove template "Test Template"?');
    expect(templateManager.hasTemplate('Test Template')).toBe(false);
    expect(options.onRemove).toHaveBeenCalledWith('Test Template');

    confirmSpy.mockRestore();
  });

  it('does not remove template if confirm is cancelled', () => {
    const template = createMockTemplate();
    templateManager.importEntries([template]);

    new TemplateGallery(container, templateManager, options);

    // Mock confirm to return false
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    const removeBtn = container.querySelector('.template-card__remove') as HTMLButtonElement;
    removeBtn.click();

    expect(templateManager.hasTemplate('Test Template')).toBe(true);
    expect(options.onRemove).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
  });

  it('shows install URL dialog when Install from URL button is clicked', () => {
    new TemplateGallery(container, templateManager, options);

    const installBtn = container.querySelector(
      '.template-gallery__actions .btn'
    ) as HTMLButtonElement;
    installBtn.click();

    const dialog = container.querySelector('.template-gallery__dialog');
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector('h3')?.textContent).toBe('Install Template from URL');
  });

  it('calls onInstall with URL from dialog', async () => {
    new TemplateGallery(container, templateManager, options);

    // Open dialog
    const installBtn = container.querySelector(
      '.template-gallery__actions .btn'
    ) as HTMLButtonElement;
    installBtn.click();

    // Fill URL
    const urlInput = container.querySelector('.form-field__input') as HTMLInputElement;
    urlInput.value = 'https://example.com/template.flo.zip';

    // Click Install
    const dialogInstallBtn = container.querySelector(
      '.template-gallery__dialog-actions .btn--primary'
    ) as HTMLButtonElement;
    dialogInstallBtn.click();

    expect(options.onInstall).toHaveBeenCalledWith('https://example.com/template.flo.zip');
  });

  it('shows error for empty URL in dialog', () => {
    new TemplateGallery(container, templateManager, options);

    // Open dialog
    const installBtn = container.querySelector(
      '.template-gallery__actions .btn'
    ) as HTMLButtonElement;
    installBtn.click();

    // Click Install without entering URL
    const dialogInstallBtn = container.querySelector(
      '.template-gallery__dialog-actions .btn--primary'
    ) as HTMLButtonElement;
    dialogInstallBtn.click();

    const error = container.querySelector('.template-gallery__dialog-error') as HTMLElement;
    expect(error.style.display).toBe('block');
    expect(error.textContent).toBe('Please enter a URL');
    expect(options.onInstall).not.toHaveBeenCalled();
  });

  it('shows error for invalid URL in dialog', () => {
    new TemplateGallery(container, templateManager, options);

    // Open dialog
    const installBtn = container.querySelector(
      '.template-gallery__actions .btn'
    ) as HTMLButtonElement;
    installBtn.click();

    // Enter invalid URL
    const urlInput = container.querySelector('.form-field__input') as HTMLInputElement;
    urlInput.value = 'not-a-valid-url';

    // Click Install
    const dialogInstallBtn = container.querySelector(
      '.template-gallery__dialog-actions .btn--primary'
    ) as HTMLButtonElement;
    dialogInstallBtn.click();

    const error = container.querySelector('.template-gallery__dialog-error') as HTMLElement;
    expect(error.style.display).toBe('block');
    expect(error.textContent).toBe('Invalid URL format');
    expect(options.onInstall).not.toHaveBeenCalled();
  });

  it('closes dialog when Cancel is clicked', () => {
    new TemplateGallery(container, templateManager, options);

    // Open dialog
    const installBtn = container.querySelector(
      '.template-gallery__actions .btn'
    ) as HTMLButtonElement;
    installBtn.click();

    expect(container.querySelector('.template-gallery__dialog')).not.toBeNull();

    // Click Cancel
    const cancelBtn = container.querySelector(
      '.template-gallery__dialog-actions .btn:not(.btn--primary)'
    ) as HTMLButtonElement;
    cancelBtn.click();

    expect(container.querySelector('.template-gallery__dialog')).toBeNull();
  });

  it('closes dialog when clicking overlay background', () => {
    new TemplateGallery(container, templateManager, options);

    // Open dialog
    const installBtn = container.querySelector(
      '.template-gallery__actions .btn'
    ) as HTMLButtonElement;
    installBtn.click();

    const overlay = container.querySelector('.template-gallery__dialog-overlay') as HTMLElement;
    expect(overlay).not.toBeNull();

    // Click the overlay (not the dialog itself)
    overlay.click();

    expect(container.querySelector('.template-gallery__dialog')).toBeNull();
  });

  it('re-renders after successful template removal', () => {
    const template = createMockTemplate();
    templateManager.importEntries([template]);

    new TemplateGallery(container, templateManager, options);

    // Verify template is shown
    expect(container.querySelector('.template-card')).not.toBeNull();

    // Mock confirm
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    // Remove template
    const removeBtn = container.querySelector('.template-card__remove') as HTMLButtonElement;
    removeBtn.click();

    // Should now show empty state
    expect(container.querySelector('.template-card')).toBeNull();
    expect(container.querySelector('.template-gallery__empty')).not.toBeNull();

    confirmSpy.mockRestore();
  });

  it('render method can be called to update display', () => {
    const gallery = new TemplateGallery(container, templateManager, options);

    // Initially empty
    expect(container.querySelector('.template-gallery__empty')).not.toBeNull();

    // Add a template directly to manager
    templateManager.importEntries([createMockTemplate()]);

    // Re-render
    gallery.render();

    // Should now show the template
    expect(container.querySelector('.template-gallery__empty')).toBeNull();
    expect(container.querySelector('.template-card')).not.toBeNull();
  });

  it('shows Built-in badge on builtin template card', () => {
    const template = createMockTemplate({
      source: { type: 'builtin' },
    });
    templateManager.importEntries([template]);

    new TemplateGallery(container, templateManager, options);

    const badge = container.querySelector('.template-card__badge--builtin');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('Built-in');
  });

  it('hides Remove button for builtin templates', () => {
    const template = createMockTemplate({
      source: { type: 'builtin' },
    });
    templateManager.importEntries([template]);

    new TemplateGallery(container, templateManager, options);

    const removeBtn = container.querySelector('.template-card__remove');
    expect(removeBtn).toBeNull();
  });

  it('shows Remove button for non-builtin templates', () => {
    const template = createMockTemplate({
      source: { type: 'local' },
    });
    templateManager.importEntries([template]);

    new TemplateGallery(container, templateManager, options);

    const removeBtn = container.querySelector('.template-card__remove');
    expect(removeBtn).not.toBeNull();
  });
});
