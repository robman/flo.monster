import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TemplateDialog } from './template-dialog.js';
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

describe('TemplateDialog', () => {
  let dialog: TemplateDialog;

  beforeEach(() => {
    dialog = new TemplateDialog();
  });

  afterEach(() => {
    dialog.hide();
  });

  it('creates dialog with form elements', async () => {
    const template = createMockTemplate();
    const showPromise = dialog.show(template);

    // Check form elements exist
    expect(document.querySelector('.template-dialog')).toBeTruthy();
    expect(document.querySelector('#template-agent-name')).toBeTruthy();
    expect(document.querySelector('#template-model')).toBeTruthy();

    // Cancel to cleanup
    (document.querySelector('#template-dialog-cancel') as HTMLButtonElement).click();
    const result = await showPromise;
    expect(result).toBeNull();
  });

  it('shows template info in dialog', async () => {
    const template = createMockTemplate({
      manifest: {
        name: 'My App',
        version: '2.0.0',
        description: 'A great template',
        config: {},
      },
    });
    const showPromise = dialog.show(template);

    expect(document.querySelector('.template-dialog__template-name')?.textContent).toBe('My App');
    expect(document.querySelector('.template-dialog__template-desc')?.textContent).toBe(
      'A great template'
    );
    expect(document.querySelector('.template-dialog__template-version')?.textContent).toBe('v2.0.0');

    // Cancel to cleanup
    (document.querySelector('#template-dialog-cancel') as HTMLButtonElement).click();
    await showPromise;
  });

  it('pre-fills agent name with template name', async () => {
    const template = createMockTemplate({
      manifest: {
        name: 'Cool Agent',
        version: '1.0.0',
        description: 'Test',
        config: {},
      },
    });
    const showPromise = dialog.show(template);

    const nameInput = document.querySelector('#template-agent-name') as HTMLInputElement;
    expect(nameInput.value).toBe('Cool Agent');

    // Cancel to cleanup
    (document.querySelector('#template-dialog-cancel') as HTMLButtonElement).click();
    await showPromise;
  });

  it('hide removes dialog from DOM', () => {
    dialog.show(createMockTemplate());
    expect(document.querySelector('.template-dialog')).toBeTruthy();

    dialog.hide();
    expect(document.querySelector('.template-dialog')).toBeNull();
  });

  it('returns result on form submit', async () => {
    const template = createMockTemplate({ manifest: { name: 'My Template', version: '1.0.0', description: 'Test', config: {} } });
    const showPromise = dialog.show(template);

    // Fill form
    const nameInput = document.querySelector('#template-agent-name') as HTMLInputElement;
    nameInput.value = 'My Custom Agent';

    // Submit form
    const form = document.querySelector('.template-dialog__form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    const result = await showPromise;
    expect(result).not.toBeNull();
    expect(result!.templateName).toBe('My Template');
    expect(result!.agentName).toBe('My Custom Agent');
    expect(result!.overrides).toEqual({});
  });

  it('uses template name if agent name is empty', async () => {
    const template = createMockTemplate({ manifest: { name: 'Default Name', version: '1.0.0', description: 'Test', config: {} } });
    const showPromise = dialog.show(template);

    // Clear the name input
    const nameInput = document.querySelector('#template-agent-name') as HTMLInputElement;
    nameInput.value = '';

    // Submit form
    const form = document.querySelector('.template-dialog__form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    const result = await showPromise;
    expect(result!.agentName).toBe('Default Name');
  });

  it('includes model override when selected', async () => {
    const template = createMockTemplate();
    const showPromise = dialog.show(template);

    // Select a model
    const modelSelect = document.querySelector('#template-model') as HTMLSelectElement;
    modelSelect.value = 'claude-sonnet-4-20250514';

    // Submit form
    const form = document.querySelector('.template-dialog__form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    const result = await showPromise;
    expect(result!.overrides.model).toBe('claude-sonnet-4-20250514');
  });

  it('does not include model override when "Use template default" is selected', async () => {
    const template = createMockTemplate();
    const showPromise = dialog.show(template);

    // Keep default (empty value)
    const modelSelect = document.querySelector('#template-model') as HTMLSelectElement;
    expect(modelSelect.value).toBe('');

    // Submit form
    const form = document.querySelector('.template-dialog__form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    const result = await showPromise;
    expect(result!.overrides.model).toBeUndefined();
    expect(result!.overrides).toEqual({});
  });

  it('returns null on cancel', async () => {
    const template = createMockTemplate();
    const showPromise = dialog.show(template);

    const cancelBtn = document.querySelector('#template-dialog-cancel') as HTMLButtonElement;
    cancelBtn.click();

    const result = await showPromise;
    expect(result).toBeNull();
  });

  it('has model select with options', async () => {
    const template = createMockTemplate();
    const showPromise = dialog.show(template);

    const modelSelect = document.querySelector('#template-model') as HTMLSelectElement;
    expect(modelSelect.options.length).toBeGreaterThan(1);

    // First option should be "Use template default"
    expect(modelSelect.options[0].value).toBe('');
    expect(modelSelect.options[0].textContent).toBe('Use template default');

    // Cancel to cleanup
    (document.querySelector('#template-dialog-cancel') as HTMLButtonElement).click();
    await showPromise;
  });
});
