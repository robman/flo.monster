import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTemplatesSection } from '../templates-section.js';
import { TemplateManager } from '../../../shell/template-manager.js';
import type { PersistenceLayer, AppSettings } from '../../../shell/persistence.js';
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

describe('createTemplatesSection', () => {
  let templateManager: TemplateManager;
  let mockPersistence: PersistenceLayer;
  let mockSettings: AppSettings;
  let onRerender: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    templateManager = new TemplateManager();
    mockSettings = {
      defaultModel: 'claude-sonnet-4-20250514',
      enabledExtensions: [],
    };
    mockPersistence = {
      getSettings: vi.fn().mockResolvedValue(mockSettings),
      saveSettings: vi.fn().mockResolvedValue(undefined),
    } as unknown as PersistenceLayer;
    onRerender = vi.fn();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders section with description', () => {
    const el = createTemplatesSection(mockSettings, mockPersistence, templateManager, onRerender);

    expect(el.className).toBe('settings-templates');
    expect(el.querySelector('.settings-templates__description')).not.toBeNull();
    expect(el.querySelector('.settings-templates__description')?.textContent).toContain(
      'Install and manage agent templates'
    );
  });

  it('includes template gallery', () => {
    const el = createTemplatesSection(mockSettings, mockPersistence, templateManager, onRerender);

    expect(el.querySelector('.template-gallery')).not.toBeNull();
  });

  it('shows empty state when no templates installed', () => {
    const el = createTemplatesSection(mockSettings, mockPersistence, templateManager, onRerender);

    expect(el.querySelector('.template-gallery__empty')).not.toBeNull();
  });

  it('shows templates when installed', () => {
    templateManager.importEntries([createMockTemplate()]);

    const el = createTemplatesSection(mockSettings, mockPersistence, templateManager, onRerender);

    expect(el.querySelector('.template-gallery__empty')).toBeNull();
    expect(el.querySelector('.template-card')).not.toBeNull();
  });

  it('saves to persistence after installing from URL', async () => {
    const el = createTemplatesSection(mockSettings, mockPersistence, templateManager, onRerender);
    document.body.appendChild(el);

    // Click Install from URL
    const installBtn = el.querySelector(
      '.template-gallery__actions .btn'
    ) as HTMLButtonElement;
    installBtn.click();

    // Mock installFromUrl
    const installSpy = vi.spyOn(templateManager, 'installFromUrl').mockResolvedValue(
      createMockTemplate()
    );

    // Fill URL and install
    const urlInput = el.querySelector('.form-field__input') as HTMLInputElement;
    urlInput.value = 'https://example.com/template.flo.zip';

    const dialogInstallBtn = el.querySelector(
      '.template-gallery__dialog-actions .btn--primary'
    ) as HTMLButtonElement;
    dialogInstallBtn.click();

    // Wait for async
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(installSpy).toHaveBeenCalledWith('https://example.com/template.flo.zip');

    installSpy.mockRestore();
  });

  it('saves to persistence after removing template', async () => {
    templateManager.importEntries([createMockTemplate()]);

    const el = createTemplatesSection(mockSettings, mockPersistence, templateManager, onRerender);
    document.body.appendChild(el);

    // Mock confirm
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    const removeBtn = el.querySelector('.template-card__remove') as HTMLButtonElement;
    removeBtn.click();

    // Wait for async
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(mockPersistence.saveSettings).toHaveBeenCalled();
    expect(onRerender).toHaveBeenCalled();

    confirmSpy.mockRestore();
  });

  it('shows alert on install error', async () => {
    const el = createTemplatesSection(mockSettings, mockPersistence, templateManager, onRerender);
    document.body.appendChild(el);

    // Click Install from URL
    const installBtn = el.querySelector(
      '.template-gallery__actions .btn'
    ) as HTMLButtonElement;
    installBtn.click();

    // Mock installFromUrl to fail
    vi.spyOn(templateManager, 'installFromUrl').mockRejectedValue(new Error('Network error'));

    // Mock alert
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    // Fill URL and install
    const urlInput = el.querySelector('.form-field__input') as HTMLInputElement;
    urlInput.value = 'https://example.com/bad.flo.zip';

    const dialogInstallBtn = el.querySelector(
      '.template-gallery__dialog-actions .btn--primary'
    ) as HTMLButtonElement;
    dialogInstallBtn.click();

    // Wait for async
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(alertSpy).toHaveBeenCalledWith('Failed to install template: Error: Network error');

    alertSpy.mockRestore();
  });
});
