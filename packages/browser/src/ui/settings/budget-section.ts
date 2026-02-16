/**
 * Budget settings section
 */

import type { PersistenceLayer, AppSettings } from '../../shell/persistence.js';
import { createFormField } from '../dom-helpers.js';

export function createBudgetSection(
  settings: AppSettings,
  persistence: PersistenceLayer,
): HTMLElement {
  const el = document.createElement('div');
  el.className = 'settings-budget';

  // Token budget
  const { field: tokenField, input: tokenInput } = createFormField({
    label: 'Max tokens per turn',
    type: 'input',
    inputType: 'number',
    className: 'settings-budget__tokens',
    placeholder: '4096',
    value: String(settings.defaultBudget?.maxTokens || ''),
  });

  // Cost budget
  const { field: costField, input: costInput } = createFormField({
    label: 'Max cost (USD)',
    type: 'input',
    inputType: 'number',
    className: 'settings-budget__cost',
    placeholder: '1.00',
    step: '0.01',
    value: String(settings.defaultBudget?.maxCostUsd || ''),
  });

  // Save handler for both inputs
  const saveBudget = async () => {
    const current = await persistence.getSettings();
    const maxTokens = tokenInput.value ? parseInt(tokenInput.value, 10) : undefined;
    const maxCostUsd = costInput.value ? parseFloat(costInput.value) : undefined;
    current.defaultBudget = (maxTokens || maxCostUsd) ? { maxTokens, maxCostUsd } : undefined;
    await persistence.saveSettings(current);
  };

  tokenInput.addEventListener('change', saveBudget);
  costInput.addEventListener('change', saveBudget);

  el.appendChild(tokenField);
  el.appendChild(costField);
  return el;
}
