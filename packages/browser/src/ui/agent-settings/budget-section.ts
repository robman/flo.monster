import type { AgentConfig } from '@flo-monster/core';
import type { AgentContainer } from '../../agent/agent-container.js';
import type { AgentSettingsCallbacks } from './panel.js';
import { createFormField } from '../dom-helpers.js';

/**
 * Create the Budget section content for the agent settings panel.
 * Contains max tokens and cost budget inputs.
 */
export function createBudgetSection(
  agent: AgentContainer,
  callbacks: AgentSettingsCallbacks,
  onResetUsage?: (agentId: string) => void,
): HTMLElement {
  const el = document.createElement('div');
  el.className = 'settings-budget';

  // Token budget
  const { field: tokenField, input: tokenInput } = createFormField({
    label: 'Max tokens per turn',
    type: 'input',
    inputType: 'number',
    className: 'agent-settings__max-tokens',
    placeholder: '4096',
    value: String(agent.config.maxTokens || ''),
  });

  // Cost budget
  const { field: costField, input: costInput } = createFormField({
    label: 'Cost budget (USD)',
    type: 'input',
    inputType: 'number',
    className: 'agent-settings__cost-budget',
    placeholder: '1.00',
    step: '0.01',
    value: String(agent.config.costBudgetUsd || ''),
  });

  // Save handler for both inputs
  const saveBudget = () => {
    const changes: Partial<AgentConfig> = {};
    const maxTokens = tokenInput.value ? parseInt(tokenInput.value, 10) : undefined;
    const costBudgetUsd = costInput.value ? parseFloat(costInput.value) : undefined;
    if (maxTokens !== undefined) changes.maxTokens = maxTokens;
    if (costBudgetUsd !== undefined) changes.costBudgetUsd = costBudgetUsd;
    agent.updateConfig(changes);
    callbacks.onConfigChange?.(agent.id, changes);
  };

  tokenInput.addEventListener('change', saveBudget);
  costInput.addEventListener('change', saveBudget);

  el.appendChild(tokenField);
  el.appendChild(costField);

  // Reset usage button
  if (onResetUsage) {
    const resetBtn = document.createElement('button');
    resetBtn.className = 'btn btn--sm';
    resetBtn.textContent = 'Reset Usage';
    resetBtn.style.marginTop = 'var(--spacing-sm)';
    resetBtn.style.alignSelf = 'flex-start';
    resetBtn.addEventListener('click', () => {
      onResetUsage(agent.id);
      resetBtn.textContent = 'Usage Reset';
      setTimeout(() => { resetBtn.textContent = 'Reset Usage'; }, 2000);
    });
    el.appendChild(resetBtn);
  }

  return el;
}
