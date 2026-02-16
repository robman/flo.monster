/**
 * Tests for shared DOM creation helpers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createFormField,
  populateSelect,
  createCheckboxLabel,
  createEmptyState,
  createLoadingIndicator,
} from '../dom-helpers.js';

describe('createFormField', () => {
  it('creates a text input field with label', () => {
    const { field, label, input } = createFormField({
      label: 'Name',
      type: 'input',
    });

    expect(field.tagName).toBe('DIV');
    expect(field.className).toBe('form-field');
    expect(label.tagName).toBe('LABEL');
    expect(label.className).toBe('form-field__label');
    expect(label.textContent).toBe('Name');
    expect(input.tagName).toBe('INPUT');
    expect(input.className).toBe('form-field__input');
    expect((input as HTMLInputElement).type).toBe('text');
  });

  it('creates a number input field', () => {
    const { input } = createFormField({
      label: 'Max tokens',
      type: 'input',
      inputType: 'number',
      placeholder: '4096',
      value: '8192',
      step: '1',
    });

    const inp = input as HTMLInputElement;
    expect(inp.type).toBe('number');
    expect(inp.placeholder).toBe('4096');
    expect(inp.value).toBe('8192');
    expect(inp.step).toBe('1');
  });

  it('creates a select field', () => {
    const { field, label, input } = createFormField({
      label: 'Provider',
      type: 'select',
      className: 'custom-select',
    });

    expect(field.className).toBe('form-field');
    expect(label.textContent).toBe('Provider');
    expect(input.tagName).toBe('SELECT');
    expect(input.className).toBe('form-field__select custom-select');
  });

  it('creates a textarea field', () => {
    const { input } = createFormField({
      label: 'System Prompt',
      type: 'textarea',
      rows: 8,
      placeholder: 'Enter prompt...',
      value: 'You are a helpful assistant.',
    });

    const ta = input as HTMLTextAreaElement;
    expect(ta.tagName).toBe('TEXTAREA');
    expect(ta.className).toBe('form-field__textarea');
    expect(ta.rows).toBe(8);
    expect(ta.placeholder).toBe('Enter prompt...');
    expect(ta.value).toBe('You are a helpful assistant.');
  });

  it('applies custom className to input', () => {
    const { input } = createFormField({
      label: 'Test',
      type: 'input',
      className: 'settings-budget__tokens',
    });

    expect(input.className).toBe('form-field__input settings-budget__tokens');
  });

  it('applies wrapperClassName to the field div', () => {
    const { field } = createFormField({
      label: 'Test',
      type: 'input',
      wrapperClassName: 'extra-wrapper-class',
    });

    expect(field.className).toBe('form-field extra-wrapper-class');
  });

  it('adds a hint element when hint is provided', () => {
    const { field } = createFormField({
      label: 'Test',
      type: 'input',
      hint: 'This is a helpful hint',
    });

    const hint = field.querySelector('.form-field__hint');
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toBe('This is a helpful hint');
  });

  it('does not add a hint element when hint is not provided', () => {
    const { field } = createFormField({
      label: 'Test',
      type: 'input',
    });

    const hint = field.querySelector('.form-field__hint');
    expect(hint).toBeNull();
  });

  it('contains label as first child and input as second', () => {
    const { field, label, input } = createFormField({
      label: 'Test',
      type: 'input',
    });

    expect(field.children[0]).toBe(label);
    expect(field.children[1]).toBe(input);
  });

  it('creates a url input field', () => {
    const { input } = createFormField({
      label: 'Hub URL',
      type: 'input',
      inputType: 'url',
      placeholder: 'ws://127.0.0.1:8765',
    });

    const inp = input as HTMLInputElement;
    expect(inp.type).toBe('url');
    expect(inp.placeholder).toBe('ws://127.0.0.1:8765');
  });

  it('creates a password input field', () => {
    const { input } = createFormField({
      label: 'Auth Token',
      type: 'input',
      inputType: 'password',
      placeholder: 'Enter token',
    });

    const inp = input as HTMLInputElement;
    expect(inp.type).toBe('password');
  });

  it('applies custom className to textarea', () => {
    const { input } = createFormField({
      label: 'Prompt',
      type: 'textarea',
      className: 'agent-settings__prompt',
    });

    expect(input.className).toBe('form-field__textarea agent-settings__prompt');
  });
});

describe('populateSelect', () => {
  let select: HTMLSelectElement;

  beforeEach(() => {
    select = document.createElement('select');
  });

  it('populates a select with options', () => {
    populateSelect(select, [
      { value: 'a', label: 'Option A' },
      { value: 'b', label: 'Option B' },
      { value: 'c', label: 'Option C' },
    ]);

    expect(select.options.length).toBe(3);
    expect(select.options[0].value).toBe('a');
    expect(select.options[0].textContent).toBe('Option A');
    expect(select.options[1].value).toBe('b');
    expect(select.options[1].textContent).toBe('Option B');
    expect(select.options[2].value).toBe('c');
    expect(select.options[2].textContent).toBe('Option C');
  });

  it('selects the option matching selectedValue', () => {
    populateSelect(
      select,
      [
        { value: 'x', label: 'X' },
        { value: 'y', label: 'Y' },
        { value: 'z', label: 'Z' },
      ],
      'y',
    );

    expect(select.options[1].selected).toBe(true);
  });

  it('does not explicitly select any option when selectedValue does not match', () => {
    populateSelect(
      select,
      [
        { value: 'x', label: 'X' },
        { value: 'y', label: 'Y' },
      ],
      'not-found',
    );

    // The browser auto-selects the first option by default; verify none
    // were explicitly set via the selected attribute
    expect(select.options[0].getAttribute('selected')).toBeNull();
    expect(select.options[1].getAttribute('selected')).toBeNull();
  });

  it('clears existing options before populating', () => {
    const existingOption = document.createElement('option');
    existingOption.value = 'old';
    existingOption.textContent = 'Old Option';
    select.appendChild(existingOption);

    populateSelect(select, [{ value: 'new', label: 'New Option' }]);

    expect(select.options.length).toBe(1);
    expect(select.options[0].value).toBe('new');
  });

  it('handles empty items array', () => {
    populateSelect(select, []);
    expect(select.options.length).toBe(0);
  });

  it('works without selectedValue parameter', () => {
    populateSelect(select, [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ]);

    expect(select.options.length).toBe(2);
    // No option should be explicitly marked as selected via attribute
    expect(select.options[0].getAttribute('selected')).toBeNull();
    expect(select.options[1].getAttribute('selected')).toBeNull();
  });
});

describe('createCheckboxLabel', () => {
  it('creates a labeled checkbox', () => {
    const { wrapper, checkbox } = createCheckboxLabel('Enable feature', false);

    expect(wrapper.tagName).toBe('LABEL');
    expect(wrapper.className).toBe('tool-checkbox');
    expect(checkbox.tagName).toBe('INPUT');
    expect(checkbox.type).toBe('checkbox');
    expect(checkbox.checked).toBe(false);

    const span = wrapper.querySelector('span');
    expect(span?.textContent).toBe('Enable feature');
  });

  it('sets checked state', () => {
    const { checkbox } = createCheckboxLabel('Test', true);
    expect(checkbox.checked).toBe(true);
  });

  it('calls onChange callback when checkbox changes', () => {
    const onChange = vi.fn();
    const { checkbox } = createCheckboxLabel('Test', false, onChange);

    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('calls onChange with false when unchecked', () => {
    const onChange = vi.fn();
    const { checkbox } = createCheckboxLabel('Test', true, onChange);

    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));

    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('adds a badge when provided', () => {
    const { wrapper } = createCheckboxLabel('Tool Name', true, undefined, 'hub');

    const badge = wrapper.querySelector('.tool-checkbox__badge');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('hub');
  });

  it('does not add a badge when not provided', () => {
    const { wrapper } = createCheckboxLabel('Tool Name', true);

    const badge = wrapper.querySelector('.tool-checkbox__badge');
    expect(badge).toBeNull();
  });

  it('does not throw when onChange is not provided', () => {
    const { checkbox } = createCheckboxLabel('Test', false);

    expect(() => {
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('change'));
    }).not.toThrow();
  });
});

describe('createEmptyState', () => {
  it('creates a paragraph with message', () => {
    const el = createEmptyState('No items found');

    expect(el.tagName).toBe('P');
    expect(el.textContent).toBe('No items found');
    expect(el.className).toBe('empty-state');
  });

  it('uses custom className when provided', () => {
    const el = createEmptyState('No hubs connected', 'settings-hubs__empty');

    expect(el.className).toBe('settings-hubs__empty');
    expect(el.textContent).toBe('No hubs connected');
  });

  it('uses default className when not provided', () => {
    const el = createEmptyState('Empty');
    expect(el.className).toBe('empty-state');
  });
});

describe('createLoadingIndicator', () => {
  it('creates a div with default message', () => {
    const el = createLoadingIndicator();

    expect(el.tagName).toBe('DIV');
    expect(el.textContent).toBe('Loading...');
    expect(el.className).toBe('loading-indicator');
  });

  it('uses custom message', () => {
    const el = createLoadingIndicator('Installing...');
    expect(el.textContent).toBe('Installing...');
  });

  it('uses custom className', () => {
    const el = createLoadingIndicator('Connecting...', 'settings-skills__dialog-loading');
    expect(el.className).toBe('settings-skills__dialog-loading');
    expect(el.textContent).toBe('Connecting...');
  });
});
